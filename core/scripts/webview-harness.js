// 共有Webviewバンドルを実ブラウザ(Chrome / Edge、ヘッドレス)で動かすための共通ハーネス。
// puppeteer-core を使い、ブラウザ本体は同梱しない(インストール済みの Chrome / Edge を使う)。
// VS Code の Webview と同じく「厳格なCSP(インライン script・eval 禁止)」付きのHTTPで配信する。
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const BUNDLE_DIR = path.join(__dirname, "..", "webview-bundle");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// VS Code の webview.cspSource に相当する 'self' だけを許可する。unsafe-eval は許可しない。
const CSP =
  "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'";

function findBrowser() {
  const candidates = [
    process.env.FLOWCHART_TEST_BROWSER,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function startServer(extraRoutes = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const name = url.pathname === "/" ? "/index.html" : url.pathname;
    if (extraRoutes[name]) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": CSP,
      });
      res.end(extraRoutes[name]);
      return;
    }
    const file = path.join(
      BUNDLE_DIR,
      path.normalize(name).replace(/^(\.\.[/\\])+/, ""),
    );
    if (
      !file.startsWith(BUNDLE_DIR) ||
      !fs.existsSync(file) ||
      fs.statSync(file).isDirectory()
    ) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "content-security-policy": CSP,
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port }),
    );
  });
}

/** VS Code が実際に渡す --vscode-* 変数の代表値(ライト / ダーク / 高コントラスト)。 */
const THEMES = {
  light: {
    kind: "vscode-light",
    vars: {
      "vscode-editor-background": "#ffffff",
      "vscode-editor-foreground": "#000000",
      "vscode-descriptionForeground": "#717171",
      "vscode-panel-border": "#80808059",
      "vscode-editorWidget-background": "#f3f3f3",
      "vscode-editorWidget-border": "#c8c8c8",
      "vscode-focusBorder": "#0090f1",
      "vscode-button-background": "#007acc",
      "vscode-button-foreground": "#ffffff",
      "vscode-button-secondaryBackground": "#5f6a79",
      "vscode-button-secondaryForeground": "#ffffff",
      "vscode-button-secondaryHoverBackground": "#4c5561",
      "vscode-inputValidation-errorBackground": "#f2dede",
      "vscode-inputValidation-errorBorder": "#be1100",
      "vscode-errorForeground": "#a1260d",
      "vscode-foreground": "#616161",
      "vscode-gitDecoration-addedResourceForeground": "#587c0c",
      "vscode-gitDecoration-deletedResourceForeground": "#ad0707",
      "vscode-gitDecoration-modifiedResourceForeground": "#895503",
      "vscode-font-family": "'Segoe UI', sans-serif",
      "vscode-editor-font-family": "Consolas, 'Courier New', monospace",
    },
  },
  dark: {
    kind: "vscode-dark",
    vars: {
      "vscode-editor-background": "#1e1e1e",
      "vscode-editor-foreground": "#d4d4d4",
      "vscode-descriptionForeground": "#ccccccb3",
      "vscode-panel-border": "#80808059",
      "vscode-editorWidget-background": "#252526",
      "vscode-editorWidget-border": "#454545",
      "vscode-focusBorder": "#007fd4",
      "vscode-button-background": "#0e639c",
      "vscode-button-foreground": "#ffffff",
      "vscode-button-secondaryBackground": "#3a3d41",
      "vscode-button-secondaryForeground": "#ffffff",
      "vscode-button-secondaryHoverBackground": "#45494e",
      "vscode-inputValidation-errorBackground": "#5a1d1d",
      "vscode-inputValidation-errorBorder": "#be1100",
      "vscode-errorForeground": "#f48771",
      "vscode-foreground": "#cccccc",
      "vscode-gitDecoration-addedResourceForeground": "#81b88b",
      "vscode-gitDecoration-deletedResourceForeground": "#c74e39",
      "vscode-gitDecoration-modifiedResourceForeground": "#e2c08d",
      "vscode-font-family": "'Segoe UI', sans-serif",
      "vscode-editor-font-family": "Consolas, 'Courier New', monospace",
    },
  },
  hcDark: {
    kind: "vscode-high-contrast",
    vars: {
      "vscode-editor-background": "#000000",
      "vscode-editor-foreground": "#ffffff",
      "vscode-descriptionForeground": "#ffffff",
      "vscode-panel-border": "#6fc3df",
      "vscode-contrastBorder": "#6fc3df",
      "vscode-editorWidget-background": "#0c141f",
      "vscode-editorWidget-border": "#6fc3df",
      "vscode-focusBorder": "#f38518",
      "vscode-button-background": "#000000",
      "vscode-button-foreground": "#ffffff",
      "vscode-button-secondaryBackground": "#000000",
      "vscode-button-secondaryForeground": "#ffffff",
      "vscode-button-secondaryHoverBackground": "#1a1a1a",
      "vscode-inputValidation-errorBackground": "#000000",
      "vscode-inputValidation-errorBorder": "#f48771",
      "vscode-errorForeground": "#f48771",
      "vscode-foreground": "#ffffff",
      "vscode-gitDecoration-addedResourceForeground": "#a1e3ad",
      "vscode-gitDecoration-deletedResourceForeground": "#c74e39",
      "vscode-gitDecoration-modifiedResourceForeground": "#e2c08d",
      "vscode-font-family": "'Segoe UI', sans-serif",
      "vscode-editor-font-family": "Consolas, 'Courier New', monospace",
    },
  },
  hcLight: {
    kind: "vscode-high-contrast vscode-high-contrast-light",
    vars: {
      "vscode-editor-background": "#ffffff",
      "vscode-editor-foreground": "#292929",
      "vscode-descriptionForeground": "#292929",
      "vscode-panel-border": "#0f4a85",
      "vscode-contrastBorder": "#0f4a85",
      "vscode-editorWidget-background": "#ffffff",
      "vscode-editorWidget-border": "#0f4a85",
      "vscode-focusBorder": "#006bbd",
      "vscode-button-background": "#ffffff",
      "vscode-button-foreground": "#292929",
      "vscode-button-secondaryBackground": "#ffffff",
      "vscode-button-secondaryForeground": "#292929",
      "vscode-button-secondaryHoverBackground": "#e8e8e8",
      "vscode-inputValidation-errorBackground": "#ffffff",
      "vscode-inputValidation-errorBorder": "#b5200d",
      "vscode-errorForeground": "#b5200d",
      "vscode-foreground": "#292929",
      "vscode-gitDecoration-addedResourceForeground": "#374e06",
      "vscode-gitDecoration-deletedResourceForeground": "#ad0707",
      "vscode-gitDecoration-modifiedResourceForeground": "#895503",
      "vscode-font-family": "'Segoe UI', sans-serif",
      "vscode-editor-font-family": "Consolas, 'Courier New', monospace",
    },
  },
};

