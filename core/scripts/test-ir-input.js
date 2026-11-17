// 「フローの JSON」(LLM・外部ツールの入力)の検証・変換のテスト。
// 入力は信用しない前提なので、拒否すべきもの・無害化すべきものを重点的に確認する。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  parseFlowchartIRInput,
  parseFlowchartIRInputOrThrow,
  irInputToMermaid,
  sanitizeText,
  IrInputError,
  IR_INPUT_LIMITS,
} = require("../dist/flowchart-ir/ir-input");
const { emitMermaid } = require("../dist/render/mermaid-emitter");
const { validateFlowchartIR } = require("../dist/flowchart-ir/schema");
const Views = require("../webview-bundle/views.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok   " + name);
  } catch (e) {
    console.error("  FAIL " + name + "\n" + e.stack);
    process.exitCode = 1;
  }
}

const good = () => ({
  sourceFile: "login-flow",
  nodes: [
    { id: "n1", kind: "start", label: "login()" },
    { id: "n2", kind: "decision", label: "ok?" },
    { id: "n3", kind: "process", label: "make session" },
    { id: "n4", kind: "process", label: "return error" },
    { id: "n5", kind: "end", label: "End" },
  ],
  edges: [
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3", label: "true" },
    { from: "n2", to: "n4", label: "false" },
    { from: "n3", to: "n5" },
    { from: "n4", to: "n5" },
  ],
});
const errorsOf = (input) => {
  const r = parseFlowchartIRInput(input);
  assert.equal(r.ok, false, "拒否されるはず: " + JSON.stringify(input).slice(0, 120));
  return r.errors;
};
const anyMatch = (errors, re) => errors.some((e) => re.test(e));

test("正しい入力: IR になり、既存の検証(validateFlowchartIR)を通り、Mermaid になる。オブジェクトでも JSON 文字列でも同じ", () => {
  const r = parseFlowchartIRInput(good());
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(validateFlowchartIR(r.ir), []);
  assert.equal(r.ir.nodes[0].sourceRange.startLine, 0, "sourceRange 省略は 0(対応なし)");
  const fromText = parseFlowchartIRInput(JSON.stringify(good()));
  assert.deepEqual(fromText.ir.nodes, r.ir.nodes);
  const m = irInputToMermaid(good());
  assert.match(m, /^flowchart TD/);
  assert.match(m, /n2\{"ok\?"\}/);
  assert.match(m, /n2 -->\|true\| n3/);
  assert.equal(m, emitMermaid(r.ir), "既存のエミッターをそのまま使う");
  assert.equal(Views.emitMermaid(r.ir), m, "Webview のエミッターとも同一");
});

test("LLM がよく付ける ```json の囲みは外す(中身の検証は同じ)", () => {
  const fenced = "```json\n" + JSON.stringify(good()) + "\n```";
  assert.equal(parseFlowchartIRInput(fenced).ok, true);
  assert.equal(parseFlowchartIRInput("```\n{\"nodes\": []}\n```").ok, false);
});

test("JSON として壊れている・オブジェクトでない入力は、理由つきで拒否", () => {
  assert.match(errorsOf("{nodes: [")[0], /JSON として読めません/);
  assert.match(errorsOf("[]")[0], /オブジェクト/);
  assert.match(errorsOf("null")[0], /オブジェクト/);
  assert.match(errorsOf(42)[0], /オブジェクト/);
  assert.match(errorsOf({})[0], /nodes: 1 個以上/);
  assert.match(errorsOf({ nodes: [] })[0], /nodes: 1 個以上/);
});

test("未知のキーを拒否する(トップレベル・ノード・線・sourceRange)。どこの何かが分かる", () => {
  const top = Object.assign(good(), { nodez: [] });
  assert.ok(anyMatch(errorsOf(top), /\(トップレベル\): 未知のキー "nodez"/));
  const node = good();
  node.nodes[2].color = "red";
  assert.ok(anyMatch(errorsOf(node), /nodes\[2\]: 未知のキー "color"/));
  const edge = good();
  edge.edges[1].weight = 3;
  assert.ok(anyMatch(errorsOf(edge), /edges\[1\]: 未知のキー "weight"/));
  const range = good();
  range.nodes[0].sourceRange = { startLine: 1, endLine: 2, file: "x" };
  assert.ok(anyMatch(errorsOf(range), /nodes\[0\]\.sourceRange: 未知のキー "file"/));
  // diff / previousLabel は外から渡させない(内部の差分表示用)
  const diff = good();
  diff.nodes[0].diff = "added";
  assert.ok(anyMatch(errorsOf(diff), /未知のキー "diff"/));
});

test("ID の重複を拒否する(どのノードかが分かる)", () => {
  const ir = good();
  ir.nodes[3].id = "n2";
  const e = errorsOf(ir);
  assert.ok(anyMatch(e, /nodes\[3\]\.id: ID "n2" が重複/), e.join("\n"));
});

