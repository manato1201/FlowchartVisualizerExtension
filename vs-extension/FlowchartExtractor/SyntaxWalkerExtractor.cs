using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace FlowchartVisualizer.Extractor;

/// <summary>
/// <see cref="ControlFlowGraphExtractor"/>が扱いにくいケース(LINQクエリ式やローカル関数を
/// 含む複雑な制御フロー等)に遭遇した場合のフォールバック。従来型のSyntaxWalkerで
/// if/for/while/switchノードを直接ウォークする。
/// </summary>
public static class SyntaxWalkerExtractor
{
    public static FlowchartIR Extract(MethodDeclarationSyntax method, string sourceFile)
    {
        var allocator = new NodeIdAllocator();
        var nodes = new List<FlowchartNode>();
        var edges = new List<FlowchartEdge>();

        var startId = allocator.Next();
        nodes.Add(new FlowchartNode(startId, NodeKind.Start, method.Identifier.Text + "()", LineRangeOf(method)));

        var endId = allocator.Next();
        nodes.Add(new FlowchartNode(endId, NodeKind.End, "End", LineRangeOf(method)));

        var body = method.Body;
        WalkResult result = body is not null
            ? WalkBlock(body.Statements, allocator, nodes, edges)
            : new WalkResult(null, new List<string>());

        if (result.EntryId is not null)
        {
            edges.Add(new FlowchartEdge(startId, result.EntryId));
        }
        else
        {
            edges.Add(new FlowchartEdge(startId, endId));
        }
        foreach (var exitId in result.ExitIds)
        {
            edges.Add(new FlowchartEdge(exitId, endId));
        }

        return new FlowchartIR(nodes, edges, sourceFile, DateTime.UtcNow.ToString("o"));
    }

    private sealed record WalkResult(string? EntryId, List<string> ExitIds);

    private static WalkResult WalkBlock(
        SyntaxList<StatementSyntax> statements,
        NodeIdAllocator allocator,
        List<FlowchartNode> nodes,
        List<FlowchartEdge> edges)
    {
        string? entryId = null;
        var tailIds = new List<string>();

        void Connect(string nodeId)
        {
            entryId ??= nodeId;
            foreach (var t in tailIds) edges.Add(new FlowchartEdge(t, nodeId));
            tailIds = new List<string> { nodeId };
        }

        foreach (var statement in statements)
        {
            switch (statement)
            {
                case IfStatementSyntax ifStatement:
                {
                    var chain = WalkIfChain(ifStatement, allocator, nodes, edges);
                    if (chain.EntryId is not null) Connect(chain.EntryId);
                    tailIds = chain.ExitIds;
                    break;
                }
                case ForStatementSyntax forStatement:
                {
                    var loopId = allocator.Next();
                    nodes.Add(new FlowchartNode(loopId, NodeKind.Loop,
                        Truncate($"for ({forStatement.Condition})"), LineRangeOf(forStatement)));
                    Connect(loopId);
                    WireLoopBody(forStatement.Statement, loopId, allocator, nodes, edges);
                    tailIds = new List<string> { loopId };
                    break;
                }
                case ForEachStatementSyntax forEachStatement:
                {
                    var loopId = allocator.Next();
                    nodes.Add(new FlowchartNode(loopId, NodeKind.Loop,
                        Truncate($"foreach ({forEachStatement.Identifier} in {forEachStatement.Expression})"),
                        LineRangeOf(forEachStatement)));
                    Connect(loopId);
                    WireLoopBody(forEachStatement.Statement, loopId, allocator, nodes, edges);
                    tailIds = new List<string> { loopId };
                    break;
                }
                case WhileStatementSyntax whileStatement:
                {
                    var loopId = allocator.Next();
                    nodes.Add(new FlowchartNode(loopId, NodeKind.Loop,
                        Truncate($"while ({whileStatement.Condition})"), LineRangeOf(whileStatement)));
                    Connect(loopId);
                    WireLoopBody(whileStatement.Statement, loopId, allocator, nodes, edges);
                    tailIds = new List<string> { loopId };
                    break;
                }
                case DoStatementSyntax doStatement:
                {
                    var loopId = allocator.Next();
                    nodes.Add(new FlowchartNode(loopId, NodeKind.Loop,
                        Truncate($"do/while ({doStatement.Condition})"), LineRangeOf(doStatement)));
                    var bodyResult = WalkStatement(doStatement.Statement, allocator, nodes, edges);
                    if (bodyResult.EntryId is not null)
                    {
                        Connect(bodyResult.EntryId);
                        foreach (var exitId in bodyResult.ExitIds) edges.Add(new FlowchartEdge(exitId, loopId));
                    }
                    else
                    {
                        Connect(loopId);
                    }
                    tailIds = new List<string> { loopId };
                    break;
                }
                case SwitchStatementSyntax switchStatement:
                {
                    var switchId = allocator.Next();
                    nodes.Add(new FlowchartNode(switchId, NodeKind.Decision,
                        Truncate($"switch ({switchStatement.Expression})"), LineRangeOf(switchStatement)));
                    Connect(switchId);

                    var caseExits = new List<string>();
                    foreach (var section in switchStatement.Sections)
                    {
                        var caseResult = WalkBlock(section.Statements, allocator, nodes, edges);
                        if (caseResult.EntryId is not null)
                        {
                            edges.Add(new FlowchartEdge(switchId, caseResult.EntryId));
                            caseExits.AddRange(caseResult.ExitIds);
                        }
                    }
                    tailIds = caseExits.Count > 0 ? caseExits : new List<string> { switchId };
                    break;
                }
                case BlockSyntax blockSyntax:
                {
                    var inner = WalkBlock(blockSyntax.Statements, allocator, nodes, edges);
                    if (inner.EntryId is not null) Connect(inner.EntryId);
                    tailIds = inner.ExitIds.Count > 0 ? inner.ExitIds : tailIds;
                    break;
                }
                default:
                {
                    var text = statement.ToString().Trim();
                    if (text.Length == 0) break;
                    var id = allocator.Next();
                    nodes.Add(new FlowchartNode(id, NodeKind.Process, Truncate(text), LineRangeOf(statement)));
                    Connect(id);
                    break;
                }
            }
        }

        return new WalkResult(entryId, tailIds);
    }

