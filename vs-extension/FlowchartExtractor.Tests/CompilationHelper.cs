using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace FlowchartVisualizer.Extractor.Tests;

/// <summary>テスト用にソース文字列からCompilation/SemanticModelを組み立てる。</summary>
internal static class CompilationHelper
{
    public static (MethodDeclarationSyntax Method, SemanticModel Model) CompileFirstMethod(string source, string methodName)
    {
        var tree = CSharpSyntaxTree.ParseText(source);
        var references = GetTrustedPlatformAssemblyReferences();

        var compilation = CSharpCompilation.Create(
            "TestAssembly",
            new[] { tree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var root = tree.GetCompilationUnitRoot();
        var method = root.DescendantNodes()
            .OfType<MethodDeclarationSyntax>()
            .First(m => m.Identifier.Text == methodName);

        var model = compilation.GetSemanticModel(tree);
        return (method, model);
    }

    private static List<MetadataReference> GetTrustedPlatformAssemblyReferences()
    {
        var tpa = (string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!;
        return tpa.Split(Path.PathSeparator)
            .Where(path => path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();
    }
}
