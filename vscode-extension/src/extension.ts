import * as path from "path";
import * as vscode from "vscode";
import {
  type ArchComponent,
  collectFilePaths,
  markMissingFiles,
  parseCodeBoardingAnalysis,
} from "../../core/architecture/codeboarding-adapter";
import { allAdded, diffIR, type IRDiffResult } from "../../core/diff/ir-diff";
import type { FlowchartIR } from "../../core/flowchart-ir/schema";
import { emitMagicCircle } from "../../core/render/magic-circle-emitter";
import { emitMermaid } from "../../core/render/mermaid-emitter";
import {
  extractFlowchartIR,
  FlowchartUserError,
  getCallableSymbols,
  isFlowSupportedLanguage,
  isFlowSupportedPath,
  normalizeFunctionName,
} from "./flowExtractor";
import { checkBraceBalance, irFromFunctionText, plainFunctionName, sliceFunctionByName } from "./functionSlicer";
import { getHeadText } from "./gitDiff";
import {
  getCurrentPanel,
  getOrCreateFlowchartPanel,
  getRecentPosted,
  onDidCreatePanel,
  onWebviewMessage,
  postToPanel,
  requestFromWebview,
  simulateWebviewMessage,
} from "./webviewPanel";

const DEBOUNCE_MS = 500;
const FOLLOW_CURSOR_DEBOUNCE_MS = 400;

/** 直近に表示した図の元(ジャンプ・再試行・保存時の自動更新に使う)。 */
let lastSource: { uri: vscode.Uri } | undefined;
/** 同じ関数・同じ版のまま再描画しないための目印(カーソル追従用)。 */
let lastKey = "";
/** 「再試行」で同じ操作をもう一度行う(フロー生成・差分・analysis.json の読み込みのどれでも)。 */
let lastRun: (() => Promise<void>) | undefined;
/**
 * 保存時の自動更新で再実行するのは「フロー生成」だけ。差分(クイックピックが出ることがある)や
 * analysis.json の読み込み(ファイル選択が出ることがある)を、保存のたびに再実行しないため lastRun と分ける。
 */
let lastGenerate: (() => Promise<void>) | undefined;
let lastMermaidText: string | undefined;
/** analysis.json の基準フォルダ(`.codeboarding` の親 = リポジトリルート)。 */
let architectureRoot: vscode.Uri | undefined;

let pendingAnalysis: vscode.CancellationTokenSource | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let followTimer: ReturnType<typeof setTimeout> | undefined;

/** 結合テスト(test/)が使う、Webview からの通知の購読口。通常の利用では使わない。 */
export interface FlowchartTestApi {
  onRendered: vscode.Event<{ view: string; mode: string; functionName: string | null; nodeCount: number }>;
  onArchitectureShown: vscode.Event<{ components: number }>;
  getRecentPosted: typeof getRecentPosted;
  simulateWebviewMessage: typeof simulateWebviewMessage;
}

