using Xunit;
using Xunit.Abstractions;

namespace FlowchartVisualizer.Extractor.Tests;

/// <summary>
/// design doc Phase3の「最大の不確実性」であるRoslyn ControlFlowGraph APIのスパイク検証。
/// Unity MonoBehaviourの典型パターン(Update内のif/for混在)で
/// ControlFlowGraph.Create()が実際に動作するかをここで確定させる。
/// </summary>
public class RoslynCfgSpikeTests
{
    private readonly ITestOutputHelper _output;

    public RoslynCfgSpikeTests(ITestOutputHelper output) => _output = output;

    private const string UnityLikeSource = """
        using System.Collections.Generic;

        public class Player
        {
            private bool isGrounded;
            private bool isFalling;
            private List<int> enemies = new List<int>();
            private int state;

            public void Update()
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

                for (int i = 0; i < enemies.Count; i++)
                {
                    if (enemies[i] < 0)
                    {
                        Destroy(i);
                    }
                }

                switch (state)
                {
                    case 0:
                        PlayIdleAnim();
                        break;
                    case 1:
                        PlayRunAnim();
                        break;
                    default:
                        PlayDefaultAnim();
                        break;
                }
            }

            private void Jump() { }
            private void ApplyGravity() { }
            private void Idle() { }
            private void Destroy(int i) { }
            private void PlayIdleAnim() { }
            private void PlayRunAnim() { }
            private void PlayDefaultAnim() { }
        }
        """;

    [Fact]
    public void ControlFlowGraph_Handles_UnityLikeUpdateMethod()
    {
        var (method, model) = CompilationHelper.CompileFirstMethod(UnityLikeSource, "Update");

        var result = ControlFlowGraphExtractor.TryExtract(method, model, "Player.cs");

        // スパイク結果の記録: nullなら「実運用ケースでCFG APIが使えなかった」ことを意味し、
        // Phase3の実装方針をSyntaxWalker全面採用に倒す判断材料になる。
        Assert.NotNull(result);
        Assert.True(result!.Nodes.Count > 0, "CFGからノードが1つも生成されなかった");
        Assert.True(result.Edges.Count > 0, "CFGからエッジが1つも生成されなかった");

        var mermaid = MermaidEmitter.Emit(result);
        _output.WriteLine($"[Roslyn CFG] nodes={result.Nodes.Count} edges={result.Edges.Count}");
        _output.WriteLine(mermaid);

        Assert.Contains("flowchart TD", mermaid);
    }

    [Fact]
    public void FlowchartExtractor_PrefersControlFlowGraph_ForUnityLikeMethod()
    {
        var (method, model) = CompilationHelper.CompileFirstMethod(UnityLikeSource, "Update");

        var extractor = new FlowchartExtractor();
        var result = extractor.Extract(method, model, "Player.cs");

        _output.WriteLine($"採用された抽出戦略: {result.Strategy}");

        // 採用可否の記録: ControlFlowGraphが使えればそちらが優先されるはず。
        Assert.Equal(ExtractionStrategy.ControlFlowGraph, result.Strategy);
    }

    [Fact]
    public void SyntaxWalkerFallback_ProducesStructurallyEquivalentGraph()
    {
        var (method, _) = CompilationHelper.CompileFirstMethod(UnityLikeSource, "Update");

        var fallbackResult = SyntaxWalkerExtractor.Extract(method, "Player.cs");

        Assert.True(fallbackResult.Nodes.Count > 0);
        Assert.True(fallbackResult.Edges.Count > 0);

        var mermaid = MermaidEmitter.Emit(fallbackResult);
        _output.WriteLine($"[SyntaxWalker] nodes={fallbackResult.Nodes.Count} edges={fallbackResult.Edges.Count}");
        _output.WriteLine(mermaid);

        Assert.Contains("flowchart TD", mermaid);
    }
}