test("存在しないノードを指す線を拒否する(from / to のどちらも。どの線かが分かる)", () => {
  const ir = good();
  ir.edges[0].to = "n99";
  ir.edges[2].from = "ghost";
  const e = errorsOf(ir);
  assert.ok(anyMatch(e, /edges\[0\]\.to: ノード "n99" は nodes にありません/), e.join("\n"));
  assert.ok(anyMatch(e, /edges\[2\]\.from: ノード "ghost" は nodes にありません/), e.join("\n"));
});

test("kind・線のラベル・型の違いを拒否する", () => {
  const k = good();
  k.nodes[1].kind = "diamond";
  assert.ok(anyMatch(errorsOf(k), /nodes\[1\]\.kind: "diamond" は使えません.*start/));
  const l = good();
  l.edges[0].label = "maybe";
  assert.ok(anyMatch(errorsOf(l), /edges\[0\]\.label: "maybe" は使えません/));
  const t = good();
  t.nodes[0].label = 123;
  assert.ok(anyMatch(errorsOf(t), /nodes\[0\]\.label: 文字列で指定/));
  const empty = good();
  empty.nodes[0].label = "  \n ";
  assert.ok(anyMatch(errorsOf(empty), /nodes\[0\]\.label: 空です/));
  const nonObj = good();
  nonObj.nodes[1] = "n2";
  assert.ok(anyMatch(errorsOf(nonObj), /nodes\[1\]: オブジェクトではありません/));
  const sr = good();
  sr.nodes[0].sourceRange = { startLine: 5, endLine: 2 };
  assert.ok(anyMatch(errorsOf(sr), /sourceRange: startLine \/ endLine/));
  const date = good();
  date.generatedAt = "yesterday-ish";
  assert.ok(anyMatch(errorsOf(date), /generatedAt/));
});

test("ID は Mermaid の構文に生で入るので、英数字と _ だけ。構文語・組み込み名・注入の試みを拒否する", () => {
  const bad = [
    "n 1",
    "n1;n2",
    'n1"]',
    "1abc",
    "_x",
    "a-b",
    "n1\nclick",
    "end",
    "END",
    "subgraph",
    "style",
    "classDef",
    "click",
    "constructor",
    "toString",
    "hasOwnProperty",
    "__proto__",
    "a".repeat(IR_INPUT_LIMITS.maxIdLength + 1),
    "",
    "日本語",
  ];
  for (const id of bad) {
    const ir = good();
    ir.nodes[2].id = id;
    ir.edges = [];
    assert.ok(anyMatch(errorsOf(ir), /nodes\[2\]\.id/), "拒否されるはず: " + JSON.stringify(id));
  }
  for (const id of ["m1", "Node_2", "a", "x9_9"]) {
    const ir = good();
    ir.nodes[2].id = id;
    ir.edges = [];
    assert.equal(parseFlowchartIRInput(ir).ok, true, id);
  }
});

test("__proto__ を持つ JSON 文字列(プロトタイプ汚染の試み)は、未知のキーとして拒否し、Object を汚さない", () => {
  const text = '{"nodes":[{"id":"n1","kind":"start","label":"a","__proto__":{"polluted":1}}],"__proto__":{"polluted":2}}';
  const r = parseFlowchartIRInput(text);
  assert.equal(r.ok, false);
  assert.ok(anyMatch(r.errors, /未知のキー "__proto__"/));
  assert.equal({}.polluted, undefined);
});

test("ラベル: 長さを制限(切り詰めて警告)・制御文字と向きを変える文字を除く・空白を 1 つに", () => {
  const long = good();
  long.nodes[2].label = "x".repeat(IR_INPUT_LIMITS.maxLabel + 50);
  const r = parseFlowchartIRInput(long);
  assert.equal(r.ok, true);
  assert.equal(Array.from(r.ir.nodes[2].label).length, IR_INPUT_LIMITS.maxLabel);
  assert.ok(r.ir.nodes[2].label.endsWith("…"));
  assert.ok(r.warnings.some((w) => /nodes\[2\]\.label/.test(w)));

  const rlo = String.fromCharCode(0x202e); // 右から左への上書き(見た目をだます)
  const zwsp = String.fromCharCode(0x200b);
  const nul = String.fromCharCode(0);
  const esc = String.fromCharCode(27);
  const s = sanitizeText("a" + rlo + "b" + zwsp + "c" + nul + "d" + esc + "[31m\n\t e   f", 200);
  assert.equal(s.text, "abcd[31m e f");

  // サロゲートペア(絵文字)の途中で切らない
  const emoji = sanitizeText("😀".repeat(10), 5);
  assert.equal(Array.from(emoji.text).length, 5);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji.text), "壊れたペアがない");
});

test("件数・サイズの上限: ノード・線・入力文字列が多すぎれば、中身を走査せずに拒否", () => {
  const many = { nodes: Array.from({ length: IR_INPUT_LIMITS.maxNodes + 1 }, (_, i) => ({ id: "n" + i, kind: "process", label: "x" })) };
  assert.ok(anyMatch(errorsOf(many), /nodes: \d+ 個は多すぎます/));
  const manyEdges = good();
  manyEdges.edges = Array.from({ length: IR_INPUT_LIMITS.maxEdges + 1 }, () => ({ from: "n1", to: "n2" }));
  assert.ok(anyMatch(errorsOf(manyEdges), /edges: \d+ 本は多すぎます/));
  assert.ok(anyMatch(errorsOf("x".repeat(IR_INPUT_LIMITS.maxInputChars + 1)), /大きすぎます/));
});

