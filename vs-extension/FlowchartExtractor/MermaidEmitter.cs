using System.Text;

namespace FlowchartVisualizer.Extractor;

/// <summary>
/// core/render/mermaid-emitter.ts の移植。アルゴリズムはTS版と完全に同一に保つこと。
/// (3ホストが同じ合成コードから構造的に同じMermaid出力を得られることが検証基準のため)
/// </summary>
public static class MermaidEmitter
{
    private static readonly Dictionary<NodeKind, (string Open, string Close)> Shape = new()
    {
        // 図形の決めごと表(core/render/mermaid-emitter.ts と同一): 開始/終了=角丸、
        // 処理=長方形、分岐=ひし形、繰り返し=六角形。
        [NodeKind.Start] = ("(", ")"),
        [NodeKind.End] = ("(", ")"),
        [NodeKind.Process] = ("[", "]"),
        [NodeKind.Decision] = ("{", "}"),
        [NodeKind.Loop] = ("{{", "}}"),
        [NodeKind.IoOperation] = ("[/", "/]"),
    };

    public static string Emit(FlowchartIR ir)
    {
        var sb = new StringBuilder();
        sb.AppendLine("flowchart TD");

        foreach (var n in ir.Nodes)
        {
            var (open, close) = Shape[n.Kind];
            sb.AppendLine($"  {n.Id}{open}\"{EscapeLabel(n.Label)}\"{close}");
        }

        foreach (var e in ir.Edges)
        {
            var arrow = string.IsNullOrEmpty(e.Label) ? "-->" : $"-->|{e.Label}|";
            sb.AppendLine($"  {e.From} {arrow} {e.To}");
        }

        return sb.ToString().TrimEnd('\n', '\r');
    }

    // Mermaidのエンティティ記法(core/render/mermaid-emitter.ts と同一)。
    private static string EscapeLabel(string label) =>
        label.Replace("&", "#amp;").Replace("\"", "#quot;").Replace("<", "#lt;").Replace(">", "#gt;").Replace("\n", "<br/>");
}
