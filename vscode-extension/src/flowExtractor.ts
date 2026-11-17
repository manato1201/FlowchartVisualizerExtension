import * as path from "path";
import * as vscode from "vscode";
import { FlowchartIR } from "../../core/flowchart-ir/schema";
import { checkBraceBalance, irFromFunctionText } from "./functionSlicer";
import {
  extractWithTreeSitter,
  isLanguageSupportedByTreeSitter,
  TreeSitterSyntaxError,
} from "./treeSitterExtractor";

/**
 * 想定内の失敗(言語未対応・構文エラーの可能性など)。メッセージはそのまま利用者に見せてよい。
 * Webview では「図の上の帯」に出る(図は消さない)。
 */
export class FlowchartUserError extends Error {}

/**
 * 制御構文を波括弧で書く言語。ヒューリスティックスキャナ(波括弧と if/for/while/switch を読む)が
 * 前提とする構文。検証済みなのは C# のみで、それ以外は同じ構文規則に沿う範囲での対応。
 * Ruby のようにインデントでブロックを表す言語は含めない(以前は黙って中身のない図を出していた)。
 * Python は波括弧のスキャナを通さず、tree-sitter だけで読む(下の TREE_SITTER_ONLY_LANGUAGE_IDS)。
 */
const FLOW_LANGUAGE_IDS = new Set([
  "csharp",
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "java",
  "kotlin",
  "c",
  "cpp",
  "go",
  "rust",
  "swift",
  "php",
  "dart",
  "scala",
  "objective-c",
  "objective-cpp",
]);

/**
 * 構造を tree-sitter だけで読む言語(インデントでブロックを表す)。
 * 言語サーバーのシンボルや波括弧のスキャナは使わない(Python のコードを波括弧で読むと、中身のない図になる)。
 * 図の生成とカーソル追従は対応するが、HEAD との差分(関数ごとにテキストを切り出す仕組み)は未対応。
 */
const TREE_SITTER_ONLY_LANGUAGE_IDS = new Set(["python"]);

const FLOW_FILE_EXTENSIONS = new Set([
  "cs",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "java",
  "kt",
  "kts",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "go",
  "rs",
  "swift",
  "php",
  "dart",
  "scala",
  "m",
  "mm",
  "py",
  "pyi",
]);

export function isFlowSupportedLanguage(languageId: string): boolean {
  return FLOW_LANGUAGE_IDS.has(languageId) || TREE_SITTER_ONLY_LANGUAGE_IDS.has(languageId);
}

/** HEAD との差分に対応する言語(波括弧で関数を切り出せる言語)。 */
export function isHeadDiffSupportedLanguage(languageId: string): boolean {
  return FLOW_LANGUAGE_IDS.has(languageId);
}

export function isFlowSupportedPath(filePath: string): boolean {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return FLOW_FILE_EXTENSIONS.has(ext);
}

/** 「Update」→「Update()」。すでに括弧があればそのまま。 */
export function normalizeFunctionName(name: string): string {
  return name.includes("(") ? name : `${name}()`;
}

function isCallableKind(k: vscode.SymbolKind): boolean {
  return (
    k === vscode.SymbolKind.Function ||
    k === vscode.SymbolKind.Method ||
    k === vscode.SymbolKind.Constructor
  );
}

function flattenSymbols(list: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  return list.flatMap((s) => [s, ...flattenSymbols(s.children ?? [])]);
}

/** ファイル内の関数・メソッド・コンストラクタを、出現順に平らにして返す(言語サーバーが無ければ空)。 */
export async function getCallableSymbols(doc: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    "vscode.executeDocumentSymbolProvider",
    doc.uri
  );
  if (!symbols || symbols.length === 0) return [];
  return flattenSymbols(symbols)
    .filter((s) => isCallableKind(s.kind))
    .sort((a, b) => a.range.start.compareTo(b.range.start));
}

/**
 * DocumentSymbolを第一選択とし、シンボルが一切取得できない言語に対しては
 * web-tree-sitterによるAST解析へフォールバックする。
 *
 *   symbols?.length ? buildIRFromDocumentSymbols(...) : buildIRFromTreeSitter(...)
 *
 * `selection` は「どの関数か」を決める手がかり(範囲選択でもカーソル位置だけでもよい)。
 * 言語未対応・構文エラーの可能性は FlowchartUserError で知らせる。
 */
