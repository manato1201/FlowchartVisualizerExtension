using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Windows.Controls;

namespace FlowchartVisualizer.Vsix;

/// <summary>
/// Phase1の共有Webviewバンドル(core/webview-bundle/)を <c>WebView2</c> にロードするWPFコントロール。
/// バンドル自体には一切手を加えず、postMessage相当のスクリプト注入でMermaidテキストを渡すだけ。
/// </summary>
public partial class FlowchartToolWindowControl : UserControl
{
    private bool _isReady;
    private string? _pendingMermaidText;

    public FlowchartToolWindowControl()
    {
        InitializeComponent();
        _ = InitializeWebViewAsync();
    }

    private async Task InitializeWebViewAsync()
    {
        await FlowchartWebView.EnsureCoreWebView2Async();

        var bundleDir = Path.Combine(
            Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)!,
            "webview-bundle");
        var indexPath = Path.Combine(bundleDir, "index.html");

        FlowchartWebView.CoreWebView2.Navigate(new Uri(indexPath).AbsoluteUri);
        FlowchartWebView.CoreWebView2.NavigationCompleted += async (_, _) =>
        {
            _isReady = true;
            if (_pendingMermaidText is { } text)
            {
                await RenderAsync(text);
            }
        };
    }

    public async Task RenderAsync(string mermaidText)
    {
        if (!_isReady)
        {
            _pendingMermaidText = mermaidText;
            return;
        }

        var json = JsonSerializer.Serialize(new { type = "render", mermaidText });
        await FlowchartWebView.CoreWebView2.ExecuteScriptAsync($"window.postMessage({json}, '*')");
    }
}
