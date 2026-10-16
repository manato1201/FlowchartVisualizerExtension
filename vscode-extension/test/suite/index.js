// 実際の VS Code(Extension Host)の中で動く結合テスト。runTest.js から起動される。
// Webview の中身(DOM)は拡張のテストから直接は見えないため、
//   - Webview が実際の CSP 下で読み込まれ、Mermaid を描画できたこと
//     → Webview が acquireVsCodeApi 経由でホストへ返す `rendered` 通知で確認する
//   - Webview → ホストの操作(ジャンプ・コピー・関数を開く)
//     → simulateWebviewMessage で、届いたものとして処理させて確認する
// Webview の見た目・操作そのものは core/scripts/test-webview.js(ヘッドレスChrome)が検証している。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.error(`  FAIL ${name}\n${e && e.stack ? e.stack : e}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** event が predicate を満たすまで待つ。 */
function waitFor(event, predicate, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error(`時間切れ: ${what}(${timeoutMs}ms)`));
    }, timeoutMs);
    const sub = event((e) => {
      if (!predicate || predicate(e)) {
        clearTimeout(timer);
        sub.dispose();
        resolve(e);
      }
    });
  });
}

async function openFile(rel) {
  const ws = process.env.FLOWCHART_IT_WORKSPACE;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ws, rel)));
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
  return { doc, editor };
}

function lineOf(doc, needle) {
  for (let i = 0; i < doc.lineCount; i++) if (doc.lineAt(i).text.includes(needle)) return i;
  throw new Error("見つかりません: " + needle);
}

function setCursor(editor, line) {
  const pos = new vscode.Position(line, 4);
  editor.selection = new vscode.Selection(pos, pos);
}

async function waitForSymbols(doc, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", doc.uri);
    if (s && s.length) return s.length;
    await sleep(500);
  }
  return 0;
}

