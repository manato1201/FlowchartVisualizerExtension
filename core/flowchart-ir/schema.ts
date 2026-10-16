/**
 * FlowchartIR — ホスト非依存の中間表現。
 *
 * この型定義は vscode.*, Roslyn の SyntaxNode/ControlFlowGraph, IntelliJ の PsiElement
 * など、いかなるホスト固有APIの型も一切参照してはならない。
 * 各ホストアダプタはネイティブ解析結果をこの型に変換する責務のみを負う。
 */

export type NodeKind =
  "start" | "end" | "process" | "decision" | "loop" | "ioOperation";

export interface SourceRange {
  startLine: number;
  endLine: number;
}

/**
 * 差分表示(X3)用の状態。抽出器は設定しない。`core/diff/ir-diff.ts` が付与する任意フィールドで、
 * 通常のIRには現れない(ホスト間で受け渡す基本スキーマは変えない)。
 */
export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface FlowchartNode {
  /** アダプタ側で採番する一意なID。例: "n1" */
  id: string;
  kind: NodeKind;
  /** 例: "if (isGrounded)" */
  label: string;
  sourceRange: SourceRange;
  diff?: DiffStatus;
  /** diff === "changed" のときだけ、変更前のラベル(ツールチップで見せる) */
  previousLabel?: string;
}

export type EdgeLabel = "true" | "false" | "";

export interface FlowchartEdge {
  /** FlowchartNode.id */
  from: string;
  /** FlowchartNode.id */
  to: string;
  label?: EdgeLabel;
  diff?: DiffStatus;
}

export interface FlowchartIR {
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
  /** 相対パスまたはURI */
  sourceFile: string;
  /** ISO8601 */
  generatedAt: string;
}

/**
 * FlowchartIRの構造的妥当性を検証する。
 * すべてのエッジが実在するノードIDを参照していること、ノードIDが重複していないことを確認する。
 */
export function validateFlowchartIR(ir: FlowchartIR): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const node of ir.nodes) {
    if (ids.has(node.id)) {
      errors.push(`重複したノードID: ${node.id}`);
    }
    ids.add(node.id);
  }

  for (const edge of ir.edges) {
    if (!ids.has(edge.from)) {
      errors.push(`存在しないノードIDへの参照 (from): ${edge.from}`);
    }
    if (!ids.has(edge.to)) {
      errors.push(`存在しないノードIDへの参照 (to): ${edge.to}`);
    }
  }

  return errors;
}

/** FlowchartIRビルダー用の採番ヘルパー。アダプタ間で共通利用できる。 */
export class NodeIdAllocator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `n${this.counter}`;
  }
}