export function activate(context: vscode.ExtensionContext): FlowchartTestApi {
  const renderedEmitter = new vscode.EventEmitter<{ view: string; mode: string; functionName: string | null; nodeCount: number }>();
  const architectureEmitter = new vscode.EventEmitter<{ components: number }>();
  context.subscriptions.push(renderedEmitter, architectureEmitter);

  // ---- WebView → ホストのメッセージ ----
  onWebviewMessage("ready", () => postConfig()); // パネルの読み込みが済んだら設定を送り直す
  onWebviewMessage("rendered", (m) => renderedEmitter.fire(m));
  onWebviewMessage("architectureShown", (m) => architectureEmitter.fire(m));
  onWebviewMessage("jump", (m) => jumpToLine(m.line));
  onWebviewMessage("copyText", async (m) => {
    if (typeof m.text !== "string") return;
    await vscode.env.clipboard.writeText(m.text);
    vscode.window.setStatusBarMessage("Mermaidテキストをクリップボードにコピーしました", 3000);
  });
  onWebviewMessage("saveImage", (m) => saveImage(m.format, m.data));
  onWebviewMessage("requestAction", async (m) => {
    if (m.action === "retry") await lastRun?.();
    else if (m.action === "generate") await generateAtCursor(context);
    else if (m.action === "loadArchitecture") await loadArchitecture(context);
  });
  onWebviewMessage("openFunction", (m) => openFunction(context, m.path, m.line));

  context.subscriptions.push(
    onDidCreatePanel(() => postConfig()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("flowchart.followCursor")) postConfig();
    }),

    vscode.commands.registerCommand("flowchart.generateFromFile", async () => {
      await generateAtCursor(context);
    }),

    vscode.commands.registerCommand("flowchart.generateFromSelection", async () => {
      const editor = getTargetEditor();
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage("フローチャートを生成する範囲を選択してください");
        return;
      }
      await generateAt(context, editor.document, editor.selection);
    }),

    vscode.commands.registerCommand("flowchart.exportSvg", async () => {
      const reply = await requestFromWebview({ type: "exportSvg" }, "exportSvgResult");
      if (!reply?.svg) {
        vscode.window.showWarningMessage("先にフローチャートを生成してください");
        return;
      }
      await saveImage("svg", reply.svg);
    }),

    vscode.commands.registerCommand("flowchart.exportPng", async () => {
      const reply = await requestFromWebview({ type: "exportPng" }, "exportPngResult");
      if (!reply?.dataUrl) {
        vscode.window.showWarningMessage("先にフローチャートを生成してください");
        return;
      }
      await saveImage("png", reply.dataUrl);
    }),

    vscode.commands.registerCommand("flowchart.copyMermaid", async () => {
      // いま表示しているビュー(フロー / 呼び出し / 状態、差分)の Mermaid を優先。パネルが無ければ直近のフロー
      const reply = await requestFromWebview({ type: "getMermaid" }, "mermaidResult", 3000);
      const text: string | undefined = reply?.text ?? lastMermaidText;
      if (!text) {
        vscode.window.showWarningMessage("先にフローチャートを生成してください");
        return;
      }
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage("Mermaidテキストをクリップボードにコピーしました");
    }),

    vscode.commands.registerCommand("flowchart.generateMagicCircle", async () => {
      await generateMagicCircleAndSave(context);
    }),

    vscode.commands.registerCommand("flowchart.diffAgainstHead", async () => {
      await diffAgainstHead(context);
    }),

    vscode.commands.registerCommand("flowchart.loadArchitecture", async () => {
      await loadArchitecture(context);
    }),

    // ---- 保存時の自動更新(Phase5)。パネルが開いているときだけ、表示中のファイルを更新する ----
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!vscode.workspace.getConfiguration().get<boolean>("flowchart.autoRefresh")) return;
      if (!getCurrentPanel() || !lastSource || doc.uri.toString() !== lastSource.uri.toString()) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void lastGenerate?.();
      }, DEBOUNCE_MS);
    }),

    // ---- カーソル追従(既定はオフ)。カーソルのある関数が変わったら図を差し替える ----
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!isFollowCursorEnabled() || !getCurrentPanel()) return;
      const doc = e.textEditor.document;
      if (!isFlowSupportedLanguage(doc.languageId) || (doc.uri.scheme !== "file" && doc.uri.scheme !== "untitled")) return;
      if (followTimer) clearTimeout(followTimer);
      followTimer = setTimeout(() => {
        void followCursor(context, e.textEditor);
      }, FOLLOW_CURSOR_DEBOUNCE_MS);
    }),
  );

  return {
    onRendered: renderedEmitter.event,
    onArchitectureShown: architectureEmitter.event,
    getRecentPosted,
    simulateWebviewMessage,
  };
}

export function deactivate(): void {
  pendingAnalysis?.cancel();
  if (debounceTimer) clearTimeout(debounceTimer);
  if (followTimer) clearTimeout(followTimer);
}

// ----------------------------------------------------------------------------- 設定

function isFollowCursorEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>("flowchart.followCursor") === true;
}

function postConfig(): void {
  postToPanel({ type: "config", followCursor: isFollowCursorEnabled() });
}

// ----------------------------------------------------------------------------- 生成

/**
 * 操作の対象にするエディタ。Webview(図)にフォーカスがあるとき activeTextEditor は undefined になるため、
 * 直近に図の元にしたファイルのエディタ → 見えているファイルのエディタの順に探す。
 */
function getTargetEditor(): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor;
  if (active) return active;
  if (lastSource) {
    const same = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === lastSource!.uri.toString());
    if (same) return same;
  }
  return vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "file" || e.document.uri.scheme === "untitled");
}

/** カーソル位置の関数(カーソルが関数の外ならファイルの先頭の関数)から図を作る。 */
async function generateAtCursor(context: vscode.ExtensionContext): Promise<void> {
  const editor = getTargetEditor();
  if (!editor) {
    reportError(context, new FlowchartUserError("アクティブなエディタがありません。コードを開いてからお試しください。"));
    return;
  }
  await generateAt(context, editor.document, editor.selection);
}