exports.run = async function run() {
  const ext = vscode.extensions.getExtension("flowchart-visualizer.flowchart-visualizer");
  assert.ok(ext, "拡張が見つかる");
  const api = await ext.activate();
  assert.ok(api && api.onRendered, "テスト用のAPIが返る");

  await test("全コマンドが登録される", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of [
      "flowchart.generateFromFile",
      "flowchart.generateFromSelection",
      "flowchart.exportSvg",
      "flowchart.exportPng",
      "flowchart.copyMermaid",
      "flowchart.generateMagicCircle",
      "flowchart.diffAgainstHead",
      "flowchart.loadArchitecture",
    ]) {
      assert.ok(all.includes(c), c);
    }
  });

  const { doc: playerDoc, editor: playerEditor } = await openFile("src/player.ts");
  const symbolCount = await waitForSymbols(playerDoc, 45000);
  console.log(`       TypeScript の DocumentSymbol: ${symbolCount > 0 ? symbolCount + " 件(言語サーバー経由)" : "なし(tree-sitter フォールバック)"}`);

  await test("カーソル位置の関数からフローを生成: Webview が実CSP下で読み込まれ、Mermaid を描画して通知を返す", async () => {
    setCursor(playerEditor, lineOf(playerDoc, "if (this.isGrounded)"));
    const rendered = waitFor(api.onRendered, (m) => m.mode === "flow", 60000, "Webview の描画完了通知(rendered)");
    await vscode.commands.executeCommand("flowchart.generateFromFile");
    const m = await rendered;
    assert.match(m.functionName ?? "", /update/i);
    assert.ok(m.nodeCount >= 8, "ノード数: " + m.nodeCount);
    const posted = api.getRecentPosted().filter((p) => p.type === "render").pop();
    assert.equal(posted.meta.canJump, true);
  });

  await test("別の関数にカーソルを置いて生成すると、その関数の図になる(ファイル先頭の関数に固定されない)", async () => {
    setCursor(playerEditor, lineOf(playerDoc, "while (this.isFalling)"));
    const rendered = waitFor(api.onRendered, (m) => m.mode === "flow" && /other/i.test(m.functionName ?? ""), 30000, "other() の描画完了");
    await vscode.commands.executeCommand("flowchart.generateFromFile");
    const m = await rendered;
    assert.ok(m.nodeCount >= 3 && m.nodeCount <= 6, "other() は小さな図: " + m.nodeCount);
  });

  await test("Webview からのジャンプ要求で、エディタの該当行にカーソルが移る(行番号のずれなし)", async () => {
    setCursor(playerEditor, lineOf(playerDoc, "if (this.isGrounded)"));
    const rendered = waitFor(api.onRendered, (m) => /update/i.test(m.functionName ?? ""), 30000, "update() の描画完了");
    await vscode.commands.executeCommand("flowchart.generateFromFile");
    await rendered;
    const target = lineOf(playerDoc, "for (let i = 0") + 1; // 1始まりの行
    api.simulateWebviewMessage({ type: "jump", line: target, nodeId: "n7" });
    await sleep(600);
    const active = vscode.window.activeTextEditor;
    assert.equal(active.document.uri.toString(), playerDoc.uri.toString());
    assert.equal(active.selection.active.line + 1, target);
  });

  await test("Webview からのコピー要求で、クリップボードに Mermaid テキストが入る", async () => {
    api.simulateWebviewMessage({ type: "copyText", text: "flowchart TD\n  n1(\"x\")" });
    await sleep(300);
    assert.equal(await vscode.env.clipboard.readText(), 'flowchart TD\n  n1("x")');
  });

  await test("未対応の言語(Python)は、図を作らずに帯でエラーを知らせる(中身のない図を出さない)", async () => {
    const { editor } = await openFile("notes.py");
    setCursor(editor, 1);
    await vscode.commands.executeCommand("flowchart.generateFromFile");
    await sleep(500);
    const last = api.getRecentPosted().filter((p) => p.type === "error").pop();
    assert.ok(last, "error が送られる");
    assert.match(last.message, /未対応/);
  });

  await test("構文エラーの可能性(波括弧の閉じ忘れ)は、帯で理由を知らせる", async () => {
    const bad = await vscode.workspace.openTextDocument({
      language: "typescript",
      content: "function broken(a: number) {\n  if (a > 0) {\n    run();\n  \n",
    });
    const editor = await vscode.window.showTextDocument(bad, { viewColumn: vscode.ViewColumn.One });
    setCursor(editor, 2);
    await vscode.commands.executeCommand("flowchart.generateFromFile");
    await sleep(800);
    const last = api.getRecentPosted().filter((p) => p.type === "error").pop();
    assert.match(last.message, /構文エラー/);
    assert.match(last.message, /閉じられていません/);
  });

  await test("HEAD との差分: 変更した関数だけが差分表示になる(変更していない関数は出ない)", async () => {
    const { doc, editor } = await openFile("src/player.ts");
    // update() の if の中に1文を足す(保存はしない。HEAD と作業中のテキストを比べる)
    const at = lineOf(doc, "this.jump();");
    await editor.edit((b) => b.insert(new vscode.Position(at, doc.lineAt(at).text.length), "\n      this.log();"));
    const rendered = waitFor(api.onRendered, (m) => m.mode === "diff", 60000, "差分表示の描画完了");
    await vscode.commands.executeCommand("flowchart.diffAgainstHead");
    const m = await rendered;
    assert.match(m.functionName ?? "", /update/i, "変更した関数だけが対象(クイックピックが出ない=1件のみ)");
    const posted = api.getRecentPosted().filter((p) => p.type === "render").pop();
    assert.match(posted.meta.banner, /HEAD との差分/);
    assert.match(posted.meta.banner, /変更1/);
    // 元に戻す
    await vscode.commands.executeCommand("workbench.action.files.revert");
  });

  await test("カーソル追従(設定オン): カーソルのある関数が変わると図が切り替わる", async () => {
    const { doc, editor } = await openFile("src/player.ts");
    await vscode.workspace.getConfiguration().update("flowchart.followCursor", true, vscode.ConfigurationTarget.Global);
    setCursor(editor, lineOf(doc, "if (this.isGrounded)"));
    await waitFor(api.onRendered, (m) => /update/i.test(m.functionName ?? ""), 30000, "追従: update() に切り替わる");
    setCursor(editor, lineOf(doc, "while (this.isFalling)"));
    const m = await waitFor(api.onRendered, (x) => /other/i.test(x.functionName ?? ""), 30000, "追従: other() に切り替わる");
    assert.equal(m.mode, "flow");
    await vscode.workspace.getConfiguration().update("flowchart.followCursor", false, vscode.ConfigurationTarget.Global);
  });

  await test("analysis.json(X2): 読み込むと全体ビューが出る。存在しないファイルがあってもエラーにならない", async () => {
    const shown = waitFor(api.onArchitectureShown, null, 30000, "全体ビューの表示通知");
    await vscode.commands.executeCommand("flowchart.loadArchitecture");
    const m = await shown;
    assert.equal(m.components, 1);
    assert.ok(!api.getRecentPosted().some((p) => p.type === "error" && /analysis/.test(p.message || "")));
  });

  await test("全体ビューの関数を開く: 該当ファイルがエディタで開き、その関数の図が出る", async () => {
    const rendered = waitFor(api.onRendered, (m) => m.mode === "flow" && /other/i.test(m.functionName ?? ""), 60000, "other() の描画完了");
    api.simulateWebviewMessage({ type: "openFunction", path: "src/player.ts", line: 31 });
    const m = await rendered;
    assert.ok(m.nodeCount >= 3);
    const active = vscode.window.activeTextEditor;
    assert.match(active.document.fileName.replace(/\\/g, "/"), /src\/player\.ts$/);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`integration: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) throw new Error(`${failed.length} 件の結合テストが失敗しました: ${failed.map((f) => f.name).join(" / ")}`);
};
