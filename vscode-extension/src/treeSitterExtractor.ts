import * as path from "path";
import * as vscode from "vscode";
import Parser from "web-tree-sitter";
import type { FlowchartIR } from "../../core/flowchart-ir/schema";
import { buildFlowFromTree } from "./treeSitterWalker";

/**
 * DocumentSymbolプロバイダを持たない言語向けのフォールバック抽出器。
 * web-tree-sitter(WASM版tree-sitter)で実際のAST(Concrete Syntax Tree)を作り、
 * 構文木からのフロー組み立ては treeSitterWalker.ts(vscode に依存しない純粋なウォーカー)が行う。
 * ここは WASM の初期化・文法の読み込み・ドキュメントの受け渡しだけを担う。
 *
 * 対応文法(WASM)は vscode-extension/wasm/ に同梱されたもののみ。未同梱の言語は
 * `isLanguageSupportedByTreeSitter` がfalseを返し、呼び出し側はヒューリスティック
 * スキャナへさらにフォールバックする(例外を投げて処理を止めない)。
 */

let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Parser.Language>();

const LANGUAGE_ID_TO_GRAMMAR: Record<string, string> = {
  csharp: "tree-sitter-c_sharp.wasm",
  typescript: "tree-sitter-typescript.wasm",
  typescriptreact: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  javascriptreact: "tree-sitter-javascript.wasm",
};

export function isLanguageSupportedByTreeSitter(languageId: string): boolean {
  return languageId in LANGUAGE_ID_TO_GRAMMAR;
}

async function ensureInitialized(extensionUri: vscode.Uri): Promise<void> {
  if (!initPromise) {
    const wasmDir = vscode.Uri.joinPath(extensionUri, "wasm");
    initPromise = Parser.init({
      locateFile: (fileName: string) => vscode.Uri.joinPath(wasmDir, fileName).fsPath,
    });
  }
  await initPromise;
}

async function getLanguage(extensionUri: vscode.Uri, languageId: string): Promise<Parser.Language> {
  const grammarFile = LANGUAGE_ID_TO_GRAMMAR[languageId];
  if (!grammarFile) throw new Error(`未対応の言語です: ${languageId}`);

  const cached = languageCache.get(grammarFile);
  if (cached) return cached;

  await ensureInitialized(extensionUri);
  const wasmPath = vscode.Uri.joinPath(extensionUri, "wasm", grammarFile).fsPath;
  const language = await Parser.Language.load(wasmPath);
  languageCache.set(grammarFile, language);
  return language;
}

/**
 * ドキュメント全体を構文解析し、`selection` の位置にある関数(無ければ最初の関数)のフローを返す。
 * (以前は選択範囲だけを切り出して解析しており、範囲が関数の途中だと構文木が崩れていた)
 */
export async function extractWithTreeSitter(
  extensionUri: vscode.Uri,
  doc: vscode.TextDocument,
  selection?: vscode.Selection,
): Promise<FlowchartIR> {
  const language = await getLanguage(extensionUri, doc.languageId);

  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(doc.getText());
    if (!tree) throw new Error("tree-sitterの構文解析に失敗しました");

    const at = selection ? { row: selection.start.line, column: selection.start.character } : undefined;
    const { nodes, edges } = buildFlowFromTree(tree.rootNode, at, path.basename(doc.fileName));
    tree.delete();

    return {
      nodes,
      edges,
      sourceFile: path.basename(doc.fileName),
      generatedAt: new Date().toISOString(),
    };
  } finally {
    parser.delete();
  }
}
