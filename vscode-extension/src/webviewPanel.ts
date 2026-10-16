import * as fs from "fs";
import * as vscode from "vscode";

/**
 * Phase1で定義した共有Webviewバンドル(core/webview-bundle/)をロードするだけの薄い層。
 * バンドル自体はホスト固有APIを一切参照しないため、ここでは
 *   - バンドルの配置場所の解決とURIの書き換え
 *   - ホスト固有のCSP・送信口(media/host-shim.js)の差し込み
 *   - WebView → ホストのメッセージの振り分け
 * だけを担当する。
 *
 * VSIXパッケージング後は拡張ルート配下しか同梱できないため、`npm run package`で
 * `webview-bundle/`(無修正コピー)を生成する。存在すればそれを、
 * 開発時(F5起動)はまだ生成されていないことが多いので `../core/webview-bundle` を直接参照する。
 */

type MessageHandler = (message: any) => void | Promise<void>;

let currentPanel: vscode.WebviewPanel | undefined;
/**
 * Webview 内のスクリプト(3MB の Mermaid を含む)が読み込まれ、bridge.js が `ready` を返すまで true にならない。
 * それ以前に postMessage すると、Webview がまだメッセージを受ける準備をしておらず、最初のメッセージが失われる
 * (パネルを作った直後に図を送ると、図が出ない)。そのため準備ができるまでホスト側で溜めておく。
 */
let panelReady = false;
let pendingMessages: unknown[] = [];
/** 再読み込み(Webview が作り直された)のとき、直近の表示を復元するために覚えておく。 */
let lastRender: unknown;
let lastArchitecture: unknown;
const handlers = new Map<string, MessageHandler>();
const waiters = new Map<string, Array<(message: any) => void>>();
const createdEmitter = new vscode.EventEmitter<vscode.WebviewPanel>();

/** パネルが新しく作られたとき(初期設定を送るために使う)。 */
export const onDidCreatePanel = createdEmitter.event;

export function resolveBundleRoot(context: vscode.ExtensionContext): vscode.Uri {
  const packaged = vscode.Uri.joinPath(context.extensionUri, "webview-bundle");
  if (fs.existsSync(vscode.Uri.joinPath(packaged, "index.html").fsPath)) {
    return packaged;
  }
  return vscode.Uri.joinPath(context.extensionUri, "..", "core", "webview-bundle");
}

/** WebView からのメッセージ(`type` 単位)を受ける処理を登録する。 */
export function onWebviewMessage(type: string, handler: MessageHandler): void {
  handlers.set(type, handler);
}

export function getCurrentPanel(): vscode.WebviewPanel | undefined {
  return currentPanel;
}

export function getOrCreateFlowchartPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Beside, true);
    return currentPanel;
  }

  const bundleRoot = resolveBundleRoot(context);
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");

  const panel = vscode.window.createWebviewPanel("flowchartView", "Flowchart", vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [bundleRoot, mediaRoot],
  });

  panel.webview.html = buildHtml(panel.webview, bundleRoot, mediaRoot);
  panel.webview.onDidReceiveMessage((message) => dispatch(message));
  panel.onDidDispose(() => {
    currentPanel = undefined;
    panelReady = false;
    pendingMessages = [];
  });

  currentPanel = panel;
  panelReady = false;
  pendingMessages = [];
  createdEmitter.fire(panel);
  return panel;
}

/** 直近にホストから送ったメッセージの要約(結合テスト・診断用。大きな IR 本体は持たない)。 */
const recentPosted: Array<{ type: string; message?: string; meta?: unknown }> = [];
export function getRecentPosted(): ReadonlyArray<{ type: string; message?: string; meta?: unknown }> {
  return recentPosted;
}

export function postToPanel(message: unknown): void {
  const m = message as { type?: string; message?: string; meta?: unknown };
  recentPosted.push({ type: String(m?.type), message: m?.message, meta: m?.meta });
  if (recentPosted.length > 30) recentPosted.shift();
  if (m?.type === "render") lastRender = message;
  if (m?.type === "architecture") lastArchitecture = message;
  if (!currentPanel) return;
  if (!panelReady) {
    // 準備前は溜める。同じ種類の「最新だけ意味があるもの」は古いものを捨てる(描画が何度も走らないように)
    if (m?.type === "render" || m?.type === "error" || m?.type === "config") {
      pendingMessages = pendingMessages.filter((p) => (p as { type?: string }).type !== m.type);
    }
    pendingMessages.push(message);
    return;
  }
  void currentPanel.webview.postMessage(message);
}

/** Webview から `ready` が届いた: 溜めていたメッセージを順に送る。再読み込みなら直近の表示を復元する。 */
function onPanelReady(): void {
  if (!currentPanel) return;
  const firstLoad = !panelReady && pendingMessages.length > 0;
  panelReady = true;
  const queued = pendingMessages;
  pendingMessages = [];
  for (const message of queued) void currentPanel.webview.postMessage(message);
  if (!firstLoad && queued.length === 0) {
    // Webview が作り直された(VS Code の再起動後の復元など): 直近の図と全体ビューを送り直す
    if (lastRender) void currentPanel.webview.postMessage(lastRender);
    if (lastArchitecture) void currentPanel.webview.postMessage(lastArchitecture);
  }
}

/** 結合テスト用: Webview から届いたかのようにメッセージを処理させる(Webview の中身はテストから操作できないため)。 */
export function simulateWebviewMessage(message: unknown): void {
  dispatch(message);
}

function dispatch(message: any): void {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "ready") onPanelReady();
  const pending = waiters.get(message.type);
  if (pending && pending.length > 0) {
    pending.splice(0).forEach((resolve) => resolve(message));
  }
  const handler = handlers.get(message.type);
  if (handler) {
    Promise.resolve(handler(message)).catch((err) => console.error("[flowchart] メッセージ処理に失敗", message.type, err));
  }
}

/**
 * WebView に要求を送り、`resultType` の応答を待つ。応答が来ない場合(パネルが固まった等)に
 * 永久に待たないよう、時間切れで null を返す。
 */
export function requestFromWebview(request: unknown, resultType: string, timeoutMs = 8000): Promise<any | null> {
  return new Promise((resolve) => {
    if (!currentPanel) {
      resolve(null);
      return;
    }
    const list = waiters.get(resultType) ?? [];
    waiters.set(resultType, list);
    const entry = (message: any) => {
      clearTimeout(timer);
      resolve(message);
    };
    const timer = setTimeout(() => {
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    list.push(entry);
    void currentPanel.webview.postMessage(request);
  });
}

/**
 * バンドルの index.html を読み、
 *   - ホスト固有の CSP を <head> に挿入(VS Code の webview.cspSource を許可元にする。eval・インラインscriptは許可しない)
 *   - `./xxx` の相対参照を Webview 用 URI に書き換え
 *   - `./host-shim.js` だけは VS Code 用の media/host-shim.js に差し替え
 * する。バンドル本体(HTML/JS/CSS)のファイルには一切手を加えない。
 */
function buildHtml(webview: vscode.Webview, bundleRoot: vscode.Uri, mediaRoot: vscode.Uri): string {
  let html = fs.readFileSync(vscode.Uri.joinPath(bundleRoot, "index.html").fsPath, "utf-8");

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
  ].join("; ");
  html = html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);

  html = html.replace(/(src|href)="\.\/([\w.-]+)"/g, (_match, attr: string, file: string) => {
    const root = file === "host-shim.js" ? mediaRoot : bundleRoot;
    return `${attr}="${webview.asWebviewUri(vscode.Uri.joinPath(root, file))}"`;
  });

  return html;
}
