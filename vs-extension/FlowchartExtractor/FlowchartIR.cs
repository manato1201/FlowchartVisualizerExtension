namespace FlowchartVisualizer.Extractor;

// core/flowchart-ir/schema.ts のC#側ミラー。
// アンチパターン注記の通り、Roslynの型(SyntaxNode/ControlFlowGraph等)はこの層より
// 上(Mermaid変換・Webview側)へ一切漏らさない。ここで定義する型だけが共有コアと等価な
// 意味を持つ、ホスト非依存の中間表現である。

public enum NodeKind
{
    Start,
    End,
    Process,
    Decision,
    Loop,
    IoOperation,
}

public sealed record SourceRange(int StartLine, int EndLine);

public sealed record FlowchartNode(string Id, NodeKind Kind, string Label, SourceRange SourceRange);

public sealed record FlowchartEdge(string From, string To, string? Label = null);

public sealed record FlowchartIR(
    IReadOnlyList<FlowchartNode> Nodes,
    IReadOnlyList<FlowchartEdge> Edges,
    string SourceFile,
    string GeneratedAt
);

/// <summary>FlowchartIRビルダー用の採番ヘルパー。schema.tsのNodeIdAllocatorに対応する。</summary>
public sealed class NodeIdAllocator
{
    private int _counter;

    public string Next() => $"n{++_counter}";
}
