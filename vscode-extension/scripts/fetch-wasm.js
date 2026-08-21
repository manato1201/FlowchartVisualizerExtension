// tree-sitterランタイム(tree-sitter.wasm)と、対応言語の文法(.wasm)を
// node_modulesから wasm/ ディレクトリへコピーする。
// 目的: web-tree-sitterフォールバックがオフラインで動作すること(CDN不使用)。
const fs = require("fs");
const path = require("path");

const destDir = path.join(__dirname, "..", "wasm");
fs.mkdirSync(destDir, { recursive: true });

const runtimeSrc = path.join(
  __dirname,
  "..",
  "node_modules",
  "web-tree-sitter",
  "tree-sitter.wasm",
);
fs.copyFileSync(runtimeSrc, path.join(destDir, "tree-sitter.wasm"));

const grammars = [
  "tree-sitter-c_sharp.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-javascript.wasm",
];

for (const file of grammars) {
  const src = path.join(
    __dirname,
    "..",
    "node_modules",
    "tree-sitter-wasms",
    "out",
    file,
  );
  if (!fs.existsSync(src)) {
    console.warn(`スキップ: ${file} が見つかりません`);
    continue;
  }
  fs.copyFileSync(src, path.join(destDir, file));
}

console.log(`tree-sitter WASMファイルを ${destDir} にコピーしました`);