    private static void WireLoopBody(
        StatementSyntax bodyStatement,
        string loopId,
        NodeIdAllocator allocator,
        List<FlowchartNode> nodes,
        List<FlowchartEdge> edges)
    {
        var bodyResult = WalkStatement(bodyStatement, allocator, nodes, edges);
        if (bodyResult.EntryId is null) return;

        edges.Add(new FlowchartEdge(loopId, bodyResult.EntryId, "true"));
        foreach (var exitId in bodyResult.ExitIds)
        {
            edges.Add(new FlowchartEdge(exitId, loopId));
        }
    }

    private static WalkResult WalkStatement(
        StatementSyntax statement,
        NodeIdAllocator allocator,
        List<FlowchartNode> nodes,
        List<FlowchartEdge> edges)
    {
        var statements = statement is BlockSyntax block
            ? block.Statements
            : SyntaxFactory.SingletonList(statement);
        return WalkBlock(statements, allocator, nodes, edges);
    }

    private static WalkResult WalkIfChain(
        IfStatementSyntax ifStatement,
        NodeIdAllocator allocator,
        List<FlowchartNode> nodes,
        List<FlowchartEdge> edges)
    {
        var decisionId = allocator.Next();
        nodes.Add(new FlowchartNode(decisionId, NodeKind.Decision,
            Truncate($"if ({ifStatement.Condition})"), LineRangeOf(ifStatement)));

        var exitIds = new List<string>();

        var thenResult = WalkStatement(ifStatement.Statement, allocator, nodes, edges);
        if (thenResult.EntryId is not null)
        {
            edges.Add(new FlowchartEdge(decisionId, thenResult.EntryId, "true"));
            exitIds.AddRange(thenResult.ExitIds);
        }
        else
        {
            exitIds.Add(decisionId);
        }

        if (ifStatement.Else is { } elseClause)
        {
            if (elseClause.Statement is IfStatementSyntax nestedIf)
            {
                var nested = WalkIfChain(nestedIf, allocator, nodes, edges);
                if (nested.EntryId is not null)
                {
                    edges.Add(new FlowchartEdge(decisionId, nested.EntryId, "false"));
                }
                exitIds.AddRange(nested.ExitIds);
            }
            else
            {
                var elseResult = WalkStatement(elseClause.Statement, allocator, nodes, edges);
                if (elseResult.EntryId is not null)
                {
                    edges.Add(new FlowchartEdge(decisionId, elseResult.EntryId, "false"));
                    exitIds.AddRange(elseResult.ExitIds);
                }
                else
                {
                    exitIds.Add(decisionId);
                }
            }
        }
        else
        {
            exitIds.Add(decisionId);
        }

        return new WalkResult(decisionId, exitIds);
    }

    private static SourceRange LineRangeOf(SyntaxNode node)
    {
        var span = node.GetLocation().GetLineSpan();
        return new SourceRange(span.StartLinePosition.Line + 1, span.EndLinePosition.Line + 1);
    }

    private static string Truncate(string s, int max = 60)
    {
        var oneLine = string.Join(" ", s.Split(new[] { ' ', '\t', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries));
        return oneLine.Length > max ? oneLine.Substring(0, max - 1) + "…" : oneLine;
    }
}
