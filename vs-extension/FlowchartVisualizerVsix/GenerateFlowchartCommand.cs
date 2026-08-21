using System;
using System.ComponentModel.Design;
using System.Linq;
using System.Threading.Tasks;
using FlowchartVisualizer.Extractor;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Microsoft.VisualStudio.ComponentModelHost;
using Microsoft.VisualStudio.Editor;
using Microsoft.VisualStudio.LanguageServices;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.TextManager.Interop;
using Task = System.Threading.Tasks.Task;

namespace FlowchartVisualizer.Vsix;

/// <summary>
/// エディタ右クリックメニュー/コマンドから「アクティブなカーソル位置を含むメソッド」を
/// Roslynで解決し、FlowchartExtractorでIRを抽出、ツールウィンドウへ描画する。
/// </summary>
internal sealed class GenerateFlowchartCommand
{
    public const int CommandId = 0x0100;
    public static readonly Guid CommandSet = new("a1b2c3d4-e5f6-4789-9abc-def012345678");

    private readonly FlowchartVisualizerVsixPackage _package;

    private GenerateFlowchartCommand(FlowchartVisualizerVsixPackage package, OleMenuCommandService commandService)
    {
        _package = package;
        var menuCommandId = new CommandID(CommandSet, CommandId);
        var menuItem = new MenuCommand((s, e) => _ = ExecuteAsync(), menuCommandId);
        commandService.AddCommand(menuItem);
    }

    public static async Task InitializeAsync(FlowchartVisualizerVsixPackage package)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
        var commandService = await package.GetServiceAsync(typeof(IMenuCommandService)) as OleMenuCommandService;
        if (commandService is not null)
        {
            _ = new GenerateFlowchartCommand(package, commandService);
        }
    }

    private async Task ExecuteAsync()
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();

        var componentModel = (IComponentModel?)
            await _package.GetServiceAsync(typeof(SComponentModel));
        var workspace = componentModel?.GetService<VisualStudioWorkspace>();
        var textManager = (IVsTextManager?)await _package.GetServiceAsync(typeof(SVsTextManager));

        if (workspace is null || textManager is null) return;

        textManager.GetActiveView(1, null, out var activeView);
        if (activeView is null) return;

        activeView.GetCaretPos(out var line, out var column);
        var editorAdapters = componentModel!.GetService<IVsEditorAdaptersFactoryService>();
        var wpfTextView = editorAdapters.GetWpfTextView(activeView);
        if (wpfTextView is null) return;

        var snapshot = wpfTextView.TextBuffer.CurrentSnapshot;
        var document = snapshot.GetOpenDocumentInCurrentContextWithChanges();
        if (document is null) return;

        var syntaxRoot = await document.GetSyntaxRootAsync();
        var semanticModel = await document.GetSemanticModelAsync();
        if (syntaxRoot is null || semanticModel is null) return;

        var position = snapshot.GetLineFromLineNumber(line).Start.Position + column;
        var method = syntaxRoot.FindToken(position).Parent?
            .AncestorsAndSelf()
            .OfType<MethodDeclarationSyntax>()
            .FirstOrDefault();

        if (method is null)
        {
            method = syntaxRoot.DescendantNodes().OfType<MethodDeclarationSyntax>().FirstOrDefault();
        }
        if (method is null) return;

        var extractor = new FlowchartExtractor();
        var result = extractor.Extract(method, semanticModel, document.FilePath ?? document.Name);
        var mermaidText = MermaidEmitter.Emit(result.Ir);

        var window = await _package.ShowFlowchartToolWindowAsync();
        await window.Control.RenderAsync(mermaidText);
    }
}
