using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Windows.Controls;
using FlowchartVisualizer.Extractor;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;
using Microsoft.Web.WebView2.Core;

namespace FlowchartVisualizer.Vsix;

/// <summary>
/// Phase1の共有Webviewバンドル(core/webview-bundle/)を <c>WebView2</c> にロードするWPFコントロール。
/// バンドル自体には一切手を加えない。ホスト固有の部分はこのクラスに閉じる:
///   - WebView → ホストの送信口 <c>window.flowchartHostPost</c> を WebView2 の postMessage に繋ぐ(スクリプト注入)
///   - FlowchartIR をそのまま渡し、ビュー切替・ジャンプ・差分はバンドル側に任せる
///   - Visual Studio のテーマ色を <c>--vscode-*</c> 相当の値としてメッセージで送る
///     (WebView2 は VS Code と違い、これらのCSS変数を自動では持たないため)
/// </summary>
public partial class FlowchartToolWindowControl : UserControl
{
    private bool _isReady;
    private string? _pendingMessageJson;
    private string? _sourcePath;

    /// <summary>ノードのクリックで、行番号つきのジャンプが要求されたとき(パス, 行(1始まり))。</summary>
    public event Action<string, int>? JumpRequested;

    public FlowchartToolWindowControl()
    {
        InitializeComponent();
        _ = InitializeWebViewAsync();
        VSColorTheme.ThemeChanged += OnThemeChanged;
    }

    private void OnThemeChanged(ThemeChangedEventArgs e) => _ = PostThemeAsync();

