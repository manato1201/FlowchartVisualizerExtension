using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Task = System.Threading.Tasks.Task;

namespace FlowchartVisualizer.Vsix;

/// <summary>
/// VSPackage本体。ツールウィンドウとコマンドを登録する。
/// AsyncPackageを使い、拡張の初期化がVisual Studio起動をブロックしないようにする。
/// </summary>
[PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
[Guid(PackageGuidString)]
[ProvideToolWindow(typeof(FlowchartToolWindow))]
[ProvideMenuResource("Menus.ctmenu", 1)]
public sealed class FlowchartVisualizerVsixPackage : AsyncPackage
{
    public const string PackageGuidString = "f1e2d3c4-b5a6-4978-8765-4321fedcba98";

    protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
    {
        await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
        await GenerateFlowchartCommand.InitializeAsync(this);
    }

    public async Task<FlowchartToolWindow> ShowFlowchartToolWindowAsync()
    {
        var window = await FindToolWindowAsync(typeof(FlowchartToolWindow), 0, true, DisposalToken) as FlowchartToolWindow;
        if (window?.Frame is null) throw new NotSupportedException("Flowchartツールウィンドウを作成できませんでした");

        var windowFrame = (Microsoft.VisualStudio.Shell.Interop.IVsWindowFrame)window.Frame;
        ErrorHandler.ThrowOnFailure(windowFrame.Show());
        return window;
    }
}
