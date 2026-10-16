// views.js(ビュー切替・Mermaid生成)と TS 版 emitMermaid の整合を検証する。
const assert = require("node:assert/strict");
const Views = require("../webview-bundle/views.js");
const { emitMermaid: emitTs } = require("../dist/render/mermaid-emitter");
const { makeSampleIR, makeLargeIR } = require("./fixtures/sample-ir");

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

const ir = makeSampleIR();

test("フロービューは TS 版 emitMermaid とバイト同一(3エミッター共通の決めごと表)", () => {
  assert.equal(Views.emitMermaid(ir, { view: "flow" }), emitTs(ir));
});

test("図形の決めごと表: 開始/終了=角丸 / 処理=長方形 / 分岐=ひし形 / 繰り返し=六角形", () => {
  const text = Views.emitMermaid(ir);
  assert.match(text, /n1\("Update\(\)"\)/);
  assert.match(text, /n14\("End"\)/);
  assert.match(text, /n3\["Jump\(\);"\]/);
  assert.match(text, /n2\{"if \(isGrounded\)"\}/);
  assert.match(text, /n7\{\{"for /);
});

test("3ビューとも、表示ノード数 = その kind 条件に合う IR ノード数(整合)", () => {
  for (const id of Views.VIEW_ORDER) {
    const p = Views.projectView(ir, id);
    assert.equal(p.nodes.length, Views.countVisible(ir, id), id);
  }
  assert.equal(Views.projectView(ir, "flow").nodes.length, ir.nodes.length);
  // 状態: start/end/decision/loop = 1 + 1 + 4 + 1
  assert.equal(Views.projectView(ir, "state").nodes.length, 7);
  // 呼び出し: start/end + 呼び出しらしい process(x = 1; は除外) = 2 + 6
  assert.equal(Views.projectView(ir, "calls").nodes.length, 8);
});

test("射影後のエッジは必ず表示中のノードを指す(宙に浮いたエッジなし・自己ループなし・重複なし)", () => {
  for (const id of Views.VIEW_ORDER) {
    const p = Views.projectView(ir, id);
    const ids = new Set(p.nodes.map((n) => n.id));
    const keys = new Set();
    for (const e of p.edges) {
      assert.ok(ids.has(e.from) && ids.has(e.to), `${id}: ${e.from}>${e.to}`);
      assert.notEqual(e.from, e.to, `${id}: self loop`);
      const k = `${e.from}>${e.to}>${e.label || ""}`;
      assert.ok(!keys.has(k), `${id}: duplicate ${k}`);
      keys.add(k);
    }
  }
});

test("状態ビューでも分岐の true/false ラベルが残る(意味が消えない)", () => {
  const p = Views.projectView(ir, "state");
  const fromN2 = p.edges
    .filter((e) => e.from === "n2")
    .map((e) => e.label)
    .sort();
  // n2 -true-> n3(隠れる) -> n7 ,  n2 -false-> n4(見える)
  assert.deepEqual(fromN2, ["false", "true"]);
});

test("状態ビューから start→end まで辿れる(切れていない)", () => {
  const p = Views.projectView(ir, "state");
  const out = new Map();
  p.edges.forEach((e) => out.set(e.from, [...(out.get(e.from) || []), e.to]));
  const seen = new Set(["n1"]);
  const q = ["n1"];
  while (q.length) {
    for (const t of out.get(q.shift()) || []) {
      if (!seen.has(t)) {
        seen.add(t);
        q.push(t);
      }
    }
  }
  assert.ok(seen.has("n14"));
});

test('ラベルの < > " はエンティティ化される(i<n がタグとして消えない)', () => {
  const t = Views.emitMermaid({
    ...ir,
    nodes: ir.nodes.map((n) => (n.id === "n7" ? { ...n, label: 'for (i=0;i<n;i++) "x"' } : n)),
  });
  assert.match(t, /i#lt;n/);
  assert.match(t, /#quot;x#quot;/);
  assert.ok(!/i<n/.test(t));
});

test("行番号の併記・ラベル切り詰めは Webview 用オプションでのみ有効", () => {
  const t = Views.emitMermaid(ir, { lineNumbers: true, maxLabel: 12 });
  assert.match(t, /n2\{"if \(isGroun…<br\/>L3"\}/);
  assert.ok(!/<br\/>L/.test(Views.emitMermaid(ir)), "既定ではコピー用に行番号を入れない");
});

test("差分: classDef / linkStyle は diff があるときだけ出る", () => {
  assert.ok(!/classDef/.test(Views.emitMermaid(ir)));
  const d = JSON.parse(JSON.stringify(ir));
  d.nodes[2].diff = "added";
  d.nodes[3].diff = "removed";
  d.nodes[4].diff = "changed";
  d.edges[1].diff = "added";
  d.edges[2].diff = "removed";
  const t = Views.emitMermaid(d);
  assert.match(t, /classDef diffAdded stroke:#2ea043/);
  assert.match(t, /class n3 diffAdded/);
  assert.match(t, /class n4 diffRemoved/);
  assert.match(t, /class n5 diffChanged/);
  assert.match(t, /linkStyle 1 stroke:#2ea043/);
  assert.match(t, /linkStyle 2 stroke:#f85149,stroke-width:2px,stroke-dasharray:5 3/);
});

test("実行順: start から辿り、戻りエッジを含まない(必ず終わる)", () => {
  const order = Views.executionOrder(ir);
  assert.equal(order[0].from, "n1");
  assert.ok(!order.some((e) => e.from === "n9" && e.to === "n7"), "n9→n7 は戻りエッジ");
  assert.ok(!order.some((e) => e.from === "n8" && e.to === "n7"), "n8→n7 は戻りエッジ");
  assert.ok(order.length < ir.edges.length);
});

test("1,000ノード級のIRでもビュー変換とMermaid生成が速い(< 300ms)", () => {
  const big = makeLargeIR(1000);
  const t0 = Date.now();
  for (const id of Views.VIEW_ORDER) Views.emitMermaid(big, { view: id, lineNumbers: true });
  const ms = Date.now() - t0;
  assert.ok(big.nodes.length >= 999);
  assert.ok(ms < 300, `took ${ms}ms`);
});

test("未知のビューIDは例外", () => {
  assert.throws(() => Views.projectView(ir, "nope"), /unknown view/);
});

console.log(`views: ${passed} passed`);
