import type { FlowchartIR, NodeKind } from "../flowchart-ir/schema";

/**
 * ノード種別 → Mermaid flowchart 図形記法(開始・終了デリミタ)。
 *
 * 図形の決めごと表(IMPROVEMENT_DESIGN_2026-10.md §3 / 原則P1)。**1表に固定**し、
 * 3ホスト(TS/C#/Kotlin)のエミッターとWebviewバンドルの `views.js` で同じ表を使う:
 *   - start / end : 角丸の長方形  `(...)`
 *   - process     : 長方形        `[...]`
 *   - decision    : ひし形        `{...}`
 *   - loop        : 六角形        `{{...}}`
 *   - ioOperation : 平行四辺形    `[/.../]`
 */
const SHAPE: Record<NodeKind, [string, string]> = {
  start: ["(", ")"],
  end: ["(", ")"],
  process: ["[", "]"],
  decision: ["{", "}"],
  loop: ["{{", "}}"],
  ioOperation: ["[/", "/]"],
};

/**
 * ラベル内の特殊文字を Mermaid のエンティティ記法(`#quot;` 等)に置換する。
 * `<` / `>` を素通しすると `i<n` のような式がHTMLタグとして解釈されて消えるため。
 */
function escapeLabel(label: string): string {
  return label
    .replace(/&/g, "#amp;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/\n/g, "<br/>");
}

/**
 * FlowchartIRをMermaidの`flowchart TD`構文へ直列化する。
 * 出力はMermaid CLI / Mermaid Live Editorでそのままレンダリング可能な
 * ポータブルなテキストであり、独自フォーマットは含まない。
 * (Webview内のビュー切替・差分着色は `webview-bundle/views.js` が担う。ここは「フロー」ビュー相当。)
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
