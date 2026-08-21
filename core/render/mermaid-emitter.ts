import type { FlowchartIR, NodeKind } from "../flowchart-ir/schema";

/**
 * ノード種別 → Mermaid flowchart 図形記法(開始・終了デリミタ)。
 * start/end は角丸端子ノード、process は矩形、decision はひし形、
 * loop はサブルーチン形状、ioOperation は平行四辺形で表現する。
 */
const SHAPE: Record<NodeKind, [string, string]> = {
  start: ["([", "])"],
  end: ["([", "])"],
  process: ["[", "]"],
  decision: ["{", "}"],
  loop: ["[[", "]]"],
  ioOperation: ["[/", "/]"],
};

function escapeLabel(label: string): string {
  return label.replace(/"/g, "&quot;").replace(/\n/g, "<br/>");
}

/**
 * FlowchartIRをMermaidの`flowchart TD`構文へ直列化する。
 * 出力はMermaid CLI / Mermaid Live Editorでそのままレンダリング可能な
 * ポータブルなテキストであり、独自フォーマットは含まない。
 */
export function emitMermaid(ir: FlowchartIR): string {
  const lines = ["flowchart TD"];

  for (const n of ir.nodes) {
    const [open, close] = SHAPE[n.kind];
    lines.push(`  ${n.id}${open}"${escapeLabel(n.label)}"${close}`);
  }

  for (const e of ir.edges) {
    const arrow = e.label ? `-->|${e.label}|` : "-->";
    lines.push(`  ${e.from} ${arrow} ${e.to}`);
  }

  return lines.join("\n");
}
