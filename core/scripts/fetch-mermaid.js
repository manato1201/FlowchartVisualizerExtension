// node_modules/mermaid の配布物を webview-bundle 配下へコピーする。
// 目的: 共有Webviewバンドルがオフラインで動作すること(CDN不使用)。
// `npm install` 後にこのスクリプトを実行して同梱物を最新化する。
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "node_modules", "mermaid", "dist", "mermaid.min.js");
const destDir = path.join(__dirname, "..", "webview-bundle");
const dest = path.join(destDir, "mermaid.min.js");

if (!fs.existsSync(src)) {
  console.error(
    "mermaid.min.js が見つかりません。先に `npm install` を core/ ディレクトリで実行してください。"
  );
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`mermaid.min.js を ${dest} にコピーしました`);
