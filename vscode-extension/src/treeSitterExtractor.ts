import * as path from "path";
import * as vscode from "vscode";
import Parser from "web-tree-sitter";
import {
  FlowchartEdge,
  FlowchartIR,
  FlowchartNode,
  NodeIdAllocator,
} from "../../core/flowchart-ir/schema";

/**
 * DocumentSymbolプロバイダを持たない言語向けのフォールバック抽出器。
 * web-tree-sitter(WASM版tree-sitter)で実際のAST(Concrete Syntax Tree)を走査し、
 * if/for/while/switch相当のノードを検出する。
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
      locateFile: (fileName: string) =>
        vscode.Uri.joinPath(wasmDir, fileName).fsPath,
    });
  }
  await initPromise;
}

async function getLanguage(
  extensionUri: vscode.Uri,
  languageId: string,
): Promise<Parser.Language> {
  const grammarFile = LANGUAGE_ID_TO_GRAMMAR[languageId];
  if (!grammarFile) throw new Error(`未対応の言語です: ${languageId}`);

  const cached = languageCache.get(grammarFile);
  if (cached) return cached;

  await ensureInitialized(extensionUri);
  const wasmPath = vscode.Uri.joinPath(
    extensionUri,
    "wasm",
    grammarFile,
  ).fsPath;
  const language = await Parser.Language.load(wasmPath);
  languageCache.set(grammarFile, language);
  return language;
}

const CONTROL_NODE_TYPES = new Set([
  "if_statement",
  "for_statement",
  "for_each_statement",
  "for_in_statement",
  "for_of_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "switch_expression",
]);

export async function extractWithTreeSitter(
  extensionUri: vscode.Uri,
  doc: vscode.TextDocument,
  range: vscode.Range,
  functionLabel: string,
): Promise<FlowchartIR> {
  const language = await getLanguage(extensionUri, doc.languageId);

  const parser = new Parser();
  parser.setLanguage(language);

  const sourceText = doc.getText(range);
  const tree = parser.parse(sourceText);
  if (!tree) throw new Error("tree-sitterの構文解析に失敗しました");

  const allocator = new NodeIdAllocator();
  const nodes: FlowchartNode[] = [];
  const edges: FlowchartEdge[] = [];

  const baseLine = range.start.line;
  const startId = allocator.next();
  nodes.push({
    id: startId,
    kind: "start",
    label: functionLabel,
    sourceRange: { startLine: baseLine + 1, endLine: baseLine + 1 },
  });
  const endId = allocator.next();
  nodes.push({
    id: endId,
    kind: "end",
    label: "End",
    sourceRange: { startLine: range.end.line + 1, endLine: range.end.line + 1 },
  });

  const bodyNode = findFunctionBody(tree.rootNode) ?? tree.rootNode;
  const result = walkBlock(bodyNode, allocator, nodes, edges, baseLine);

  if (result.entryId) {
    edges.push({ from: startId, to: result.entryId });
  } else {
    edges.push({ from: startId, to: endId });
  }
  for (const exitId of result.exitIds) {
    edges.push({ from: exitId, to: endId });
  }

  return {
    nodes,
    edges,
    sourceFile: path.basename(doc.fileName),
    generatedAt: new Date().toISOString(),
  };
}

function findFunctionBody(
  root: Parser.SyntaxNode,
): Parser.SyntaxNode | null {
  const bodyTypes = ["block", "statement_block"];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (bodyTypes.includes(n.type)) return n;
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
  return null;
}

interface WalkResult {
  entryId?: string;
  exitIds: string[];
}

function truncate(s: string, max = 60): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

function walkBlock(
  block: Parser.SyntaxNode,
  allocator: NodeIdAllocator,
  nodes: FlowchartNode[],
  edges: FlowchartEdge[],
  baseLine: number,
): WalkResult {
  let entryId: string | undefined;
  let tailIds: string[] = [];

  const connect = (nodeId: string) => {
    if (!entryId) entryId = nodeId;
    for (const t of tailIds) edges.push({ from: t, to: nodeId });
    tailIds = [nodeId];
  };

  for (let i = 0; i < block.childCount; i++) {
    const child = block.child(i);
    if (!child) continue;
    if (child.type === "{" || child.type === "}") continue;

    if (child.type === "if_statement") {
      const chain = walkIfChain(child, allocator, nodes, edges, baseLine);
      if (chain.entryId) connect(chain.entryId);
      tailIds = chain.exitIds;
      continue;
    }

    if (CONTROL_NODE_TYPES.has(child.type) && child.type !== "if_statement") {
      const isSwitch = child.type.startsWith("switch");
      const conditionNode =
        child.childForFieldName?.("condition") ??
        findChildByType(child, ["parenthesized_expression"]);
      const label = `${child.type.replace(/_statement|_expression/g, "")} (${truncate(
        conditionNode?.text ?? "",
        40,
      )})`;
      const line = baseLine + child.startPosition.row;
      const controlId = allocator.next();
      nodes.push({
        id: controlId,
        kind: isSwitch ? "decision" : "loop",
        label,
        sourceRange: { startLine: line + 1, endLine: line + 1 },
      });
      connect(controlId);

      const bodyBlock = findChildByType(child, [
        "block",
        "statement_block",
        "switch_body",
      ]);
      if (bodyBlock) {
        if (isSwitch) {
          const caseExits: string[] = [];
          for (let j = 0; j < bodyBlock.childCount; j++) {
            const caseChild = bodyBlock.child(j);
            if (!caseChild || !caseChild.type.includes("case")) continue;
            const caseResult = walkBlock(
              caseChild,
              allocator,
              nodes,
              edges,
              baseLine,
            );
            if (caseResult.entryId) {
              edges.push({
                from: controlId,
                to: caseResult.entryId,
                label: "",
              });
              caseExits.push(...caseResult.exitIds);
            }
          }
          tailIds = caseExits.length ? caseExits : [controlId];
        } else {
          const bodyResult = walkBlock(
            bodyBlock,
            allocator,
            nodes,
            edges,
            baseLine,
          );
          if (bodyResult.entryId) {
            edges.push({
              from: controlId,
              to: bodyResult.entryId,
              label: "true",
            });
            for (const exitId of bodyResult.exitIds) {
              edges.push({ from: exitId, to: controlId });
            }
          }
          tailIds = [controlId];
        }
      } else {
        tailIds = [controlId];
      }
      continue;
    }

    if (child.childCount === 0 || !isBlockLike(child)) {
      const text = child.text.trim();
      if (!text) continue;
      const line = baseLine + child.startPosition.row;
      const id = allocator.next();
      nodes.push({
        id,
        kind: "process",
        label: truncate(text),
        sourceRange: { startLine: line + 1, endLine: line + 1 },
      });
      connect(id);
    }
  }

  return { entryId, exitIds: tailIds };
}

function isBlockLike(
  node: Parser.SyntaxNode,
): boolean {
  return ["block", "statement_block"].includes(node.type);
}

function findChildByType(
  node: Parser.SyntaxNode,
  types: string[],
): Parser.SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && types.includes(c.type)) return c;
  }
  return null;
}

interface IfChainResult {
  entryId?: string;
  exitIds: string[];
}

function walkIfChain(
  node: Parser.SyntaxNode,
  allocator: NodeIdAllocator,
  nodes: FlowchartNode[],
  edges: FlowchartEdge[],
  baseLine: number,
): IfChainResult {
  const conditionNode = node.childForFieldName?.("condition");
  const consequenceNode = node.childForFieldName?.("consequence");
  const alternativeNode = node.childForFieldName?.("alternative");

  const line = baseLine + node.startPosition.row;
  const decisionId = allocator.next();
  nodes.push({
    id: decisionId,
    kind: "decision",
    label: `if (${truncate(conditionNode?.text ?? "", 40)})`,
    sourceRange: { startLine: line + 1, endLine: line + 1 },
  });

  const exitIds: string[] = [];

  if (consequenceNode) {
    const bodyBlock = isBlockLike(consequenceNode)
      ? consequenceNode
      : consequenceNode;
    const bodyResult = walkBlock(bodyBlock, allocator, nodes, edges, baseLine);
    if (bodyResult.entryId) {
      edges.push({ from: decisionId, to: bodyResult.entryId, label: "true" });
      exitIds.push(...bodyResult.exitIds);
    } else {
      exitIds.push(decisionId);
    }
  }

  if (alternativeNode) {
    if (alternativeNode.type === "if_statement") {
      const nested = walkIfChain(
        alternativeNode,
        allocator,
        nodes,
        edges,
        baseLine,
      );
      if (nested.entryId) {
        edges.push({ from: decisionId, to: nested.entryId, label: "false" });
      }
      exitIds.push(...nested.exitIds);
    } else {
      const bodyResult = walkBlock(
        alternativeNode,
        allocator,
        nodes,
        edges,
        baseLine,
      );
      if (bodyResult.entryId) {
        edges.push({
          from: decisionId,
          to: bodyResult.entryId,
          label: "false",
        });
        exitIds.push(...bodyResult.exitIds);
      } else {
        exitIds.push(decisionId);
      }
    }
  } else {
    exitIds.push(decisionId);
  }

  return { entryId: decisionId, exitIds };
}
