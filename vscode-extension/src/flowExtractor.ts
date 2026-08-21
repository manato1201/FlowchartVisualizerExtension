import * as path from "path";
import * as vscode from "vscode";
import { FlowchartIR } from "../../core/flowchart-ir/schema";
import { scanControlFlowHeuristic } from "./controlFlowScanner";
import { extractWithTreeSitter, isLanguageSupportedByTreeSitter } from "./treeSitterExtractor";

/**
 * DocumentSymbolを第一選択とし、シンボルが一切取得できない言語に対しては
 * web-tree-sitterによるAST解析へフォールバックする。
 *
 *   symbols?.length ? buildIRFromDocumentSymbols(...) : buildIRFromTreeSitter(...)
 */
export async function extractFlowchartIR(
  extensionUri: vscode.Uri,
  doc: vscode.TextDocument,
  selection?: vscode.Selection,
  token?: vscode.CancellationToken
): Promise<FlowchartIR> {
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

function findTargetSymbol(
  symbols: vscode.DocumentSymbol[],
  selection?: vscode.Selection
): vscode.DocumentSymbol | undefined {
  const isCallable = (k: vscode.SymbolKind) =>
    k === vscode.SymbolKind.Function ||
    k === vscode.SymbolKind.Method ||
    k === vscode.SymbolKind.Constructor;

  const flatten = (list: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] =>
    list.flatMap((s) => [s, ...flatten(s.children ?? [])]);

  const all = flatten(symbols);
  const callables = all.filter((s) => isCallable(s.kind));

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
  const range = target?.range ?? selection ?? fullDocumentRange(doc);
  const label = target?.name ?? "selection";

  const text = doc.getText(range);
  const { nodes, edges } = scanControlFlowHeuristic(text, range.start.line, label);

  return {
    nodes,
    edges,
    sourceFile: path.basename(doc.fileName),
    generatedAt: new Date().toISOString(),
  };
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
      return await extractWithTreeSitter(extensionUri, doc, range, label);
    } catch (err) {
      console.warn(
        "[flowchart] tree-sitter抽出に失敗、ヒューリスティックスキャナへフォールバックします",
        err
      );
    }
  }

  const text = doc.getText(range);
  const { nodes, edges } = scanControlFlowHeuristic(text, range.start.line, label);
  return {
    nodes,
    edges,
    sourceFile: path.basename(doc.fileName),
    generatedAt: new Date().toISOString(),
  };
}

function fullDocumentRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
}
