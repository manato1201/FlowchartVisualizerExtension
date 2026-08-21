// core/webview-bundle/ (Phase1の共有バンドル)を無修正のまま vscode-extension/webview-bundle/ に
// 複製する。VSIXパッケージング(vsce package)は拡張ルート配下のファイルしか同梱できないため、
// 開発時は core/ を直接参照できても配布物には複製が必要になる。
// 重要: バンドルの中身(index.html/bridge.js/mermaid.min.js)には一切手を加えない。ファイルコピーのみ。
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "..", "core", "webview-bundle");
const dest = path.join(__dirname, "..", "webview-bundle");

fs.mkdirSync(dest, { recursive: true });
for (const file of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
}
console.log(`共有Webviewバンドルを ${dest} に複製しました(無修正)`);
