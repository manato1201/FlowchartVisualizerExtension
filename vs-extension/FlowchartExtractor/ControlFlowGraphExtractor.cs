using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FlowAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace FlowchartVisualizer.Extractor;

/// <summary>
/// Roslynが標準提供する制御フローグラフAPI(<see cref="ControlFlowGraph.Create"/>)を用いた
/// 第一候補の抽出経路。BasicBlock単位でFlowchartNodeへ、
/// ConditionalSuccessor/FallThroughSuccessorをFlowchartEdgeへマッピングする。
///
/// 設計書の注記どおり、これが本設計最大の不確実性(実運用での網羅性が未検証なAPI)の
/// スパイク対象。LINQクエリ式・ローカル関数を含む複雑な制御フロー等で
/// <see cref="ControlFlowGraph.Create"/>が例外を投げる、またはnullを返す場合は
/// <see cref="TryExtract"/>がnullを返し、呼び出し側はSyntaxWalkerフォールバックへ切り替える。
/// </summary>
public static class ControlFlowGraphExtractor
{
    public static FlowchartIR? TryExtract(MethodDeclarationSyntax method, SemanticModel model, string sourceFile)
    {
        var operation = model.GetOperation(method);

        ControlFlowGraph? cfg = operation switch
        {
            IMethodBodyOperation methodBody => SafeCreate(() => ControlFlowGraph.Create(methodBody)),
            IBlockOperation block => SafeCreate(() => ControlFlowGraph.Create(block)),
            _ => null,
        };

        if (cfg is null) return null;

        return MapCfgToIR(cfg, method, sourceFile);
    }

    private static ControlFlowGraph? SafeCreate(Func<ControlFlowGraph> factory)
    {
        try
        {
            return factory();
        }
        catch (Exception)
        {
            // ControlFlowGraphが扱いにくいケース(未対応の構文形状等)では
            // 例外を握りつぶし、呼び出し側にフォールバックの判断を委ねる。
            return null;
        }
    }

    private static FlowchartIR MapCfgToIR(ControlFlowGraph cfg, MethodDeclarationSyntax method, string sourceFile)
    {
        var allocator = new NodeIdAllocator();
        var nodes = new List<FlowchartNode>();
        var edges = new List<FlowchartEdge>();
        var blockIds = new string[cfg.Blocks.Length];

        foreach (var block in cfg.Blocks)
        {
            var kind = ClassifyBlock(block);
            var label = DescribeBlock(block, method);
            var line = GetLine(block, method);
            var id = allocator.Next();
            blockIds[block.Ordinal] = id;
            nodes.Add(new FlowchartNode(id, kind, label, new SourceRange(line, line)));
        }

        foreach (var block in cfg.Blocks)
        {
            var fromId = blockIds[block.Ordinal];

            if (block.ConditionalSuccessor is { Destination: not null } condBranch)
            {
                var label = block.ConditionKind == ControlFlowConditionKind.WhenTrue ? "true" : "false";
                edges.Add(new FlowchartEdge(fromId, blockIds[condBranch.Destination.Ordinal], label));
            }

            if (block.FallThroughSuccessor is { Destination: not null } fallBranch)
            {
                string? label = block.ConditionKind switch
                {
                    ControlFlowConditionKind.WhenTrue => "false",
                    ControlFlowConditionKind.WhenFalse => "true",
                    _ => null,
                };
                edges.Add(new FlowchartEdge(fromId, blockIds[fallBranch.Destination.Ordinal], label));
            }
        }

        return new FlowchartIR(nodes, edges, sourceFile, DateTime.UtcNow.ToString("o"));
    }

    private static NodeKind ClassifyBlock(BasicBlock block)
    {
        if (block.Kind == BasicBlockKind.Entry) return NodeKind.Start;
        if (block.Kind == BasicBlockKind.Exit) return NodeKind.End;
        return block.ConditionKind != ControlFlowConditionKind.None ? NodeKind.Decision : NodeKind.Process;
    }

    private static string DescribeBlock(BasicBlock block, MethodDeclarationSyntax method)
    {
        if (block.Kind == BasicBlockKind.Entry) return method.Identifier.Text + "()";
        if (block.Kind == BasicBlockKind.Exit) return "End";

        if (block.BranchValue is { Syntax: { } conditionSyntax })
        {
            return Truncate(conditionSyntax.ToString());
        }

        if (block.Operations.Length > 0)
        {
            var text = string.Join(" ", block.Operations.Select(op => op.Syntax.ToString()));
            return Truncate(text);
        }

        return "(処理なし)";
    }

    private static int GetLine(BasicBlock block, MethodDeclarationSyntax method)
    {
        if (block.Kind == BasicBlockKind.Entry)
        {
            return method.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
        }
        if (block.Kind == BasicBlockKind.Exit)
        {
            return method.GetLocation().GetLineSpan().EndLinePosition.Line + 1;
        }
        if (block.BranchValue?.Syntax is { } conditionSyntax)
        {
            return conditionSyntax.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
        }
        if (block.Operations.Length > 0)
        {
            return block.Operations[0].Syntax.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
        }
        return method.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
    }

    private static string Truncate(string s, int max = 60)
    {
        var oneLine = string.Join(" ", s.Split(new[] { ' ', '\t', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries));
        return oneLine.Length > max ? oneLine.Substring(0, max - 1) + "…" : oneLine;
    }
}
