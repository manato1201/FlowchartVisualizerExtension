using System.Globalization;
using System.Text;

namespace FlowchartVisualizer.Extractor;

/// <summary>
/// FlowchartIR を core/flowchart-ir/schema.ts と同じ形のJSONにする(共有Webviewバンドルへ渡す形式)。
/// 依存ライブラリを増やさないよう手書き(net472 の VSIX・net8.0 のテストの両方で同じコードが動く)。
/// 種別は schema.ts の NodeKind と同じ文字列("start" "ioOperation" 等)、null のラベルは出力しない。
/// </summary>
public static class IrJson
{
    public static string KindName(NodeKind kind) => kind switch
    {
        NodeKind.Start => "start",
        NodeKind.End => "end",
        NodeKind.Process => "process",
        NodeKind.Decision => "decision",
        NodeKind.Loop => "loop",
        NodeKind.IoOperation => "ioOperation",
        _ => "process",
    };

    public static string Serialize(FlowchartIR ir)
    {
        var sb = new StringBuilder();
        sb.Append("{\"nodes\":[");
        for (var i = 0; i < ir.Nodes.Count; i++)
        {
            var n = ir.Nodes[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"id\":").Append(Str(n.Id))
              .Append(",\"kind\":").Append(Str(KindName(n.Kind)))
              .Append(",\"label\":").Append(Str(n.Label))
              .Append(",\"sourceRange\":{\"startLine\":").Append(Num(n.SourceRange.StartLine))
              .Append(",\"endLine\":").Append(Num(n.SourceRange.EndLine)).Append("}}");
        }
        sb.Append("],\"edges\":[");
        for (var i = 0; i < ir.Edges.Count; i++)
        {
            var e = ir.Edges[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"from\":").Append(Str(e.From)).Append(",\"to\":").Append(Str(e.To));
            if (!string.IsNullOrEmpty(e.Label)) sb.Append(",\"label\":").Append(Str(e.Label!));
            sb.Append('}');
        }
        sb.Append("],\"sourceFile\":").Append(Str(ir.SourceFile))
          .Append(",\"generatedAt\":").Append(Str(ir.GeneratedAt)).Append('}');
        return sb.ToString();
    }

    private static string Num(int v) => v.ToString(CultureInfo.InvariantCulture);

    /// <summary>JSON文字列リテラル(ホストがメッセージを組み立てるときにも使う)。</summary>
    public static string Str(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (var c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
