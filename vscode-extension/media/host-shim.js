// VS Code 用のホストシム。共有バンドルの `./host-shim.js` の代わりに読み込まれる
// (src/webviewPanel.ts が index.html 中のパスを差し替える)。
//
// 共有バンドル(core/webview-bundle/)は `acquireVsCodeApi` を直接参照しない。
// WebView → ホストの送信は window.flowchartHostPost(message) だけを使い、
// VS Code ではそれを acquireVsCodeApi().postMessage に繋ぐ。
// acquireVsCodeApi() は1ページで1回しか呼べないため、ここでだけ呼ぶ。
(function () {
  "use strict";
  var api = acquireVsCodeApi();
  window.flowchartHostPost = function (message) {
    api.postMessage(message);
  };
})();
