using System.Text.Json;
using Xunit;

namespace FlowchartVisualizer.Extractor.Tests;

/// <summary>
/// IrJson が core/flowchart-ir/schema.ts と同じ形のJSONを出すこと。共有Webviewバンドル(views.js)は
/// この形をそのまま読むため、名前や省略の違いは画面が出ない不具合になる。
/// </summary>
public class IrJsonTests
{
    private static FlowchartIR Sample() => new(
        new[]
        {
            new FlowchartNode("n1", NodeKind.Start, "Update()", new SourceRange(1, 1)),
            new FlowchartNode("n2", NodeKind.Decision, "if (a < b && \"x\")", new SourceRange(3, 3)),
            new FlowchartNode("n3", NodeKind.IoOperation, "Console.WriteLine(\"日本語\\n\");", new SourceRange(5, 5)),
            new FlowchartNode("n4", NodeKind.Loop, "for", new SourceRange(7, 7)),
            new FlowchartNode("n5", NodeKind.End, "End", new SourceRange(9, 9)),
        },
        new[]
        {
            new FlowchartEdge("n1", "n2"),
            new FlowchartEdge("n2", "n3", "true"),
            new FlowchartEdge("n2", "n5", "false"),
        },
        "Player.cs",
        "2026-10-17T00:00:00.0000000Z");

    [Fact]
    public void Serialize_ProducesTheSharedSchemaShape()
    {
        using var doc = JsonDocument.Parse(IrJson.Serialize(Sample()));
        var root = doc.RootElement;

        Assert.Equal("Player.cs", root.GetProperty("sourceFile").GetString());
        var nodes = root.GetProperty("nodes");
        Assert.Equal(5, nodes.GetArrayLength());
        Assert.Equal(
            new[] { "start", "decision", "ioOperation", "loop", "end" },
            nodes.EnumerateArray().Select(n => n.GetProperty("kind").GetString()).ToArray());
        Assert.Equal(3, nodes[1].GetProperty("sourceRange").GetProperty("startLine").GetInt32());
    }

    [Fact]
    public void Serialize_KeepsLabelsExactly_IncludingQuotesBackslashesAndUnicode()
    {
        using var doc = JsonDocument.Parse(IrJson.Serialize(Sample()));
        var nodes = doc.RootElement.GetProperty("nodes");
        Assert.Equal("if (a < b && \"x\")", nodes[1].GetProperty("label").GetString());
        Assert.Equal("Console.WriteLine(\"日本語\\n\");", nodes[2].GetProperty("label").GetString());
    }

    [Fact]
    public void Serialize_OmitsEmptyEdgeLabels_AndKeepsTrueFalse()
    {
        using var doc = JsonDocument.Parse(IrJson.Serialize(Sample()));
        var edges = doc.RootElement.GetProperty("edges");
        Assert.False(edges[0].TryGetProperty("label", out _));
        Assert.Equal("true", edges[1].GetProperty("label").GetString());
        Assert.Equal("false", edges[2].GetProperty("label").GetString());
    }

    [Fact]
    public void Serialize_EscapesControlCharacters()
    {
        var ir = new FlowchartIR(
            new[] { new FlowchartNode("n1", NodeKind.Process, "a\tb\u0001c", new SourceRange(1, 1)) },
            Array.Empty<FlowchartEdge>(), "f.cs", "t");
        using var doc = JsonDocument.Parse(IrJson.Serialize(ir));
        Assert.Equal("a\tb\u0001c", doc.RootElement.GetProperty("nodes")[0].GetProperty("label").GetString());
    }

    [Fact]
    public void MermaidEmitter_UsesTheSharedShapeTableAndEscaping()
    {
        // core/render/mermaid-emitter.ts と同じ決めごと表・エスケープ(3ホストでバイト同一の出力)
        var text = MermaidEmitter.Emit(Sample());
        Assert.Contains("n1(\"Update()\")", text);
        Assert.Contains("n2{\"if (a #lt; b #amp;#amp; #quot;x#quot;)\"}", text);
        Assert.Contains("n3[/", text);
        Assert.Contains("n4{{\"for\"}}", text);
        Assert.Contains("n2 -->|true| n3", text);
    }
}
