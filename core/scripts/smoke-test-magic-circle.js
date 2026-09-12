// emitMagicCircle() を if/elseif/else + for + switch 混在のUnity風メソッドで検証する。
// vscode-extension/scripts/smoke-test-scanner.js が使うのと同じ構造のIR
// (controlFlowScanner.tsのヒューリスティック解析結果と同一の14ノード19エッジ)を直接与え、
// 出力JSONを dist に保存する(MagicCircleGeneratorへの手動連携フィクスチャとしても使う)。
const fs = require("fs");
const path = require("path");
const { emitMagicCircle } = require("../dist/render/magic-circle-emitter");
const { validateFlowchartIR } = require("../dist/flowchart-ir/schema");

const ir = {
  sourceFile: "Player.cs",
  generatedAt: new Date().toISOString(),
  nodes: [
    {
      id: "n1",
      kind: "start",
      label: "Update()",
      sourceRange: { startLine: 1, endLine: 1 },
    },
    {
      id: "n2",
      kind: "decision",
      label: "if (isGrounded)",
      sourceRange: { startLine: 2, endLine: 2 },
    },
    {
      id: "n3",
      kind: "process",
      label: "Jump();",
      sourceRange: { startLine: 3, endLine: 3 },
    },
    {
      id: "n4",
      kind: "decision",
      label: "else if (isFalling)",
      sourceRange: { startLine: 4, endLine: 4 },
    },
    {
      id: "n5",
      kind: "process",
      label: "ApplyGravity();",
      sourceRange: { startLine: 5, endLine: 5 },
    },
    {
      id: "n6",
      kind: "process",
      label: "Idle();",
      sourceRange: { startLine: 6, endLine: 6 },
    },
    {
      id: "n7",
      kind: "loop",
      label: "for (int i = 0; i < enemies.Length; i++)",
      sourceRange: { startLine: 7, endLine: 7 },
    },
    {
      id: "n8",
      kind: "decision",
      label: "if (enemies[i].IsDead)",
      sourceRange: { startLine: 8, endLine: 8 },
    },
    {
      id: "n9",
      kind: "process",
      label: "Destroy(enemies[i]);",
      sourceRange: { startLine: 9, endLine: 9 },
    },
    {
      id: "n10",
      kind: "decision",
      label: "switch (state)",
      sourceRange: { startLine: 10, endLine: 10 },
    },
    {
      id: "n11",
      kind: "process",
      label: "PlayIdleAnim(); break;",
      sourceRange: { startLine: 11, endLine: 11 },
    },
    {
      id: "n12",
      kind: "process",
      label: "PlayRunAnim(); break;",
      sourceRange: { startLine: 12, endLine: 12 },
    },
    {
      id: "n13",
      kind: "process",
      label: "PlayDefaultAnim(); break;",
      sourceRange: { startLine: 13, endLine: 13 },
    },
    {
      id: "n14",
      kind: "end",
      label: "End",
      sourceRange: { startLine: 14, endLine: 14 },
    },
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
};

const irErrors = validateFlowchartIR(ir);
if (irErrors.length > 0) {
  console.error("IR検証エラー:", irErrors);
  process.exit(1);
}

const composition = emitMagicCircle(ir);

// 決定論性の検証(仕様8節チェックリスト): 2回変換してバイト同一か確認
const composition2 = emitMagicCircle(ir);
const same = JSON.stringify(composition) === JSON.stringify(composition2);
if (!same) {
  console.error("決定論性検証エラー: 同じIRから異なる出力が生成されました");
  process.exit(1);
}

// start=最外周、end=最内周であることの検証
const layerRadii = composition.rings.filter(
  (r) => r.sourceAssetRef === "flowchart_nodes",
);
const startRing = layerRadii.find((r) =>
  r.proceduralParams.nodes.some((n) => n.kind === "start"),
);
const endRing = layerRadii.find((r) =>
  r.proceduralParams.nodes.some((n) => n.kind === "end"),
);
if (!(startRing.radius > endRing.radius)) {
  console.error(
    `start/end半径検証エラー: start=${startRing.radius}, end=${endRing.radius}`,
  );
  process.exit(1);
}

const threadRing = composition.rings.find(
  (r) => r.sourceAssetRef === "flowchart_threads",
);
const threadStyles = threadRing.proceduralParams.threads.map((t) => t.style);
const hasLoopBack = threadStyles.includes("loopBack");
const hasTrue = threadStyles.includes("trueEdge");
const hasFalse = threadStyles.includes("falseEdge");
const hasPlain = threadStyles.includes("plainEdge");
if (!(hasLoopBack && hasTrue && hasFalse && hasPlain)) {
  console.error(
    "スレッドスタイル検証エラー: 4種類(true/false/plain/loopBack)が揃っていません",
    {
      hasLoopBack,
      hasTrue,
      hasFalse,
      hasPlain,
    },
  );
  process.exit(1);
}

const outDir = path.join(__dirname, "..", "dist", "output");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "sample-magic-circle.json");
fs.writeFileSync(outPath, JSON.stringify(composition, null, 2));

console.log(
  `ノード数: ${ir.nodes.length}, エッジ数: ${ir.edges.length}, リング数: ${composition.rings.length}`,
);
console.log(
  `start半径=${startRing.radius}, end半径=${endRing.radius}(start>endを確認)`,
);
console.log(
  `スレッドスタイル内訳: true=${threadStyles.filter((s) => s === "trueEdge").length}, false=${threadStyles.filter((s) => s === "falseEdge").length}, plain=${threadStyles.filter((s) => s === "plainEdge").length}, loopBack=${threadStyles.filter((s) => s === "loopBack").length}`,
);
console.log(`出力: ${outPath}`);
console.log(
  "\nスモークテストOK: 決定論性・start/end半径・スレッド分類とも仕様通り",
);
