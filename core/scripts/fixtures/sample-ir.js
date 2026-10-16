// テスト共通のサンプルIR。vscode-extension の controlFlowScanner が
// Unity風 Update() に対して出力する構造と同じ(14ノード/19エッジ)。
// sourceRange は 1 始まり。
const L = (n) => ({ startLine: n, endLine: n });

function makeSampleIR(overrides = {}) {
  return {
    sourceFile: "Player.cs",
    generatedAt: "2026-10-17T00:00:00.000Z",
    nodes: [
      { id: "n1", kind: "start", label: "Update()", sourceRange: L(1) },
      {
        id: "n2",
        kind: "decision",
        label: "if (isGrounded)",
        sourceRange: L(3),
      },
      { id: "n3", kind: "process", label: "Jump();", sourceRange: L(5) },
      {
        id: "n4",
        kind: "decision",
        label: "else if (isFalling)",
        sourceRange: L(7),
      },
      {
        id: "n5",
        kind: "process",
        label: "ApplyGravity();",
        sourceRange: L(9),
      },
      { id: "n6", kind: "process", label: "Idle();", sourceRange: L(13) },
      {
        id: "n7",
        kind: "loop",
        label: "for (int i = 0; i < enemies.Length; i++)",
        sourceRange: L(16),
      },
      {
        id: "n8",
        kind: "decision",
        label: "if (enemies[i].IsDead)",
        sourceRange: L(18),
      },
      {
        id: "n9",
        kind: "process",
        label: "Destroy(enemies[i]);",
        sourceRange: L(20),
      },
      {
        id: "n10",
        kind: "decision",
        label: "switch (state)",
        sourceRange: L(24),
      },
      {
        id: "n11",
        kind: "process",
        label: "PlayIdleAnim(); break;",
        sourceRange: L(27),
      },
      {
        id: "n12",
        kind: "process",
        label: "PlayRunAnim(); break;",
        sourceRange: L(30),
      },
      { id: "n13", kind: "process", label: "x = 1;", sourceRange: L(33) },
      { id: "n14", kind: "end", label: "End", sourceRange: L(36) },
    ],
    edges: [
      { from: "n1", to: "n2" },
      { from: "n2", to: "n3", label: "true" },
      { from: "n2", to: "n4", label: "false" },
      { from: "n4", to: "n5", label: "true" },
      { from: "n4", to: "n6", label: "false" },
      { from: "n3", to: "n7" },
      { from: "n5", to: "n7" },
      { from: "n6", to: "n7" },
      { from: "n7", to: "n8", label: "true" },
      { from: "n8", to: "n9", label: "true" },
      { from: "n9", to: "n7" },
      { from: "n8", to: "n7" },
      { from: "n7", to: "n10" },
      { from: "n10", to: "n11" },
      { from: "n10", to: "n12" },
      { from: "n10", to: "n13" },
      { from: "n11", to: "n14" },
      { from: "n12", to: "n14" },
      { from: "n13", to: "n14" },
    ],
    ...overrides,
  };
}

/** 大きな関数の負荷試験用: ブロックを繰り返して約 count ノードのIRを作る(連結された単一の関数)。 */
function makeLargeIR(count) {
  const nodes = [
    { id: "n1", kind: "start", label: "Big()", sourceRange: L(1) },
  ];
  const edges = [];
  let prev = "n1";
  let next = 2;
  const add = (kind, label) => {
    const id = "n" + next++;
    nodes.push({ id, kind, label, sourceRange: L(next) });
    return id;
  };
  while (nodes.length < count - 1) {
    const d = add("decision", `if (cond${next})`);
    const t = add("process", `DoThing${next}();`);
    const f = add("process", `Other${next}();`);
    const l = add("loop", `for (i${next} = 0; i${next} < n; i${next}++)`);
    const b = add("process", `Body${next}();`);
    edges.push(
      { from: prev, to: d },
      { from: d, to: t, label: "true" },
      { from: d, to: f, label: "false" },
    );
    edges.push(
      { from: t, to: l },
      { from: f, to: l },
      { from: l, to: b, label: "true" },
      { from: b, to: l },
    );
    prev = l;
  }
  const end = add("end", "End");
  edges.push({ from: prev, to: end });
  return {
    sourceFile: "Big.cs",
    generatedAt: "2026-10-17T00:00:00.000Z",
    nodes,
    edges,
  };
}

module.exports = { makeSampleIR, makeLargeIR };
