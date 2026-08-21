// core/dist をビルドした後に実行する簡易スモークテスト。
// if/forを含む合成ILからMermaidテキストが正しく直列化されることを目視確認する。
const { emitMermaid } = require("../dist/render/mermaid-emitter");
const { validateFlowchartIR } = require("../dist/flowchart-ir/schema");

const ir = {
  sourceFile: "Sample.cs",
  generatedAt: new Date().toISOString(),
  nodes: [
    { id: "n1", kind: "start", label: "Start", sourceRange: { startLine: 1, endLine: 1 } },
    { id: "n2", kind: "loop", label: "for (i = 0; i < 10; i++)", sourceRange: { startLine: 2, endLine: 8 } },
    { id: "n3", kind: "decision", label: "if (isGrounded)", sourceRange: { startLine: 3, endLine: 6 } },
    { id: "n4", kind: "process", label: "Jump()", sourceRange: { startLine: 4, endLine: 4 } },
    { id: "n5", kind: "process", label: "Fall()", sourceRange: { startLine: 6, endLine: 6 } },
    { id: "n6", kind: "end", label: "End", sourceRange: { startLine: 9, endLine: 9 } },
  ],
  edges: [
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
    { from: "n3", to: "n4", label: "true" },
    { from: "n3", to: "n5", label: "false" },
    { from: "n4", to: "n2" },
    { from: "n5", to: "n2" },
    { from: "n2", to: "n6" },
  ],
};

const errors = validateFlowchartIR(ir);
if (errors.length > 0) {
  console.error("IR検証エラー:", errors);
  process.exit(1);
}

console.log(emitMermaid(ir));
console.log("\nスモークテストOK: IR検証・Mermaid直列化とも成功");