async function generateAt(
  context: vscode.ExtensionContext,
  doc: vscode.TextDocument,
  selection: vscode.Selection | undefined,
): Promise<void> {
  pendingAnalysis?.cancel();
  const source = new vscode.CancellationTokenSource();
  pendingAnalysis = source;
  lastGenerate = async () => {
    const fresh = await vscode.workspace.openTextDocument(doc.uri);
    await generateAt(context, fresh, selection);
  };
  lastRun = lastGenerate;

  try {
    const ir = await extractFlowchartIR(context.extensionUri, doc, selection, source.token);
    if (source.token.isCancellationRequested) return;
    publishIR(context, ir, doc);
  } catch (err) {
    reportError(context, err);
  }
}

/** 図を Webview に渡す。ビュー切替・ジャンプ・差分は IR(図の元データ)をそのまま渡して Webview 側が行う。 */
function publishIR(
  context: vscode.ExtensionContext,
  ir: FlowchartIR,
  doc: vscode.TextDocument,
  extra: { mode?: "flow" | "diff"; banner?: string } = {},
): void {
  lastSource = { uri: doc.uri };
  lastMermaidText = emitMermaid(ir);
  lastKey = keyOf(ir, doc);
  getOrCreateFlowchartPanel(context);
  const start = ir.nodes.find((n) => n.kind === "start");
  // ファイル全体を対象にした場合の開始ノードはファイル名なので、関数名としては出さない
  const functionName = start && start.label !== ir.sourceFile ? start.label : undefined;
  postToPanel({
    type: "render",
    ir,
    meta: { file: ir.sourceFile, functionName, canJump: true, mode: extra.mode ?? "flow", banner: extra.banner },
  });
}

function keyOf(ir: FlowchartIR, doc: vscode.TextDocument): string {
  const start = ir.nodes.find((n) => n.kind === "start");
  return `${doc.uri.toString()}|${start?.label}|${start?.sourceRange.startLine}|${doc.version}`;
}

/** 失敗は図の上の帯で知らせる(図は消さない)。想定内のエラーはメッセージをそのまま、想定外は前置きを付ける。 */
function reportError(context: vscode.ExtensionContext, err: unknown): void {
  if (err instanceof vscode.CancellationError) return;
  const message =
    err instanceof FlowchartUserError ? err.message : `フローチャート生成に失敗しました: ${(err as Error)?.message ?? String(err)}`;
  if (!(err instanceof FlowchartUserError)) console.error("[flowchart]", err);
  getOrCreateFlowchartPanel(context);
  postToPanel({ type: "error", message, retry: true });
}

async function followCursor(context: vscode.ExtensionContext, editor: vscode.TextEditor): Promise<void> {
  const doc = editor.document;
  const source = new vscode.CancellationTokenSource();
  pendingAnalysis?.cancel();
  pendingAnalysis = source;
  try {
    const ir = await extractFlowchartIR(context.extensionUri, doc, editor.selection, source.token);
    if (source.token.isCancellationRequested) return;
    if (keyOf(ir, doc) === lastKey) return; // 同じ関数・同じ版なら何もしない(ジャンプ直後の再描画も防ぐ)
    lastGenerate = async () => {
      const fresh = await vscode.workspace.openTextDocument(doc.uri);
      await generateAt(context, fresh, editor.selection);
    };
    lastRun = lastGenerate;
    publishIR(context, ir, doc);
  } catch (err) {
    if (err instanceof FlowchartUserError || err instanceof vscode.CancellationError) {
      // 入力途中の構文エラーなどは、前の図を残したまま帯で知らせるだけにする
      if (err instanceof FlowchartUserError) postToPanel({ type: "error", message: err.message, retry: false });
      return;
    }
    console.error("[flowchart] カーソル追従に失敗しました", err);
  }
}

// ----------------------------------------------------------------------------- Webview からの操作

async function jumpToLine(line: unknown): Promise<void> {
  if (typeof line !== "number" || !lastSource) return;
  const pos = new vscode.Position(Math.max(0, line - 1), 0);
  const range = new vscode.Range(pos, pos);
  const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === lastSource!.uri.toString());
  const options = {
    viewColumn: visible?.viewColumn ?? vscode.ViewColumn.One,
    selection: range,
    preserveFocus: false,
  };
  if (visible) await vscode.window.showTextDocument(visible.document, options);
  else await vscode.window.showTextDocument(lastSource.uri, options);
  const editor = vscode.window.activeTextEditor;
  editor?.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function saveImage(format: unknown, data: unknown): Promise<void> {
  if ((format !== "svg" && format !== "png") || typeof data !== "string") return;
  const uri = await vscode.window.showSaveDialog({
    filters: format === "svg" ? { SVG: ["svg"] } : { PNG: ["png"] },
    saveLabel: format === "svg" ? "SVGで保存" : "PNGで保存",
  });
  if (!uri) return;
  const bytes = format === "svg" ? Buffer.from(data, "utf-8") : Buffer.from(data.replace(/^data:image\/png;base64,/, ""), "base64");
  await vscode.workspace.fs.writeFile(uri, bytes);
  vscode.window.showInformationMessage(`${format.toUpperCase()}を書き出しました: ${uri.fsPath}`);
}

