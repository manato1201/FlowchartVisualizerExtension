// core/webview-bundle/ (Phase1の共有バンドル)を無修正のまま vscode-extension/webview-bundle/ に
// 複製する。VSIXパッケージング(vsce package)は拡張ルート配下のファイルしか同梱できないため、
// 開発時は core/ を直接参照できても配布物には複製が必要になる。
// 重要: バンドルの中身(index.html/bridge.js/mermaid.min.js 等)には一切手を加えない。ファイルコピーのみ。
//
// 古いコピーが残ると、拡張が `core/` の最新版ではなく古いバンドルを読み込んでしまう
// (webviewPanel.ts は拡張ルートのコピーを優先する)。そのため `compile` のたびに必ず実行し、
// コピー先は一度空にしてから複製する(削除・改名したファイルが残らないように)。
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "..", "core", "webview-bundle");
const dest = path.join(__dirname, "..", "webview-bundle");

if (!fs.existsSync(path.join(src, "mermaid.min.js"))) {
  console.error(
    "core/webview-bundle/mermaid.min.js がありません。先に core ディレクトリで `npm install` と `npm run fetch-mermaid` を実行してください。",
  );
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const file of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
}
console.log(`共有Webviewバンドルを ${dest} に複製しました(無修正)`);