export async function extractFlowchartIR(
  extensionUri: vscode.Uri,
  doc: vscode.TextDocument,
  selection?: vscode.Selection,
  token?: vscode.CancellationToken
): Promise<FlowchartIR> {
  if (!isFlowSupportedLanguage(doc.languageId)) {
    throw new FlowchartUserError(
      `この言語(${doc.languageId})は未対応です。波括弧でブロックを書く言語(C#・TypeScript・JavaScript・Java・Kotlin・Go・Rust など)と Python に対応しています。`
    );
  }

  if (TREE_SITTER_ONLY_LANGUAGE_IDS.has(doc.languageId)) {
    return extractPythonLike(extensionUri, doc, selection);
  }

  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    "vscode.executeDocumentSymbolProvider",
    doc.uri
  );

  if (token?.isCancellationRequested) {
    throw new vscode.CancellationError();
  }

  if (symbols && symbols.length > 0) {
    return buildIRFromDocumentSymbols(doc, symbols, selection);
  }

  return buildIRFromTreeSitter(extensionUri, doc, selection);
}

async function extractPythonLike(
  extensionUri: vscode.Uri,
  doc: vscode.TextDocument,
  selection?: vscode.Selection
): Promise<FlowchartIR> {
  try {
    return await extractWithTreeSitter(extensionUri, doc, selection, { strict: true });
  } catch (err) {
    if (err instanceof TreeSitterSyntaxError) {
      throw new FlowchartUserError(
        `構文エラーの可能性があり、フローを作れません(${err.line} 行目付近)。入力中の場合は、書き終えてからもう一度お試しください。`
      );
    }
    console.warn("[flowchart] tree-sitter抽出に失敗しました", err);
    throw new FlowchartUserError(
      `${doc.languageId} の構文解析に失敗しました(wasm/ の文法ファイルが無い可能性があります。\`npm run fetch-wasm\` を実行してください)。`
    );
  }
}

function findTargetSymbol(
  symbols: vscode.DocumentSymbol[],
  selection?: vscode.Selection
): vscode.DocumentSymbol | undefined {
  const callables = flattenSymbols(symbols).filter((s) => isCallableKind(s.kind));

  if (selection) {
    const containing = callables
      .filter((s) => s.range.contains(selection))
      .sort((a, b) => rangeSize(a.range) - rangeSize(b.range));
    if (containing.length > 0) return containing[0];
  }

  return callables[0];
}

function rangeSize(range: vscode.Range): number {
  return range.end.line - range.start.line;
}

function buildIRFromDocumentSymbols(
  doc: vscode.TextDocument,
  symbols: vscode.DocumentSymbol[],
  selection?: vscode.Selection
): FlowchartIR {
  const target = findTargetSymbol(symbols, selection);
  const range = target?.range ?? (selection && !selection.isEmpty ? selection : undefined) ?? fullDocumentRange(doc);
  const label = target ? normalizeFunctionName(target.name) : path.basename(doc.fileName);

  const text = doc.getText(range);
  const balance = checkBraceBalance(text);
  if (!balance.ok) {
    throw new FlowchartUserError(
      `構文エラーの可能性があり、フローを作れません: ${balance.reason}。入力中の場合は、書き終えてからもう一度お試しください。`
    );
  }
  return irFromFunctionText(text, range.start.line, label, path.basename(doc.fileName));
}

async function buildIRFromTreeSitter(
  extensionUri: vscode.Uri,
  doc: vscode.TextDocument,
  selection?: vscode.Selection
): Promise<FlowchartIR> {
  const range = selection && !selection.isEmpty ? selection : fullDocumentRange(doc);
  const label = path.basename(doc.fileName);

  if (isLanguageSupportedByTreeSitter(doc.languageId)) {
    try {
      return await extractWithTreeSitter(extensionUri, doc, selection);
    } catch (err) {
      console.warn(
        "[flowchart] tree-sitter抽出に失敗、ヒューリスティックスキャナへフォールバックします",
        err
      );
    }
  }

  const text = doc.getText(range);
  const balance = checkBraceBalance(text);
  if (!balance.ok) {
    throw new FlowchartUserError(
      `構文エラーの可能性があり、フローを作れません: ${balance.reason}。入力中の場合は、書き終えてからもう一度お試しください。`
    );
  }
  return irFromFunctionText(text, range.start.line, label, path.basename(doc.fileName));
}

function fullDocumentRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
}
