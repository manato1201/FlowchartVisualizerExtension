// WebView → ホストへメッセージを送る口を定義する、ホスト差し替え用の薄いファイル。
//
// 共有バンドル(bridge.js)は `vscode` / `chrome.webview` といったホスト固有のグローバルを
// 直接参照しない。代わりに `window.flowchartHostPost(message)` だけを呼ぶ。
// この関数を定義するのがホストアダプタの責務:
//   - VS Code      : vscode-extension/media/host-shim.js が acquireVsCodeApi().postMessage を包む
//                    (webviewPanel.ts が index.html 中の ./host-shim.js をこちらに差し替える)
//   - WebView2 (VS): chrome.webview.postMessage を包むスクリプトを
//                    AddScriptToExecuteOnDocumentCreatedAsync で注入する
//   - JCEF (Rider) : JBCefJSQuery 経由の関数を executeJavaScript で定義する
// ホストが先に定義していれば何もしない。未定義なら親ウィンドウへの postMessage にする
// (単体表示・テスト用)。
(function () {
  "use strict";
  if (typeof window.flowchartHostPost === "function") return;
  window.flowchartHostPost = function (message) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, "*");
    }
  };
})();
