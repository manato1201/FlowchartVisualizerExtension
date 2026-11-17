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

/** ちょうど n ノードの直線のIR(start → process … → end)。 */
function lineIR(n) {
  const nodes = [];
  const edges = [];
  for (let i = 1; i <= n; i++) {
    const kind = i === 1 ? "start" : i === n ? "end" : i % 3 === 0 ? "decision" : "process";
    nodes.push({ id: "n" + i, kind, label: "x" + i, sourceRange: { startLine: i, endLine: i } });
    if (i > 1) edges.push({ from: "n" + (i - 1), to: "n" + i });
  }
  return { nodes, edges, sourceFile: "x", generatedAt: "t" };
}

test("ノード数ガード: しきい値(RENDER_NODE_LIMIT=300)ちょうどは要約しない。301 から要約(状態ビュー)に切り替える", () => {
  assert.equal(Views.RENDER_NODE_LIMIT, 300);
  const at = Views.planRender(lineIR(300), "flow");
  assert.equal(at.guarded, false);
  assert.equal(at.view, "flow");
  assert.equal(at.heavy, false);
  const over = Views.planRender(lineIR(301), "flow");
  assert.equal(over.guarded, true);
  assert.equal(over.view, "state");
  assert.equal(over.requestedCount, 301);
  assert.ok(over.shown < 301, "要約で減っている: " + over.shown);
  assert.equal(over.shown, Views.countVisible(lineIR(301), "state"));
});

test("ノード数ガード: 利用者が全体を求めたとき(force)・状態ビューを選んだときは書き換えない。要約しても多ければ heavy", () => {
  const big = lineIR(450);
  const forced = Views.planRender(big, "flow", { force: true });
  assert.equal(forced.view, "flow");
  assert.equal(forced.guarded, false);
  assert.equal(forced.heavy, true, "全体を描くと重いことは分かる");
  assert.equal(Views.planRender(big, "state").guarded, false, "もう要約を選んでいる");
  // 呼び出しビューが 300 以下なら、そのまま描く
  const calls = Views.planRender(big, "calls");
  assert.equal(calls.guarded, calls.requestedCount > 300);
  // 未知のビューは flow 扱い
  assert.equal(Views.planRender(big, "nope").requested, "flow");
  // 要約しても 300 を超える(分岐・ループだらけ)なら heavy
  const dense = lineIR(1200);
  dense.nodes.forEach((n, i) => i % 2 === 0 && i > 0 && i < 1199 && (n.kind = "loop"));
  assert.equal(Views.planRender(dense, "flow").heavy, true);
});

test("ノード数ガード: 所要時間の目安は実測(282 ノード≒1.0 秒・562 ノード≒3.2 秒)に合う近似で、増える一方", () => {
  assert.ok(Math.abs(Views.estimateRenderSeconds(282) - 1) < 0.05);
  assert.ok(Math.abs(Views.estimateRenderSeconds(562) - 3.2) < 0.4);
  assert.ok(Views.estimateRenderSeconds(600) > Views.estimateRenderSeconds(300));
});

test("ノード数ガードで IR は壊さない(plan は入力を変更しない)", () => {
  const big = lineIR(400);
  const before = JSON.stringify(big);
  Views.planRender(big, "flow");
  assert.equal(JSON.stringify(big), before);
});

test("折り返し: 幅ごとに分け、文字は増減しない。長い語は途中で分ける。全角は幅2。改行は保つ", () => {
  const text = "for (int i = 0; i < enemies.Length; i++)";
  const lines = Views.wrapLabel(text, 20);
  assert.ok(lines.length >= 2);
  assert.equal(lines.join(""), text, "折り返しで文字が消えない");
  assert.ok(lines.every((l) => l.length <= 20), JSON.stringify(lines));
  const longWord = Views.wrapLabel("a".repeat(50), 20);
  assert.deepEqual(longWord.map((l) => l.length), [20, 20, 10]);
  const jp = Views.wrapLabel("日本語のとても長いラベルを折り返す", 20);
  assert.ok(jp.every((l) => l.length <= 10), "全角は 10 文字(幅 20)まで: " + JSON.stringify(jp));
  assert.deepEqual(Views.wrapLabel("a\nb", 20), ["a", "b"]);
  assert.deepEqual(Views.wrapLabel("", 20), [""]);
});

test("折り返しは wrap オプションでのみ有効(既定の出力は TS 版とバイト同一のまま)。折った行は <br/> で結び、特殊文字はエスケープされる", () => {
  assert.equal(Views.emitMermaid(ir, { view: "flow" }), emitTs(ir));
  const long = JSON.parse(JSON.stringify(ir));
  long.nodes[1].label = "if (a < b && c > d || somethingElse)";
  const t = Views.emitMermaid(long, { wrap: 14 });
  const line = t.split("\n").find((l) => l.startsWith("  n2"));
  assert.match(line, /<br\/>/, "折り返した行は <br/> で結ぶ");
  assert.match(line, /#lt;/);
  assert.match(line, /#amp;#amp;/);
  assert.ok(!/[<>]/.test(line.replace(/<br\/>/g, "")), "生の < > が残らない: " + line);
});

test("未知のビューIDは例外", () => {
  assert.throws(() => Views.projectView(ir, "nope"), /unknown view/);
});

console.log(`views: ${passed} passed`);