test("エラーは最大 20 件 + 「ほか N 件」にまとめる(巨大なエラー出力を作らせない)", () => {
  const ir = { nodes: Array.from({ length: 100 }, () => ({ id: "!", kind: "x", label: 1 })) };
  const e = errorsOf(ir);
  assert.equal(e.length, IR_INPUT_LIMITS.maxErrors + 1);
  assert.match(e[e.length - 1], /ほか \d+ 件/);
});

test("警告: start が無い・複数ある(描画はできる)", () => {
  const none = good();
  none.nodes[0].kind = "process";
  const r = parseFlowchartIRInput(none);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /start/.test(w)));
  const two = good();
  two.nodes[4].kind = "start";
  assert.ok(parseFlowchartIRInput(two).warnings.some((w) => /2 個/.test(w)));
});

test("Mermaid へ: ラベルの特殊文字(& \" < > # % `)と、構文を壊そうとする文字列が、図の構造を変えない", () => {
  const ir = good();
  const evil = [
    '"]; n99["injected',
    "<img src=x onerror=alert(1)>",
    "<script>alert(1)</script>",
    "%%{init: {\"flowchart\": {\"htmlLabels\": true}}}%%",
    "`markdown`",
    "a #lt;b#gt; c",
    "x --> y",
    "click n1 call alert()",
    "end",
  ];
  evil.forEach((label, i) => {
    ir.nodes[2].label = label;
    const m = irInputToMermaid(ir);
    const lines = m.split("\n");
    // ノードの行数・線の数が変わらない(ラベルが行や構文を増やしていない)
    assert.equal(lines.length, 1 + ir.nodes.length + ir.edges.length, label + "\n" + m);
    const nodeLine = lines.find((l) => l.startsWith("  n3"));
    // ラベルの中に、エスケープされていない " < > ` や %% が残らない
    const inner = nodeLine.slice(nodeLine.indexOf('"') + 1, nodeLine.lastIndexOf('"'));
    assert.ok(!/["<>`]/.test(inner), "生の特殊文字が残っている: " + inner);
    assert.ok(!/%%/.test(inner), "%% が残っている: " + inner);
    assert.ok(!/#(?!(amp|quot|lt|gt|35|37|96);)\w+;/.test(inner), "ラベル由来のエンティティ風文字列が残っている: " + inner);
  });
});

test("例外版: 検証に失敗すると IrInputError(errors に一覧)", () => {
  assert.throws(
    () => parseFlowchartIRInputOrThrow({ nodes: [{ id: "end", kind: "start", label: "x" }] }),
    (e) => e instanceof IrInputError && e.errors.length === 1 && /予約語/.test(e.message),
  );
  assert.throws(() => irInputToMermaid("{"), IrInputError);
});

test("JSON Schema(docs/reference/flowchart-ir.schema.json)が実装の定数と一致している", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "docs", "reference", "flowchart-ir.schema.json"), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["edges", "generatedAt", "nodes", "sourceFile"]);
  assert.equal(schema.properties.nodes.maxItems, IR_INPUT_LIMITS.maxNodes);
  assert.equal(schema.properties.edges.maxItems, IR_INPUT_LIMITS.maxEdges);
  assert.equal(schema.$defs.node.properties.id.maxLength, IR_INPUT_LIMITS.maxIdLength);
  assert.deepEqual(schema.$defs.node.properties.kind.enum.slice().sort(), ["decision", "end", "ioOperation", "loop", "process", "start"]);
  assert.deepEqual(Object.keys(schema.$defs.node.properties).sort(), ["id", "kind", "label", "sourceRange"]);
  assert.deepEqual(Object.keys(schema.$defs.edge.properties).sort(), ["from", "label", "to"]);
  assert.equal(schema.$defs.node.additionalProperties, false);
  assert.equal(schema.$defs.edge.additionalProperties, false);
  assert.ok(new RegExp(schema.$defs.node.properties.id.pattern).test("n1"));
  // スキーマの例は、そのまま実装を通る
  for (const ex of schema.examples) assert.equal(parseFlowchartIRInput(ex).ok, true);
});

test("CLI: 正しい JSON は Mermaid を出力、壊れた JSON は終了コード 1 でエラー一覧を標準エラーへ", () => {
  const script = path.join(__dirname, "ir-to-mermaid.js");
  const out = execFileSync(process.execPath, [script], { input: JSON.stringify(good()), encoding: "utf8" });
  assert.match(out, /^flowchart TD/);
  const bad = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ nodes: [{ id: "n1", kind: "start", label: "a" }], edges: [{ from: "n1", to: "zzz" }] }),
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /edges\[0\]\.to: ノード "zzz" は nodes にありません/);
  assert.equal(bad.stdout, "");
});

console.log(`ir-input: ${passed} passed`);
