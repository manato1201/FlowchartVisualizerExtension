// 共有Webviewバンドルの実ブラウザ検証(ヘッドレス Chrome / Edge)。
// IMPROVEMENT_DESIGN_2026-10.md の検証チェックリストに対応する:
//   - ライト/ダーク/高コントラストのどれでも文字が読める
//   - ノードのクリックが正しい行へジャンプする
//   - 大きな関数(300ノード超)でもパン・ズームが固まらない
//   - 図形の意味が決めごと表と一致している
//   - エラー表示が図を隠さない
// ブラウザが見つからない環境では、理由を表示してスキップ(exit 0)する。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const H = require("./webview-harness");
const { makeSampleIR, makeLargeIR } = require("./fixtures/sample-ir");

const SHOT_DIR = process.env.FLOWCHART_TEST_SHOTS || null; // 指定時のみスクリーンショットを保存

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++;
    process.exitCode = 1;
    console.error(`  FAIL ${name}\n${e.stack}`);
  }
}

// ---- 色の計算(WCAGコントラスト比。半透明は背景に合成する) ----
function parseColor(s) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(s);
  if (!m) throw new Error("色を解釈できません: " + s);
  let a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: +m[1], g: +m[2], b: +m[3], a };
}
function over(fg, bg) {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}
function lum(c) {
  const f = [c.r, c.g, c.b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}
function ratio(fgStr, bgStr) {
  const bg = over(parseColor(bgStr), { r: 255, g: 255, b: 255, a: 1 });
  const fg = over(parseColor(fgStr), bg);
  const [a, b] = [lum(fg), lum(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function nodeBox(page, nodeId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`#stage g.node[data-node-id="${id}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  }, nodeId);
}

async function renderIR(page, ir, meta = { file: "Player.cs", functionName: "Update()", canJump: true }, extra = {}) {
  await H.hostPost(page, { type: "render", ir, meta, ...extra });
  await H.waitForNodes(page, ir.nodes.length);
  await sleep(120);
}

async function shot(page, name) {
  if (!SHOT_DIR) return;
  await sleep(700); // 順次表示(最大約 0.7 秒)が終わってから撮る
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, name + ".png") });
}

(async () => {
  const exe = H.findBrowser();
  if (!exe) {
    console.log("webview: ブラウザ(Chrome / Edge)が見つからないためスキップします。FLOWCHART_TEST_BROWSER で指定できます。");
    return;
  }
  if (!fs.existsSync(path.join(H.BUNDLE_DIR, "mermaid.min.js"))) {
    console.error("webview: core/webview-bundle/mermaid.min.js がありません。`npm run fetch-mermaid` を先に実行してください。");
    process.exit(1);
  }
  const puppeteer = require("puppeteer-core");
  const { server, port } = await H.startServer();
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] });
  console.log("browser: " + exe);

  try {
    await test("起動: 厳格なCSP(eval・インラインscript禁止)下で読み込みエラーなし。空状態の文言が出る", async () => {
      const { page, errors } = await H.openPage(browser, port);
      const text = await page.$eval("#empty-lead", (e) => e.textContent);
      assert.match(text, /関数にカーソルを置/);
      assert.equal(await page.$eval("#empty", (e) => e.hidden), false);
      assert.deepEqual(errors, []);
      await page.close();
    });

    await test("空状態の「このファイルから生成」がホストへ generate を要求する", async () => {
      const { page } = await H.openPage(browser, port);
      await page.click("#empty-generate");
      assert.deepEqual((await H.sent(page)).pop(), { type: "requestAction", action: "generate" });
      await page.close();
    });

    await test("followCursor 設定で空状態の文言が切り替わる", async () => {
      const { page } = await H.openPage(browser, port);
      const off = await page.$eval("#empty-lead", (e) => e.textContent);
      await H.hostPost(page, { type: "config", followCursor: true });
      await sleep(50);
      const on = await page.$eval("#empty-lead", (e) => e.textContent);
      assert.notEqual(off, on);
      assert.equal(on, "関数にカーソルを置くと図が出ます");
      await page.close();
    });

    await test("図形の決めごと表: 開始/終了=角丸 / 処理=長方形 / 分岐=ひし形(4点) / 繰り返し=六角形(6点)", async () => {
      const { page, errors } = await H.openPage(browser, port);
      const ir = makeSampleIR();
      await renderIR(page, ir);
      const shapes = await page.evaluate(() => {
        const out = {};
        document.querySelectorAll("#stage g.node").forEach((g) => {
          const s = g.querySelector("rect, polygon");
          out[g.dataset.nodeId] =
            s.tagName === "polygon"
              ? "polygon:" + s.getAttribute("points").trim().split(/\s+/).length
              : "rect:" + (+s.getAttribute("rx") > 0 ? "round" : "square");
        });
        return out;
      });
      for (const n of ir.nodes) {
        const want = {
          start: "rect:round",
          end: "rect:round",
          process: "rect:square",
          decision: "polygon:4",
          loop: "polygon:6",
        }[n.kind];
        assert.equal(shapes[n.id], want, `${n.id}(${n.kind})`);
      }
      assert.deepEqual(errors, []);
      await page.close();
    });

    await test("ラベルの < > & \" が文字化けせず、そのまま表示される(エンティティが画面に出ない)", async () => {
      const { page } = await H.openPage(browser, port);
      const ir = makeSampleIR();
      ir.nodes[2].label = 'a<b && c>d "x" &lt;';
      await renderIR(page, ir);
      const text = await page.evaluate(() =>
        [...document.querySelectorAll('#stage g.node[data-node-id="n3"] tspan')].map((t) => t.textContent).join(""),
      );
      assert.ok(text.includes('a<b && c>d "x" &lt;'), text);
      await page.close();
    });

    await test("ノード内の文は短く切り、全文はホバーのツールチップで見せる。行番号が併記される", async () => {
      const { page } = await H.openPage(browser, port);
      await renderIR(page, makeSampleIR());
      const shown = await page.evaluate(() => document.querySelector('#stage g.node[data-node-id="n7"]').textContent);
      assert.match(shown, /…/);
      assert.match(shown, /L16/);
      const b = await nodeBox(page, "n7");
      await page.mouse.move(b.x, b.y);
      await page.waitForSelector("#tooltip:not([hidden])");
      const tip = await page.$eval("#tooltip", (e) => e.textContent);
      assert.ok(tip.includes("for (int i = 0; i < enemies.Length; i++)"), tip);
      assert.ok(tip.includes("繰り返し"));
      assert.ok(tip.includes("L16"));
      await page.mouse.move(2, 2);
      await sleep(50);
      assert.equal(await page.$eval("#tooltip", (e) => e.hidden), true);
      await page.close();
    });

    await test("ビュー切替: 同じIRから フロー14 / 呼び出し8 / 状態7 ノードで描ける(ノード数の整合)", async () => {
      const { page } = await H.openPage(browser, port);
      await renderIR(page, makeSampleIR());
      const counts = {};
      for (const [id, n] of [
        ["calls", 8],
        ["state", 7],
        ["flow", 14],
      ]) {
        await page.click(`#views button[data-view="${id}"]`);
        await H.waitForNodes(page, n);
        counts[id] = await page.$$eval("#stage g.node", (e) => e.length);
        assert.equal(
          await page.$eval(`#views button[data-view="${id}"]`, (b) => b.getAttribute("aria-checked")),
          "true",
        );
      }
      assert.deepEqual(counts, { calls: 8, state: 7, flow: 14 });
      await page.close();
    });

    await test("ビュー切替をキーボード(←→)でも操作できる。IRなし(旧形式)ではフローのみ", async () => {
      const { page } = await H.openPage(browser, port);
      await renderIR(page, makeSampleIR());
      await page.focus('#views button[data-view="flow"]');
      await page.keyboard.press("ArrowRight");
      await H.waitForNodes(page, 8);
      assert.equal((await page.evaluate(() => window.__flowchartDebug())).view, "calls");
      await H.hostPost(page, { type: "render", mermaidText: 'flowchart TD\n  a("A") --> b["B"]', meta: {} });
      await H.waitForNodes(page, 2);
      assert.equal(await page.$eval('#views button[data-view="state"]', (b) => b.disabled), true);
      assert.equal(await page.$eval('#views button[data-view="flow"]', (b) => b.disabled), false);
      await page.close();
    });

    await test("パンくず: 全体 › ファイル › 関数。最後が現在位置。analysis.json 未読込なら「全体」はボタンにならない", async () => {
      const { page } = await H.openPage(browser, port);
      await renderIR(page, makeSampleIR());
      const crumbs = await page.$$eval("#breadcrumb .crumb", (els) =>
        els.map((e) => ({ t: e.textContent, tag: e.tagName, cur: e.getAttribute("aria-current") })),
      );
      assert.deepEqual(
        crumbs.map((c) => c.t),
        ["全体", "Player.cs", "Update()"],
      );
      assert.equal(crumbs[2].cur, "page");
      assert.ok(crumbs.every((c) => c.tag === "SPAN"));
      await page.close();
    });

    await test("ノードをクリック → ホストへ正しい行番号でジャンプ要求。ドラッグ直後のクリックは無視(誤爆防止)", async () => {
      const { page } = await H.openPage(browser, port);
      const ir = makeSampleIR();
      await renderIR(page, ir);
      for (const id of ["n7", "n3", "n14"]) {
        const b = await nodeBox(page, id);
        await page.mouse.click(b.x, b.y);
        const msg = (await H.sent(page)).filter((m) => m.type === "jump").pop();
        const want = ir.nodes.find((n) => n.id === id).sourceRange.startLine;
        assert.deepEqual(msg, { type: "jump", line: want, nodeId: id }, id);
      }
      const before = (await H.sent(page)).filter((m) => m.type === "jump").length;
      const b = await nodeBox(page, "n2");
      await page.mouse.move(b.x, b.y);
      await page.mouse.down();
      await page.mouse.move(b.x + 40, b.y + 30, { steps: 5 });
      await page.mouse.up();
      await sleep(50);
      assert.equal((await H.sent(page)).filter((m) => m.type === "jump").length, before, "ドラッグではジャンプしない");
      await page.close();
    });

    await test("canJump が false(ソースと対応しない図)ではジャンプ要求を出さない", async () => {
      const { page } = await H.openPage(browser, port);
      await renderIR(page, makeSampleIR(), { file: "x", functionName: "f()", canJump: false });
      const b = await nodeBox(page, "n3");
      await page.mouse.click(b.x, b.y);
      assert.equal((await H.sent(page)).filter((m) => m.type === "jump").length, 0);
      await page.close();
    });

    await test("エラー帯: 図の上に出て、図は消えない(エラーが図を隠さない)。閉じる・再試行が動く", async () => {
      const { page } = await H.openPage(browser, port);
      await renderIR(page, makeSampleIR());
      await H.hostPost(page, { type: "error", message: "解析に失敗しました: 波括弧の対応が取れません", retry: true });
      await page.waitForSelector("#banner:not([hidden])");
      const geo = await page.evaluate(() => {
        const b = document.querySelector("#banner").getBoundingClientRect();
        const v = document.querySelector("#viewport").getBoundingClientRect();
        return { bannerBottom: b.bottom, viewTop: v.top, viewH: v.height, nodes: document.querySelectorAll("#stage g.node").length };
      });
      assert.ok(geo.bannerBottom <= geo.viewTop + 0.5, "帯は図の領域の外(上)にある");
      assert.ok(geo.viewH > 300, "図の領域が潰れていない");
      assert.equal(geo.nodes, 14, "図はそのまま残る");
      await page.click("#banner-retry");
      assert.deepEqual((await H.sent(page)).pop(), { type: "requestAction", action: "retry" });
      await page.click("#banner-close");
      assert.equal(await page.$eval("#banner", (e) => e.hidden), true);
      await H.hostPost(page, { type: "error", message: "x" });
      await H.hostPost(page, { type: "clearError" });
      await sleep(50);
      assert.equal(await page.$eval("#banner", (e) => e.hidden), true);
      await page.close();
    });

    await test("Mermaidの描画失敗でも、前の図を残したまま帯で知らせる", async () => {
      const { page } = await H.openPage(browser, port);
      await renderIR(page, makeSampleIR());
      await H.hostPost(page, { type: "render", mermaidText: "flowchart TD\n  a --> ((((", meta: {} });
      await page.waitForSelector("#banner:not([hidden])");
      assert.match(await page.$eval("#banner-text", (e) => e.textContent), /描画に失敗/);
      assert.equal(await page.$$eval("#stage g.node", (e) => e.length), 14, "前の図が残る");
      assert.equal(await page.$$eval('[id^="dfv-svg"]', (e) => e.length), 0, "Mermaidのエラー用の残骸DOMがない");
      await page.close();
    });

    await test("ズーム: ボタン・Ctrl+ホイール・全体表示・ドラッグでのパン。倍率の表示が追従する", async () => {
      const { page } = await H.openPage(browser, port);
      await renderIR(page, makeSampleIR());
      const z0 = (await page.evaluate(() => window.__flowchartDebug())).scale;
      await page.click("#zoom-in");
      await sleep(60);
      const z1 = (await page.evaluate(() => window.__flowchartDebug())).scale;
      assert.ok(z1 > z0 * 1.2 && z1 < z0 * 1.3, `${z0} -> ${z1}`);
      assert.equal(await page.$eval("#zoom-level", (e) => e.textContent), Math.round(z1 * 100) + "%");
      await page.mouse.move(550, 380);
      await page.keyboard.down("Control");
      await page.mouse.wheel({ deltaY: -200 });
      await page.keyboard.up("Control");
      await sleep(60);
      assert.ok((await page.evaluate(() => window.__flowchartDebug())).scale > z1);
      const t0 = await page.$eval("#stage", (e) => e.style.transform);
      await page.mouse.move(500, 300);
      await page.mouse.down();
      await page.mouse.move(540, 340, { steps: 4 });
      await page.mouse.up();
      await sleep(60);
      assert.notEqual(await page.$eval("#stage", (e) => e.style.transform), t0, "ドラッグで動く");
      await page.click("#zoom-fit");
      await sleep(60);
      assert.ok(Math.abs((await page.evaluate(() => window.__flowchartDebug())).scale - z0) < 0.01, "全体表示に戻る");
      await page.close();
    });

    await test("リサイズ追従: 全体表示のままなら、帯の出入りやウィンドウ変更でも図が収まる。手動で動かした後は勝手に動かさない", async () => {
      const { page } = await H.openPage(browser, port);
      await renderIR(page, makeSampleIR());
      const fits = () =>
        page.evaluate(() => {
          const v = document.querySelector("#viewport").getBoundingClientRect();
          const s = document.querySelector("#stage svg").getBoundingClientRect();
          return s.left >= v.left - 1 && s.right <= v.right + 1 && s.top >= v.top - 1 && s.bottom <= v.bottom + 1;
        });
      assert.equal(await fits(), true);
      await H.hostPost(page, { type: "error", message: "帯が出て、図の領域が縮む" });
      await page.waitForSelector("#banner:not([hidden])");
      await sleep(250);
      assert.equal(await fits(), true, "帯が出ても収まる");
      await page.setViewport({ width: 700, height: 520 });
      await sleep(250);
      assert.equal(await fits(), true, "ウィンドウを小さくしても収まる");
      await page.click("#zoom-in");
      await sleep(80);
      const t = await page.$eval("#stage", (e) => e.style.transform);
      await page.setViewport({ width: 900, height: 600 });
      await sleep(250);
      assert.equal(await page.$eval("#stage", (e) => e.style.transform), t, "手動ズーム後はリサイズで動かさない");
      await page.close();
    });

    await test("ミニマップ: 拡大して図が収まらないときだけ出る。押すとその位置へ移動する", async () => {
      const { page } = await H.openPage(browser, port);
      await renderIR(page, makeSampleIR());
      await sleep(200);
      assert.equal(await page.$eval("#minimap", (e) => e.hidden), true, "全体が見えているときは出さない(静かに)");
      for (let i = 0; i < 4; i++) await page.click("#zoom-in");
      await sleep(150);
      assert.equal(await page.$eval("#minimap", (e) => e.hidden), false);
      assert.match(await page.$eval("#minimap img", (e) => e.getAttribute("src") || ""), /^blob:/);
      const before = await page.$eval("#stage", (e) => e.style.transform);
      const box = await page.$eval("#minimap", (e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      await page.mouse.click(box.x + 10, box.y + 10);
      await sleep(100);
      assert.notEqual(await page.$eval("#stage", (e) => e.style.transform), before);
      const view = await page.$eval("#minimap .mm-view", (e) => ({ w: e.offsetWidth, h: e.offsetHeight }));
      assert.ok(view.w > 2 && view.h > 2);
      await page.close();
    });

    await test("書き出し: 画像で保存(SVG / PNG)。背景色つきで、ホストへデータが渡る。Mermaidコピーは行番号なし", async () => {
      const { page } = await H.openPage(browser, port);
      await renderIR(page, makeSampleIR());
      await page.click("#btn-save");
      assert.equal(await page.$eval("#save-menu", (e) => e.hidden), false);
      assert.equal(await page.$eval("#btn-save", (e) => e.getAttribute("aria-expanded")), "true");
      await page.click('#save-menu [data-save="svg"]');
      const svgMsg = (await H.sent(page)).find((m) => m.type === "saveImage" && m.format === "svg");
      assert.ok(svgMsg.data.startsWith("<svg"));
      assert.match(svgMsg.data, /<rect[^>]+fill="#1e1e1e"/, "テーマの背景色を敷く");
      assert.ok(!/class="[^"]*\b(lit|selected)\b/.test(svgMsg.data));
      await page.click("#btn-save");
      await page.click('#save-menu [data-save="png"]');
      await page.waitForFunction(() => window.__sent.some((m) => m.type === "saveImage" && m.format === "png"));
      const pngMsg = (await H.sent(page)).find((m) => m.type === "saveImage" && m.format === "png");
      const buf = Buffer.from(pngMsg.data.replace(/^data:image\/png;base64,/, ""), "base64");
      assert.equal(buf.slice(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.ok(buf.readUInt32BE(16) > 200 && buf.readUInt32BE(20) > 200, "PNGの寸法");
      await page.click("#btn-copy");
      const copy = (await H.sent(page)).find((m) => m.type === "copyText");
      assert.ok(copy.text.startsWith("flowchart TD"));
      assert.ok(!/<br\/>L\d/.test(copy.text), "コピー用には行番号を入れない");
      // ホストからの書き出し要求(コマンドパレット経由)にも答える
      await H.hostPost(page, { type: "exportSvg" });
      await page.waitForFunction(() => window.__sent.some((m) => m.type === "exportSvgResult"));
      await H.hostPost(page, { type: "exportPng" });
      await page.waitForFunction(() => window.__sent.some((m) => m.type === "exportPngResult"));
      assert.ok((await H.sent(page)).find((m) => m.type === "exportPngResult").dataUrl.startsWith("data:image/png"));
      await page.close();
    });

    await test("再生(ライン描画): 実行順に線が点灯して、終わると元の表示に戻る。途中で止められる", async () => {
      const { page } = await H.openPage(browser, port);
      await renderIR(page, makeSampleIR());
      await sleep(600); // 順次表示の動きが終わるのを待つ
      await page.click("#btn-play");
      assert.equal(await page.$eval("#stage", (e) => e.classList.contains("playing")), true);
      assert.equal(await page.$eval("#btn-play-label", (e) => e.textContent), "停止");
      await sleep(900);
      const lit = await page.$$eval("#stage .lit", (e) => e.length);
      assert.ok(lit >= 3, "途中でも点灯が進んでいる: " + lit);
      await page.waitForFunction(() => !document.querySelector("#stage").classList.contains("playing"), { timeout: 15000 });
      assert.equal(await page.$$eval("#stage .lit", (e) => e.length), 0, "終了後は強調が残らない");
      assert.equal(await page.$eval("#btn-play-label", (e) => e.textContent), "再生");
      await page.click("#btn-play");
      await sleep(150);
      await page.click("#btn-play");
      assert.equal(await page.$eval("#stage", (e) => e.classList.contains("playing")), false, "停止で即座に戻る");
      await page.close();
    });

    await test("動きの制限: prefers-reduced-motion では順次表示を付けず、再生は動きなしで経路をまとめて強調する", async () => {
      const { page } = await H.openPage(browser, port, { reducedMotion: true });
      let staggered = false;
      await page.exposeFunction("__noteStagger", () => (staggered = true));
      await page.evaluate(() => {
        new MutationObserver((ms) =>
          ms.forEach((m) => m.target.classList && m.target.classList.contains("stagger") && window.__noteStagger()),
        ).observe(document.querySelector("#stage"), { attributes: true, attributeFilter: ["class"] });
      });
      await renderIR(page, makeSampleIR());
      await sleep(300);
      assert.equal(staggered, false, "stagger クラスが付かない");
      await page.click("#btn-play");
      await sleep(250);
      const dashed = await page.$$eval("#stage .edgePaths path", (ps) => ps.filter((p) => p.style.strokeDasharray).length);
      assert.equal(dashed, 0, "線を描く動きをしない");
      assert.ok((await page.$$eval("#stage .lit", (e) => e.length)) >= 10, "経路は強調表示される");
      await page.close();
    });

    await test("通常時は順次表示が走る(動き1)。大きな図(80ノード超)では付けない", async () => {
      const { page } = await H.openPage(browser, port);
      let seen = 0;
      await page.exposeFunction("__noteStagger", () => seen++);
      await page.evaluate(() => {
        new MutationObserver((ms) =>
          ms.forEach((m) => m.target.classList && m.target.classList.contains("stagger") && window.__noteStagger()),
        ).observe(document.querySelector("#stage"), { attributes: true, attributeFilter: ["class"] });
      });
      await renderIR(page, makeSampleIR());
      assert.ok(seen >= 1, "小さな図では走る");
      const big = makeLargeIR(100);
      const before = seen;
      await renderIR(page, big, { file: "Big.cs", functionName: "Big()", canJump: true });
      assert.equal(seen, before, "大きな図では走らない");
      await page.close();
    });

    await test("差分表示(X3): 追加/削除/変更が着色され、削除ノードはジャンプしない。変更前の文がツールチップに出る", async () => {
      const { diffIR } = require("../dist/diff/ir-diff");
      const before = makeSampleIR();
      const after = makeSampleIR();
      after.nodes.find((n) => n.id === "n5").label = "ApplyGravity(2.0f);";
      after.nodes = after.nodes.filter((n) => n.id !== "n6");
      after.edges = after.edges.filter((e) => e.from !== "n6" && e.to !== "n6");
      after.nodes.splice(3, 0, { id: "n99", kind: "process", label: "Log();", sourceRange: { startLine: 6, endLine: 6 } });
      after.edges.push({ from: "n2", to: "n99" });
      const r = diffIR(before, after);
      const { page } = await H.openPage(browser, port);
      await renderIR(page, r.ir, { file: "Player.cs", functionName: "Update()", canJump: true, mode: "diff", banner: "HEAD との差分" });
      assert.equal(await page.$eval("#banner", (e) => e.dataset.kind), "info");
      const diffs = await page.$$eval("#stage g.node[data-diff]", (els) => els.map((e) => e.dataset.diff));
      assert.ok(diffs.includes("added") && diffs.includes("removed") && diffs.includes("changed"));
      const strokeOf = (d) =>
        page.$eval(`#stage g.node[data-diff="${d}"] rect, #stage g.node[data-diff="${d}"] polygon`, (s) => {
          const cs = getComputedStyle(s);
          return { stroke: cs.stroke, dash: cs.strokeDasharray, w: cs.strokeWidth };
        });
      const [a, rm, ch] = [await strokeOf("added"), await strokeOf("removed"), await strokeOf("changed")];
      assert.notEqual(a.stroke, rm.stroke);
      assert.notEqual(rm.stroke, ch.stroke);
      assert.notEqual(rm.dash, "none", "削除は破線(色だけに頼らない)");
      const removedId = r.ir.nodes.find((n) => n.diff === "removed").id;
      const b = await nodeBox(page, removedId);
      await page.mouse.click(b.x, b.y);
      assert.equal((await H.sent(page)).filter((m) => m.type === "jump").length, 0, "削除ノードはジャンプしない");
      const cb = await nodeBox(page, "n5");
      await page.mouse.move(cb.x, cb.y);
      await page.waitForSelector("#tooltip:not([hidden])");
      const tip = await page.$eval("#tooltip", (e) => e.textContent);
      assert.ok(tip.includes("変更") && tip.includes("ApplyGravity();") && tip.includes("ApplyGravity(2.0f);"), tip);
      await page.close();
    });

    await test("全体(X2): analysis.json 読込後、パンくずの「全体」から掘り下げ。存在しないファイル・未対応言語は押せず理由が出る", async () => {
      const { parseCodeBoardingAnalysis, markMissingFiles, collectFilePaths } = require("../dist/architecture/codeboarding-adapter");
      const model = parseCodeBoardingAnalysis(
        JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "codeboarding-analysis.sample.json"), "utf8")),
      );
      const paths = collectFilePaths(model);
      markMissingFiles(model, (p) => p !== paths[0]);
      // 2番目のファイルは言語未対応としてホストが印を付ける
      const second = paths[1];
      const mark = (c) => (c.files.forEach((f) => f.path === second && (f.unsupportedReason = "言語未対応")), c.children.forEach(mark));
      model.components.forEach(mark);

      const { page, errors } = await H.openPage(browser, port);
      await renderIR(page, makeSampleIR());
      await H.hostPost(page, { type: "architecture", model });
      await page.waitForSelector("#overview:not([hidden])");
      assert.equal(await page.$eval("#stage", (e) => e.hidden), true);
      assert.match(await page.$eval("#overview", (e) => e.textContent), /CodeBoarding の解析結果/);
      assert.equal((await page.$$("#overview > ul.tree > li")).length, model.components.length);
      // 最初のコンポーネントを開き、ファイル → 関数まで開く
      await page.click("#overview > ul.tree > li:first-child > details > summary");
      await page.waitForSelector("#overview details details > summary");
      const fileSummaries = await page.$$("#overview details details > summary");
      for (const s of fileSummaries) await s.click();
      await sleep(100);
      const fns = await page.$$eval("#overview button.fn", (bs) => bs.map((b) => ({ dis: b.disabled, title: b.title })));
      assert.ok(fns.length > 0);
      assert.ok(fns.some((f) => f.dis && /見つかりません|言語未対応/.test(f.title)), "押せない関数には理由が付く");
      const live = await page.$$("#overview button.fn:not(:disabled)");
      if (live.length) {
        await live[0].click();
        const m = (await H.sent(page)).find((x) => x.type === "openFunction");
        assert.ok(m && typeof m.path === "string" && m.line >= 1);
      }
      assert.deepEqual(errors, []);
      // パンくず: 全体が現在位置。ビュータブで図へ戻れる
      assert.equal(await page.$eval('#breadcrumb [aria-current="page"]', (e) => e.textContent), "全体");
      await page.click('#views button[data-view="flow"]');
      await H.waitForNodes(page, 14);
      assert.equal(await page.$eval("#overview", (e) => e.hidden), true);
      const crumbBtn = await page.$("#breadcrumb button.crumb");
      assert.ok(crumbBtn, "読込後は「全体」がボタンになる");
      await crumbBtn.click();
      await page.waitForSelector("#overview:not([hidden])");
      await page.close();
    });

    await test("U1: テーマ追従。ライト/ダーク/高コントラスト(暗・明)のどれでも、ノード・辺ラベル・画面の文字のコントラストが基準以上", async () => {
      for (const theme of ["light", "dark", "hcDark", "hcLight"]) {
        const min = theme.startsWith("hc") ? 7 : 4.5;
        const { page, errors } = await H.openPage(browser, port, { theme });
        const ir = makeSampleIR();
        ir.nodes.find((n) => n.id === "n5").diff = "added";
        ir.nodes.find((n) => n.id === "n6").diff = "removed";
        ir.nodes.find((n) => n.id === "n3").diff = "changed";
        await renderIR(page, ir);
        await H.hostPost(page, { type: "error", message: "解析エラーの例", retry: true });
        await page.waitForSelector("#banner:not([hidden])");
        const pairs = await page.evaluate(() => {
          const out = [];
          const bgOf = (el) => {
            for (let e = el; e; e = e.parentElement) {
              const c = getComputedStyle(e).backgroundColor;
              if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
            }
            return getComputedStyle(document.body).backgroundColor;
          };
          document.querySelectorAll("#stage g.node").forEach((g) => {
            const shape = g.querySelector("rect, polygon");
            const text = g.querySelector("text");
            out.push({ what: "node " + g.dataset.nodeId, fg: getComputedStyle(text).fill, bg: getComputedStyle(shape).fill });
          });
          const page = getComputedStyle(document.body).backgroundColor;
          document.querySelectorAll("#stage .edgeLabel text").forEach((t, i) => {
            if (t.textContent.trim()) out.push({ what: "edgeLabel " + t.textContent, fg: getComputedStyle(t).fill, bg: page });
          });
          const ui = [
            "#views button[aria-checked=true]",
            "#views button[aria-checked=false]",
            "#btn-copy",
            "#btn-save",
            "#banner-text",
            "#zoom-level",
            "#breadcrumb .crumb",
            "#breadcrumb .crumb[aria-current]",
          ];
          for (const sel of ui) {
            const el = document.querySelector(sel);
            if (el) out.push({ what: sel, fg: getComputedStyle(el).color, bg: bgOf(el) });
          }
          return out;
        });
        const bad = pairs.filter((p) => ratio(p.fg, p.bg) < min).map((p) => `${p.what}: ${ratio(p.fg, p.bg).toFixed(2)} (${p.fg} on ${p.bg})`);
        await shot(page, "theme-" + theme);
        assert.deepEqual(bad, [], `${theme}: 基準 ${min}:1 を下回る組み合わせ`);
        assert.deepEqual(errors, []);
        await page.close();
      }
    });

    await test("U1: 実行中にテーマが変わったら、図を作り直して色が追従する(VS Code のテーマ切替相当)", async () => {
      const { page } = await H.openPage(browser, port, { theme: "dark" });
      await renderIR(page, makeSampleIR());
      const fill = () => page.$eval('#stage g.node[data-node-id="n3"] rect', (e) => getComputedStyle(e).fill);
      const dark = await fill();
      await H.setTheme(page, "light");
      await page.waitForFunction(
        (d) => getComputedStyle(document.querySelector('#stage g.node[data-node-id="n3"] rect')).fill !== d,
        { timeout: 5000 },
        dark,
      );
      assert.notEqual(await fill(), dark);
      assert.equal(await page.$$eval("#stage g.node", (e) => e.length), 14);
      await page.close();
    });

    await test("U1: --vscode-* を渡せないホスト(VS / Rider)は theme メッセージで色を送れる", async () => {
      const { page } = await H.openPage(browser, port, { theme: "dark" });
      await renderIR(page, makeSampleIR());
      await H.hostPost(page, {
        type: "theme",
        kind: "light",
        variables: { "vscode-editor-background": "#fffbe6", "vscode-editor-foreground": "#222222", "vscode-editorWidget-background": "#fff1b8" },
      });
      await page.waitForFunction(
        () => getComputedStyle(document.body).backgroundColor === "rgb(255, 251, 230)",
        { timeout: 3000 },
      );
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector('#stage g.node[data-node-id="n3"] rect')).fill === "rgb(255, 241, 184)",
        { timeout: 5000 },
      );
      await page.close();
    });

    await test("300ノード超の関数でも、描画後のパン・ズーム操作が固まらない(1操作あたりのフレーム時間)", async () => {
      const { page, errors } = await H.openPage(browser, port, { width: 1280, height: 800 });
      const big = makeLargeIR(330);
      assert.ok(big.nodes.length > 300);
      const t0 = Date.now();
      await H.hostPost(page, { type: "render", ir: big, meta: { file: "Big.cs", functionName: "Big()", canJump: true } });
      await H.waitForNodes(page, big.nodes.length, 120000);
      const renderMs = Date.now() - t0;
      await sleep(400);
      const initial = await page.evaluate(() => window.__flowchartDebug().scale);
      assert.ok(initial >= 0.3, "初回は読める倍率で出す: " + initial);
      assert.equal(await page.$eval("#minimap", (e) => e.hidden), false, "続きへ移動できるようミニマップが出る");
      const startVisible = await page.evaluate(() => {
        const v = document.querySelector("#viewport").getBoundingClientRect();
        const r = document.querySelector('#stage g.node[data-node-id="n1"]').getBoundingClientRect();
        return r.top >= v.top && r.bottom <= v.bottom;
      });
      assert.equal(startVisible, true, "開始ノードが見えている");
      const stats = await page.evaluate(async () => {
        const vp = document.querySelector("#viewport");
        const frame = () => new Promise((r) => requestAnimationFrame(() => r(performance.now())));
        const times = [];
        const fire = async (init) => {
          const t = performance.now();
          vp.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 640, clientY: 400, ...init }));
          await frame();
          times.push(performance.now() - t);
        };
        for (let i = 0; i < 40; i++) await fire({ deltaY: -120, ctrlKey: true });
        for (let i = 0; i < 40; i++) await fire({ deltaY: 120, ctrlKey: true });
        for (let i = 0; i < 40; i++) await fire({ deltaX: 30, deltaY: 20 });
        times.sort((a, b) => a - b);
        return { p50: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * 0.95)], max: times[times.length - 1] };
      });
      console.log(`       330ノード: 初回描画 ${renderMs}ms / 操作 p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms max=${stats.max.toFixed(1)}ms`);
      assert.ok(stats.p95 < 100, `操作の p95 が遅い: ${stats.p95}ms`);
      assert.ok(stats.max < 400, `最大が遅い: ${stats.max}ms`);
      // 全体表示で全ノードが収まる(検証項目: 全体表示で300ノードが画面に収まる)
      await page.click("#zoom-fit");
      await sleep(150);
      const fits = await page.evaluate(() => {
        const v = document.querySelector("#viewport").getBoundingClientRect();
        const s = document.querySelector("#stage svg").getBoundingClientRect();
        return s.left >= v.left - 1 && s.right <= v.right + 1 && s.top >= v.top - 1 && s.bottom <= v.bottom + 1;
      });
      assert.equal(fits, true);
      await shot(page, "large-330");
      assert.deepEqual(errors, []);
      await page.close();
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`webview: ${passed} passed, ${failed} failed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
