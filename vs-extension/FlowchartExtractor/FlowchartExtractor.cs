using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace FlowchartVisualizer.Extractor;

/// <summary>
/// Visual Studio拡張(vs-extension)の抽出エントリポイント。
/// <see cref="ControlFlowGraphExtractor"/>(Roslyn CFG API)を第一候補とし、
/// 失敗時は<see cref="SyntaxWalkerExtractor"/>へフォールバックする。
/// </summary>
public sealed class FlowchartExtractor
{
    public ExtractResult Extract(MethodDeclarationSyntax method, SemanticModel model, string sourceFile)
    {
        var cfgResult = ControlFlowGraphExtractor.TryExtract(method, model, sourceFile);
        if (cfgResult is not null)
        {
            return new ExtractResult(cfgResult, ExtractionStrategy.ControlFlowGraph);
        }

        var fallback = SyntaxWalkerExtractor.Extract(method, sourceFile);
        return new ExtractResult(fallback, ExtractionStrategy.SyntaxWalkerFallback);
    }
}

public enum ExtractionStrategy
{
    ControlFlowGraph,
    SyntaxWalkerFallback,
}

public sealed record ExtractResult(FlowchartIR Ir, ExtractionStrategy Strategy);
