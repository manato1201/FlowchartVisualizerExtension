using System;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;

namespace FlowchartVisualizer.Vsix;

/// <summary>ツールウィンドウのペイン。中身はWebView2を埋め込んだ<see cref="FlowchartToolWindowControl"/>。</summary>
[Guid("b3f3a1e2-6a8b-4b8b-9b0e-7a1c2d3e4f5a")]
public sealed class FlowchartToolWindow : ToolWindowPane
{
    public FlowchartToolWindow() : base(null)
    {
        Caption = "Flowchart";
        Content = new FlowchartToolWindowControl();
    }

    public FlowchartToolWindowControl Control => (FlowchartToolWindowControl)Content;
}
