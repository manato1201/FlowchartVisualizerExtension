import * as fs from "fs";
import * as vscode from "vscode";

/**
 * Phase1で定義した共有Webviewバンドル(core/webview-bundle/)をロードするだけの薄い層。
 * バンドル自体はホスト固有APIを一切参照しないため、ここではURI解決と
 * postMessageによるMermaidテキストの受け渡し・エクスポート結果の受信のみを担当する。
 *
 * VSIXパッケージング後は拡張ルート配下しか同梱できないため、`npm run package`で
 * `webview-bundle/`(無修正コピー)を生成する。存在すればそれを、
 * 開発時(F5起動)はまだ生成されていないことが多いので `../core/webview-bundle` を直接参照する。
 */

let currentPanel: vscode.WebviewPanel | undefined;

function resolveBundleRoot(context: vscode.ExtensionContext): vscode.Uri {
  const packaged = vscode.Uri.joinPath(context.extensionUri, "webview-bundle");
  if (fs.existsSync(vscode.Uri.joinPath(packaged, "index.html").fsPath)) {
    return packaged;
  }
  return vscode.Uri.joinPath(
    context.extensionUri,
    "..",
    "core",
    "webview-bundle",
  );
}

export function getOrCreateFlowchartPanel(
  context: vscode.ExtensionContext,
): vscode.WebviewPanel {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Beside);
    return currentPanel;
  }

  const bundleRoot = resolveBundleRoot(context);

  const panel = vscode.window.createWebviewPanel(
    "flowchartView",
    "Flowchart",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [bundleRoot],
    },
  );

  panel.webview.html = buildHtmlWithWebviewUris(panel.webview, bundleRoot);

  panel.onDidDispose(() => {
    currentPanel = undefined;
  });

  currentPanel = panel;
  return panel;
}

export function postFlowchart(
  panel: vscode.WebviewPanel,
  mermaidText: string,
): void {
  panel.webview.postMessage({ type: "render", mermaidText });
}

export async function requestSvgExport(
  panel: vscode.WebviewPanel,
): Promise<string | null> {
  return new Promise((resolve) => {
    const sub = panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "exportSvgResult") {
        sub.dispose();
        resolve(msg.svg ?? null);
      }
    });
    panel.webview.postMessage({ type: "exportSvg" });
  });
}

export async function requestPngExport(
  panel: vscode.WebviewPanel,
): Promise<string | null> {
  return new Promise((resolve) => {
    const sub = panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "exportPngResult") {
        sub.dispose();
        resolve(msg.dataUrl ?? null);
      }
    });
    panel.webview.postMessage({ type: "exportPng" });
  });
}

/**
 * index.html内の相対参照(./mermaid.min.js, ./bridge.js)を、
 * WebviewがロードできるVSCode専用URIスキームへ書き換える。
 * バンドル本体(HTML/JS)には一切手を加えない。
 */
function buildHtmlWithWebviewUris(
  webview: vscode.Webview,
  bundleRoot: vscode.Uri,
): string {
  const htmlUri = vscode.Uri.joinPath(bundleRoot, "index.html");
  let html = fs.readFileSync(htmlUri.fsPath, "utf-8");

  const mermaidUri = webview.asWebviewUri(
    vscode.Uri.joinPath(bundleRoot, "mermaid.min.js"),
  );
  const bridgeUri = webview.asWebviewUri(
    vscode.Uri.joinPath(bundleRoot, "bridge.js"),
  );

  html = html
    .replace('src="./mermaid.min.js"', `src="${mermaidUri}"`)
    .replace('src="./bridge.js"', `src="${bridgeUri}"`);

  return html;
}
