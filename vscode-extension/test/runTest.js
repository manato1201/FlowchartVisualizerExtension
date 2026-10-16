// 実際の VS Code(Extension Host)で拡張を動かす結合テストのランナー。
//   node test/runTest.js
// インストール済みの VS Code を使う(ダウンロードしない)。見つからなければスキップする。
// 一時フォルダにワークスペース(Git リポジトリ)を作り、そこで test/suite/index.js を走らせる。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { runTests } = require("@vscode/test-electron");

function findVscode() {
  const local = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe") : "";
  return [
    process.env.FLOWCHART_VSCODE_EXE,
    local,
    "C:\\Program Files\\Microsoft VS Code\\Code.exe",
    "/usr/share/code/code",
    "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
  ]
    .filter(Boolean)
    .find((p) => fs.existsSync(p));
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function main() {
  const exe = findVscode();
  if (!exe) {
    console.log("integration: VS Code が見つからないためスキップします。FLOWCHART_VSCODE_EXE で指定できます。");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowchart-it-"));
  const workspace = path.join(root, "workspace");
  copyDir(path.join(__dirname, "fixtures", "workspace"), workspace);

  // 差分(HEAD との比較)のテスト用に、Git リポジトリとして最初のコミットを作る
  const git = (...args) => execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "flowchart-test");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");

  try {
    await runTests({
      vscodeExecutablePath: exe,
      extensionDevelopmentPath: path.resolve(__dirname, ".."),
      extensionTestsPath: path.resolve(__dirname, "suite", "index.js"),
      extensionTestsEnv: { FLOWCHART_IT_WORKSPACE: workspace },
      launchArgs: [
        workspace,
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--user-data-dir",
        path.join(root, "user-data"),
        "--extensions-dir",
        path.join(root, "extensions"),
      ],
    });
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // 一時フォルダの後始末に失敗しても結果には影響しない
    }
  }
}

main().catch((err) => {
  console.error("integration: 失敗しました", err && err.message ? err.message : err);
  process.exit(1);
});
