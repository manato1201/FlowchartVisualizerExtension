// controlFlowScannerのヒューリスティック解析を、if/for混在のUnity C#風メソッドで検証する。
const {
  scanControlFlowHeuristic,
} = require("../dist/vscode-extension/src/controlFlowScanner");
const { emitMermaid } = require("../dist/core/render/mermaid-emitter");
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

    switch (state)
    {
        case State.Idle:
            PlayIdleAnim();
            break;
        case State.Run:
            PlayRunAnim();
            break;
        default:
            PlayDefaultAnim();
            break;
    }
}
`;

const { nodes, edges } = scanControlFlowHeuristic(sample, 0, "Update()");
const ir = {
  nodes,
  edges,
  sourceFile: "Sample.cs",
  generatedAt: new Date().toISOString(),
};

const errors = validateFlowchartIR(ir);
console.log(`ノード数: ${nodes.length}, エッジ数: ${edges.length}`);
if (errors.length > 0) {
  console.error("IR検証エラー:", errors);
  process.exit(1);
}

console.log(emitMermaid(ir));
console.log("\nスモークテストOK");
