// 実コードテキスト → controlFlowScanner(ヒューリスティック解析) → FlowchartIR →
// emitMagicCircle の一気通貫を検証する(vscode.* APIに依存する部分はここでは通せないため、
// DocumentSymbol解決を除いた「テキスト→IR→魔方陣」の経路のみを対象とする)。
const { scanControlFlowHeuristic } = require("../dist/vscode-extension/src/controlFlowScanner");
const { emitMagicCircle } = require("../dist/core/render/magic-circle-emitter");
const { validateFlowchartIR } = require("../dist/core/flowchart-ir/schema");

const sample = `
void Update()
{
    if (isGrounded)
    {
        Jump();
    }
    else if (isFalling)
    {
        ApplyGravity();
    }
    else
    {
        Idle();
    }

    for (int i = 0; i < enemies.Length; i++)
    {
        if (enemies[i].IsDead)
        {
            Destroy(enemies[i]);
        }
    }
}
`;

const { nodes, edges } = scanControlFlowHeuristic(sample, 0, "Update()");
const ir = { nodes, edges, sourceFile: "Sample.cs", generatedAt: new Date().toISOString() };

const irErrors = validateFlowchartIR(ir);
if (irErrors.length > 0) {
  console.error("IR検証エラー:", irErrors);
  process.exit(1);
}

const composition = emitMagicCircle(ir);
const nodeRings = composition.rings.filter((r) => r.sourceAssetRef === "flowchart_nodes");
const totalNodesPlaced = nodeRings.reduce((sum, r) => sum + r.proceduralParams.nodes.length, 0);

if (totalNodesPlaced !== nodes.length) {
  console.error(`ノード数不一致: IR=${nodes.length}, 配置=${totalNodesPlaced}`);
  process.exit(1);
}

console.log(`実コード(${sample.trim().split("\n").length}行) → ヒューリスティック解析 → FlowchartIR(${nodes.length}ノード/${edges.length}エッジ) → 魔方陣(${composition.rings.length}リング)`);
console.log("スモークテストOK: extension.tsが実行するのと同じ経路(controlFlowScanner→emitMagicCircle)が動作すること確認");