// ----------------------------------------------------------------------------- X3: HEAD との差分

interface ChangedFunction {
  label: string;
  line: number;
  result: IRDiffResult;
}

async function diffAgainstHead(context: vscode.ExtensionContext): Promise<void> {
  const editor = getTargetEditor();
  if (!editor) {
    reportError(context, new FlowchartUserError("アクティブなエディタがありません。"));
    return;
  }
  const doc = editor.document;
  lastRun = () => diffAgainstHead(context);

  try {
    if (!isFlowSupportedLanguage(doc.languageId)) {
      throw new FlowchartUserError(`この言語(${doc.languageId})は未対応です。`);
    }
    const head = await getHeadText(doc);
    if (head.kind === "error") throw new FlowchartUserError(head.message);

    const symbols = await getCallableSymbols(doc);
    if (symbols.length === 0) {
      throw new FlowchartUserError("関数の一覧を取得できないため、差分を出せません(言語サーバーが応答していない可能性があります)。");
    }

    const file = path.basename(doc.fileName);
    const changed: ChangedFunction[] = [];
    const skipped: string[] = [];
    const seen = new Map<string, number>();
    for (const s of symbols) {
      const label = normalizeFunctionName(s.name);
      const plain = plainFunctionName(label);
      const nth = seen.get(plain) ?? 0; // 同名の定義(オーバーロード)は出現順で対応づける
      seen.set(plain, nth + 1);

      const curText = doc.getText(s.range).replace(/\r\n/g, "\n");
      if (!checkBraceBalance(curText).ok) {
        skipped.push(label);
        continue;
      }
      const current = irFromFunctionText(curText, s.range.start.line, label, file);

      let result: IRDiffResult;
      if (head.kind === "untracked") {
        result = allAdded(current);
      } else {
        const old = sliceFunctionByName(head.text, plain, nth);
        result = old
          ? diffIR(irFromFunctionText(old.text, old.startLine, label, file), current)
          : allAdded(current); // 変更前に存在しない = 新規の関数
      }
      if (result.hasChanges) changed.push({ label, line: s.range.start.line + 1, result });
    }

    if (changed.length === 0) {
      const note = skipped.length ? `(構文エラーの可能性で比較できなかった関数: ${skipped.join(", ")})` : "";
      vscode.window.showInformationMessage(`変更された関数はありません。HEAD と同じフローです。${note}`);
      return;
    }

    let picked: ChangedFunction | undefined = changed[0];
    if (changed.length > 1) {
      const items = changed.map((c) => ({
        label: c.label,
        description: describeSummary(c.result),
        detail: `${file}:${c.line}`,
        value: c,
      }));
      const choice = await vscode.window.showQuickPick(items, {
        title: `HEAD から変更された関数(${changed.length}件)`,
        placeHolder: "フロー差分を見る関数を選んでください",
      });
      picked = choice?.value;
    }
    if (!picked) return;

    const note = skipped.length ? ` 比較できなかった関数: ${skipped.join(", ")}。` : "";
    publishIR(context, picked.result.ir, doc, {
      mode: "diff",
      banner:
        `HEAD との差分 ${picked.label}: ${describeSummary(picked.result)}。` +
        `緑=追加、赤の破線=削除、黄の太枠=変更。${note}`,
    });
  } catch (err) {
    reportError(context, err);
  }
}

function describeSummary(r: IRDiffResult): string {
  const s = r.summary;
  return `ノード 追加${s.nodesAdded}・削除${s.nodesRemoved}・変更${s.nodesChanged} / 線 追加${s.edgesAdded}・削除${s.edgesRemoved}`;
}

// ----------------------------------------------------------------------------- X2: CodeBoarding analysis.json

async function pickAnalysisJson(): Promise<vscode.Uri | undefined> {
  const found = await vscode.workspace.findFiles("**/.codeboarding/analysis.json", "**/node_modules/**", 10);
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    const choice = await vscode.window.showQuickPick(
      found.map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u })),
      { title: "読み込む analysis.json を選んでください" },
    );
    return choice?.uri;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "CodeBoarding analysis": ["json"] },
    openLabel: "analysis.json を読み込む",
    title: "CodeBoarding の analysis.json(通常は .codeboarding/analysis.json)",
  });
  return picked?.[0];
}

