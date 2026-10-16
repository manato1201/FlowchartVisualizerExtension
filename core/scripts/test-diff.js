// ir-diff(X3)の検証。「変更のない関数が変更ありと誤表示されない」ことが最重要。
const assert = require("node:assert/strict");
const { diffIR, allAdded } = require("../dist/diff/ir-diff");
const { makeSampleIR } = require("./fixtures/sample-ir");

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
const clone = (x) => JSON.parse(JSON.stringify(x));

test("同一IRの比較: 変更なし(hasChanges=false)、全ノード unchanged", () => {
  const r = diffIR(makeSampleIR(), makeSampleIR());
  assert.equal(r.hasChanges, false);
  assert.equal(r.summary.nodesUnchanged, 14);
  assert.equal(r.summary.nodesAdded + r.summary.nodesRemoved + r.summary.nodesChanged, 0);
  assert.equal(r.summary.edgesAdded + r.summary.edgesRemoved, 0);
});

test("行番号がずれただけ・ID採番が違うだけ・空白が違うだけでは「変更あり」にならない", () => {
  const after = makeSampleIR();
  after.nodes.forEach((n) => {
    n.sourceRange = { startLine: n.sourceRange.startLine + 25, endLine: n.sourceRange.endLine + 25 };
  });
  const rename = (id) => "m" + id.slice(1);
  after.nodes.forEach((n) => (n.id = rename(n.id)));
  after.edges.forEach((e) => {
    e.from = rename(e.from);
    e.to = rename(e.to);
  });
  after.nodes[2].label = "Jump();  "; // 末尾の空白
  after.nodes[4].label = "ApplyGravity( );".replace("( )", "()"); // 同一
  const r = diffIR(makeSampleIR(), after);
  assert.equal(r.hasChanges, false);
});

test("文を1つ追加: 追加ノード1つ + 追加エッジ。他は unchanged", () => {
  const after = makeSampleIR();
  after.nodes.splice(3, 0, { id: "n99", kind: "process", label: "Log();", sourceRange: { startLine: 6, endLine: 6 } });
  after.edges = after.edges.filter((e) => !(e.from === "n2" && e.to === "n4"));
  after.edges.push({ from: "n2", to: "n99", label: "false" }, { from: "n99", to: "n4" });
  const r = diffIR(makeSampleIR(), after);
  assert.equal(r.hasChanges, true);
  assert.equal(r.summary.nodesAdded, 1);
  assert.equal(r.summary.nodesRemoved, 0);
  assert.equal(r.summary.nodesChanged, 0);
  assert.equal(r.summary.nodesUnchanged, 14);
  assert.equal(r.summary.edgesAdded, 2);
  assert.equal(r.summary.edgesRemoved, 1);
  assert.equal(r.ir.nodes.find((n) => n.id === "n99").diff, "added");
});

test("文を削除: 削除ノードは rm_ 付きIDで残り、削除エッジが付く", () => {
  const after = makeSampleIR();
  after.nodes = after.nodes.filter((n) => n.id !== "n6");
  after.edges = after.edges.filter((e) => e.from !== "n6" && e.to !== "n6");
  const r = diffIR(makeSampleIR(), after);
  assert.equal(r.summary.nodesRemoved, 1);
  const removed = r.ir.nodes.find((n) => n.diff === "removed");
  assert.equal(removed.id, "rm_n6");
  assert.ok(r.ir.edges.some((e) => e.diff === "removed" && (e.from === "rm_n6" || e.to === "rm_n6")));
  const ids = new Set(r.ir.nodes.map((n) => n.id));
  r.ir.edges.forEach((e) => assert.ok(ids.has(e.from) && ids.has(e.to), `${e.from}>${e.to}`));
});

test("文の書き換え: 同じ kind の置き換えは「変更」(前のラベルを保持)", () => {
  const after = makeSampleIR();
  after.nodes.find((n) => n.id === "n5").label = "ApplyGravity(2.0f);";
  const r = diffIR(makeSampleIR(), after);
  assert.equal(r.summary.nodesChanged, 1);
  assert.equal(r.summary.nodesAdded + r.summary.nodesRemoved, 0);
  const ch = r.ir.nodes.find((n) => n.diff === "changed");
  assert.equal(ch.label, "ApplyGravity(2.0f);");
  assert.equal(ch.previousLabel, "ApplyGravity();");
  assert.equal(r.summary.edgesAdded + r.summary.edgesRemoved, 0, "ラベル変更だけならエッジは変わらない");
});

test("分岐先の付け替え: ノードは同じでもエッジの差分として検出される", () => {
  const after = makeSampleIR();
  const e = after.edges.find((x) => x.from === "n4" && x.to === "n6");
  e.to = "n5"; // false の行き先を変更
  const r = diffIR(makeSampleIR(), after);
  assert.equal(r.hasChanges, true);
  assert.equal(r.summary.nodesChanged + r.summary.nodesAdded + r.summary.nodesRemoved, 0);
  assert.equal(r.summary.edgesAdded, 1);
  assert.equal(r.summary.edgesRemoved, 1);
});

test("新規関数(変更前なし)はすべて追加", () => {
  const r = allAdded(makeSampleIR());
  assert.equal(r.summary.nodesAdded, 14);
  assert.equal(r.summary.edgesAdded, 19);
  assert.ok(r.ir.nodes.every((n) => n.diff === "added"));
});

test("空のIR同士・片方が空でも落ちない", () => {
  const empty = { nodes: [], edges: [], sourceFile: "x", generatedAt: "t" };
  assert.equal(diffIR(empty, empty).hasChanges, false);
  assert.equal(diffIR(empty, makeSampleIR()).summary.nodesAdded, 14);
  assert.equal(diffIR(makeSampleIR(), empty).summary.nodesRemoved, 14);
});

test("入力IRを破壊しない", () => {
  const a = makeSampleIR();
  const b = makeSampleIR();
  b.nodes[2].label = "Jump2();";
  const a0 = clone(a);
  const b0 = clone(b);
  diffIR(a, b);
  assert.deepEqual(a, a0);
  assert.deepEqual(b, b0);
});

console.log(`diff: ${passed} passed`);