    private async Task InitializeWebViewAsync()
    {
        await FlowchartWebView.EnsureCoreWebView2Async();
        var core = FlowchartWebView.CoreWebView2;

        // prefers-color-scheme を Visual Studio のテーマに合わせる(バンドルの既定色が VS と食い違わないように)
        core.Profile.PreferredColorScheme = IsDarkTheme() ? CoreWebView2PreferredColorScheme.Dark : CoreWebView2PreferredColorScheme.Light;

        // 共有バンドルは vscode / chrome.webview を直接参照しない。送信口だけをここで定義する。
        await core.AddScriptToExecuteOnDocumentCreatedAsync(
            "window.flowchartHostPost = function (m) { window.chrome.webview.postMessage(m); };");
        core.WebMessageReceived += OnWebMessageReceived;

        var bundleDir = Path.Combine(
            Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)!,
            "webview-bundle");
        core.Navigate(new Uri(Path.Combine(bundleDir, "index.html")).AbsoluteUri);
    }

    /// <summary>
    /// 図を描く。IR をそのまま渡し、フロー/呼び出し/状態のビュー切替・ツールチップ・ジャンプは
    /// バンドル側が行う(ホストごとに変換を実装しない)。
    /// </summary>
    public async Task RenderAsync(FlowchartIR ir, string? functionName, string? sourcePath)
    {
        _sourcePath = sourcePath;
        var meta = "{\"file\":" + IrJson.Str(ir.SourceFile) +
                   ",\"functionName\":" + (functionName is null ? "null" : IrJson.Str(functionName)) +
                   ",\"canJump\":" + (sourcePath is null ? "false" : "true") + "}";
        await PostMessageJsonAsync("{\"type\":\"render\",\"ir\":" + IrJson.Serialize(ir) + ",\"meta\":" + meta + "}");
    }

    public Task ShowErrorAsync(string message) =>
        PostMessageJsonAsync("{\"type\":\"error\",\"message\":" + IrJson.Str(message) + ",\"retry\":false}");

    private async Task PostMessageJsonAsync(string json)
    {
        // バンドルの読み込み(3MBのMermaid含む)が終わる前に送ると失われるため、`ready` が来るまで溜める
        if (!_isReady)
        {
            _pendingMessageJson = json;
            return;
        }
        await FlowchartWebView.CoreWebView2.ExecuteScriptAsync($"window.postMessage({json}, '*')");
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            switch (root.GetProperty("type").GetString())
            {
                case "ready":
                    _isReady = true;
                    await PostThemeAsync();
                    if (_pendingMessageJson is { } pending)
                    {
                        _pendingMessageJson = null;
                        await PostMessageJsonAsync(pending);
                    }
                    break;

                case "jump":
                    if (_sourcePath is { } path && root.TryGetProperty("line", out var line))
                    {
                        JumpRequested?.Invoke(path, line.GetInt32());
                    }
                    break;

                case "copyText":
                    System.Windows.Clipboard.SetText(root.GetProperty("text").GetString() ?? string.Empty);
                    break;

                case "saveImage":
                    SaveImage(root.GetProperty("format").GetString(), root.GetProperty("data").GetString());
                    break;
            }
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            // 想定外のメッセージは無視する(図の表示を止めない)
        }
    }

    private static void SaveImage(string? format, string? data)
    {
        if (data is null || (format != "svg" && format != "png")) return;
        var dialog = new Microsoft.Win32.SaveFileDialog
        {
            Filter = format == "svg" ? "SVG (*.svg)|*.svg" : "PNG (*.png)|*.png",
            FileName = "flowchart." + format,
        };
        if (dialog.ShowDialog() != true) return;
        var bytes = format == "svg"
            ? Encoding.UTF8.GetBytes(data)
            : Convert.FromBase64String(data.Substring(data.IndexOf(',') + 1));
        File.WriteAllBytes(dialog.FileName, bytes);
    }

    // ---- テーマ(U1): VS の色を、バンドルが読む --vscode-* 相当の名前で送る ----

    private static string Hex(System.Drawing.Color c) => $"#{c.R:x2}{c.G:x2}{c.B:x2}";

    private static bool IsDarkTheme()
    {
        var bg = VSColorTheme.GetThemedColor(EnvironmentColors.ToolWindowBackgroundColorKey);
        return (0.299 * bg.R + 0.587 * bg.G + 0.114 * bg.B) < 128;
    }

    private async Task PostThemeAsync()
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        if (!_isReady) return;

        var bg = VSColorTheme.GetThemedColor(EnvironmentColors.ToolWindowBackgroundColorKey);
        var fg = VSColorTheme.GetThemedColor(EnvironmentColors.ToolWindowTextColorKey);
        var border = VSColorTheme.GetThemedColor(EnvironmentColors.ToolWindowBorderColorKey);
        var gray = VSColorTheme.GetThemedColor(EnvironmentColors.SystemGrayTextColorKey);
        var widget = VSColorTheme.GetThemedColor(EnvironmentColors.CommandBarMenuBackgroundGradientBeginColorKey);
        var accent = VSColorTheme.GetThemedColor(EnvironmentColors.CommandBarSelectedBorderColorKey);
        var dark = IsDarkTheme();

        var vars = new (string Name, string Value)[]
        {
            ("vscode-editor-background", Hex(bg)),
            ("vscode-editor-foreground", Hex(fg)),
            ("vscode-descriptionForeground", Hex(gray)),
            ("vscode-panel-border", Hex(border)),
            ("vscode-editorWidget-background", Hex(widget)),
            ("vscode-editorWidget-border", Hex(border)),
            ("vscode-focusBorder", Hex(accent)),
            ("vscode-button-secondaryBackground", Hex(widget)),
            ("vscode-button-secondaryForeground", Hex(fg)),
            ("vscode-button-secondaryHoverBackground", Hex(border)),
            ("vscode-button-background", Hex(accent)),
            ("vscode-button-foreground", dark ? "#ffffff" : "#ffffff"),
        };
        var sb = new StringBuilder("{\"type\":\"theme\",\"kind\":\"" + (dark ? "dark" : "light") + "\",\"variables\":{");
        for (var i = 0; i < vars.Length; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(IrJson.Str(vars[i].Name)).Append(':').Append(IrJson.Str(vars[i].Value));
        }
        sb.Append("}}");
        await FlowchartWebView.CoreWebView2.ExecuteScriptAsync($"window.postMessage({sb}, '*')");
    }
}