/** analysis.json を読み、パンくずの「全体」から掘り下げられるようにする(全体 → ファイル → 関数)。 */
async function loadArchitecture(context: vscode.ExtensionContext): Promise<void> {
  const uri = await pickAnalysisJson();
  if (!uri) return;
  lastRun = () => loadArchitecture(context);

  try {
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf-8"));
    } catch (err) {
      throw new FlowchartUserError(`analysis.json を読み込めません: ${(err as Error).message}`);
    }
    let model;
    try {
      model = parseCodeBoardingAnalysis(json);
    } catch (err) {
      throw new FlowchartUserError((err as Error).message);
    }

    // analysis.json のパスは、`.codeboarding` の親(リポジトリルート)からの相対
    const root = vscode.Uri.joinPath(uri, "..", "..");
    architectureRoot = root;
    const paths = collectFilePaths(model);
    const exists = new Set<string>();
    const CHUNK = 64;
    for (let i = 0; i < paths.length; i += CHUNK) {
      await Promise.all(
        paths.slice(i, i + CHUNK).map(async (p) => {
          try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, ...p.split("/")));
            exists.add(p);
          } catch {
            // 存在しないファイルを指す項目でもエラーにしない(missing として表示する)
          }
        }),
      );
    }
    const missing = markMissingFiles(model, (p) => exists.has(p));
    const mark = (c: ArchComponent) => {
      for (const f of c.files) {
        if (!f.missing && !isFlowSupportedPath(f.path)) f.unsupportedReason = "言語未対応";
      }
      c.children.forEach(mark);
    };
    model.components.forEach(mark);
    if (missing > 0) model.warnings.push(`${missing} 件のファイルが見つかりません(解析後に移動・削除された可能性があります)`);

    getOrCreateFlowchartPanel(context);
    postToPanel({ type: "architecture", model });
  } catch (err) {
    reportError(context, err);
  }
}

async function openFunction(context: vscode.ExtensionContext, relPath: unknown, line: unknown): Promise<void> {
  if (typeof relPath !== "string" || typeof line !== "number" || !architectureRoot) return;
  try {
    const uri = vscode.Uri.joinPath(architectureRoot, ...relPath.split("/"));
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      selection: new vscode.Range(pos, pos),
      preserveFocus: false,
    });
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    await generateAt(context, doc, new vscode.Selection(pos, pos));
  } catch (err) {
    reportError(context, new FlowchartUserError(`ファイルを開けませんでした: ${relPath}`));
  }
}

// ----------------------------------------------------------------------------- 魔方陣(エンタメ)

/**
 * アクティブエディタ(選択範囲があればそれ、なければカーソル位置の関数)からFlowchartIRを抽出し、
 * core/render/magic-circle-emitter.ts で魔方陣レシピ(JSON)に変換して保存する。
 * エンタメ用途(core/render/MAGIC_CIRCLE_MAPPING_SPEC.md参照)。保存したJSONは
 * MagicCircleGeneratorアプリの「インポート」ボタンからそのまま読み込める。
 */
async function generateMagicCircleAndSave(context: vscode.ExtensionContext): Promise<void> {
  const editor = getTargetEditor();
  if (!editor) {
    vscode.window.showWarningMessage("アクティブなエディタがありません");
    return;
  }

  const selection = editor.selection;

  pendingAnalysis?.cancel();
  const source = new vscode.CancellationTokenSource();
  pendingAnalysis = source;

  try {
    const ir = await extractFlowchartIR(context.extensionUri, editor.document, selection, source.token);
    if (source.token.isCancellationRequested) return;

    const composition = emitMagicCircle(ir);

    const uri = await vscode.window.showSaveDialog({
      filters: { JSON: ["json"] },
      saveLabel: "魔方陣レシピを保存",
      defaultUri: vscode.Uri.file(`${composition.compositionId}.json`),
    });
    if (!uri) return;

    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(composition, null, 2), "utf-8"));
    vscode.window.showInformationMessage(
      `魔方陣レシピを書き出しました: ${uri.fsPath}(MagicCircleGeneratorの「インポート」から読み込めます)`,
    );
  } catch (err) {
    if (err instanceof vscode.CancellationError) return;
    vscode.window.showErrorMessage(`魔方陣の生成に失敗しました: ${(err as Error).message}`);
  }
}