/**
 * 新しいページを開く。VS Code と同じく、ホスト側が <body> のクラスと --vscode-* 変数を
 * ドキュメント生成時に付ける状況を再現する。window.flowchartHostPost はホストの送信口の代役。
 */
async function openPage(
  browser,
  port,
  { theme = "dark", width = 1100, height = 760, reducedMotion = false } = {},
) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  if (reducedMotion) {
    await page.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
  }
  const t = THEMES[theme];
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    const text = m.text();
    const benign = /favicon|404 \(Not Found\)/.test(text); // favicon.ico が無いだけ
    if ((m.type() === "error" && !benign) || /Content Security Policy/i.test(text))
      errors.push("console: " + text);
  });
  page.on("requestfailed", (r) => errors.push("requestfailed: " + r.url()));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) errors.push(`http ${r.status()}: ${r.url()}`);
  });
  await page.evaluateOnNewDocument(
    (vars, kind) => {
      window.__sent = [];
      window.flowchartHostPost = (m) => window.__sent.push(m);
      // ドキュメント生成直後は <html>/<body> がまだ無いので、DOMContentLoaded で付ける
      // (VS Code はスクリプトより前に付けるが、バンドル側は最初の描画時にしか色を読まない)
      document.addEventListener("DOMContentLoaded", () => {
        for (const [k, v] of Object.entries(vars))
          document.documentElement.style.setProperty("--" + k, v);
        document.body.className = kind;
      });
    },
    t.vars,
    t.kind,
  );
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
  return { page, errors };
}

/** ホスト → Webview のメッセージ送信(VS Code の panel.webview.postMessage 相当)。 */
async function hostPost(page, message) {
  await page.evaluate((m) => window.postMessage(m, "*"), message);
}

async function setTheme(page, theme) {
  const t = THEMES[theme];
  await page.evaluate(
    (vars, kind) => {
      for (const [k, v] of Object.entries(vars))
        document.documentElement.style.setProperty("--" + k, v);
      document.body.className = kind;
    },
    t.vars,
    t.kind,
  );
}

async function sent(page) {
  return page.evaluate(() => window.__sent.slice());
}

async function waitForNodes(page, count, timeout = 30000) {
  await page.waitForFunction(
    (n) => document.querySelectorAll("#stage g.node").length === n,
    { timeout },
    count,
  );
}

module.exports = {
  findBrowser,
  startServer,
  openPage,
  hostPost,
  setTheme,
  sent,
  waitForNodes,
  THEMES,
  BUNDLE_DIR,
};
