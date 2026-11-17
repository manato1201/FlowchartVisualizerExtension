#!/usr/bin/env node
// 「フローの JSON」(LLM・外部ツールの出力)を検証して、Mermaid テキストにする。
//   node scripts/ir-to-mermaid.js flow.json        # ファイルから
//   cat flow.json | node scripts/ir-to-mermaid.js  # 標準入力から
// 成功: Mermaid を標準出力へ(警告は標準エラーへ)。失敗: エラーの一覧を標準エラーへ出して終了コード 1。
// 先に `npm run build`(core/dist を作る)が必要。入力の仕様は docs/reference/flowchart-ir.schema.json。
const fs = require("node:fs");
const { parseFlowchartIRInput, IR_INPUT_LIMITS } = require("../dist/flowchart-ir/ir-input");
const { emitMermaid } = require("../dist/render/mermaid-emitter");

function readInput(arg) {
  if (arg) {
    const size = fs.statSync(arg).size;
    if (size > IR_INPUT_LIMITS.maxInputChars * 4) throw new Error("ファイルが大きすぎます");
    return fs.readFileSync(arg, "utf8");
  }
  return fs.readFileSync(0, "utf8"); // 標準入力
}

let text;
try {
  text = readInput(process.argv[2]);
} catch (e) {
  console.error("読み込めません: " + e.message);
  process.exit(2);
}

const r = parseFlowchartIRInput(text);
if (!r.ok) {
  console.error(`フローの JSON を読めません(${r.errors.length} 件):`);
  for (const e of r.errors) console.error("  ・" + e);
  process.exit(1);
}
for (const w of r.warnings) console.error("注意: " + w);
console.log(emitMermaid(r.ir));
