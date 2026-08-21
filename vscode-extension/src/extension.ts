import * as vscode from "vscode";
import { emitMermaid } from "../../core/render/mermaid-emitter";
import { extractFlowchartIR } from "./flowExtractor";
import {
  getOrCreateFlowchartPanel,
  postFlowchart,
  requestPngExport,
  requestSvgExport,
} from "./webviewPanel";

const DEBOUNCE_MS = 500;

let lastMermaidText: string | undefined;
let pendingAnalysis: vscode.CancellationTokenSource | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("flowchart.generateFromFile", async () => {
      await generateAndShow(context, undefined);
    }),

    vscode.commands.registerCommand(
      "flowchart.generateFromSelection",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
          vscode.window.showWarningMessage(
            "フローチャートを生成する範囲を選択してください",
          );
          return;
        }
        await generateAndShow(context, editor.selection);
      },
    ),

    vscode.commands.registerCommand("flowchart.exportSvg", async () => {
      await exportFlowchart(context, "svg");
    }),

    vscode.commands.registerCommand("flowchart.exportPng", async () => {
      await exportFlowchart(context, "png");
    }),

    vscode.commands.registerCommand("flowchart.copyMermaid", async () => {
      if (!lastMermaidText) {
        vscode.window.showWarningMessage(
          "先にフローチャートを生成してください",
        );
        return;
      }
      await vscode.env.clipboard.writeText(lastMermaidText);
      vscode.window.showInformationMessage(
        "Mermaidテキストをクリップボードにコピーしました",
      );
    }),

    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const config = vscode.workspace.getConfiguration();
      if (!config.get<boolean>("flowchart.autoRefresh")) return;
      if (doc !== vscode.window.activeTextEditor?.document) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void refreshOnSave(context, doc);
      }, DEBOUNCE_MS);
    }),
  );
}

export function deactivate(): void {
  pendingAnalysis?.cancel();
  if (debounceTimer) clearTimeout(debounceTimer);
}

async function generateAndShow(
  context: vscode.ExtensionContext,
  selection: vscode.Selection | undefined,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("アクティブなエディタがありません");
    return;
  }

  pendingAnalysis?.cancel();
  pendingAnalysis = new vscode.CancellationTokenSource();

  try {
    const ir = await extractFlowchartIR(
      context.extensionUri,
      editor.document,
      selection,
      pendingAnalysis.token,
    );
    if (pendingAnalysis.token.isCancellationRequested) return;

    const mermaidText = emitMermaid(ir);
    lastMermaidText = mermaidText;
    const panel = getOrCreateFlowchartPanel(context);
    postFlowchart(panel, mermaidText);
  } catch (err) {
    if (err instanceof vscode.CancellationError) return;
    vscode.window.showErrorMessage(
      `フローチャート生成に失敗しました: ${(err as Error).message}`,
    );
  }
}

/** ファイル保存時の自動再生成(Phase5)。前回解析が残っていればキャンセルする。 */
async function refreshOnSave(
  context: vscode.ExtensionContext,
  doc: vscode.TextDocument,
): Promise<void> {
  pendingAnalysis?.cancel();
  pendingAnalysis = new vscode.CancellationTokenSource();
  const token = pendingAnalysis.token;

  try {
    const ir = await extractFlowchartIR(
      context.extensionUri,
      doc,
      undefined,
      token,
    );
    if (token.isCancellationRequested) return;

    const mermaidText = emitMermaid(ir);
    lastMermaidText = mermaidText;
    const panel = getOrCreateFlowchartPanel(context);
    postFlowchart(panel, mermaidText);
  } catch (err) {
    if (err instanceof vscode.CancellationError) return;
    console.error("[flowchart] 自動再生成に失敗しました", err);
  }
}

async function exportFlowchart(
  context: vscode.ExtensionContext,
  format: "svg" | "png",
): Promise<void> {
  if (!lastMermaidText) {
    vscode.window.showWarningMessage("先にフローチャートを生成してください");
    return;
  }
  const panel = getOrCreateFlowchartPanel(context);

  if (format === "svg") {
    const svg = await requestSvgExport(panel);
    if (!svg) {
      vscode.window.showErrorMessage("SVGの取得に失敗しました");
      return;
    }
    const uri = await vscode.window.showSaveDialog({
      filters: { SVG: ["svg"] },
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(svg, "utf-8"));
    vscode.window.showInformationMessage(`SVGを書き出しました: ${uri.fsPath}`);
    return;
  }

  const dataUrl = await requestPngExport(panel);
  if (!dataUrl) {
    vscode.window.showErrorMessage("PNGの取得に失敗しました");
    return;
  }
  const uri = await vscode.window.showSaveDialog({ filters: { PNG: ["png"] } });
  if (!uri) return;
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  await vscode.workspace.fs.writeFile(uri, Buffer.from(base64, "base64"));
  vscode.window.showInformationMessage(`PNGを書き出しました: ${uri.fsPath}`);
}
