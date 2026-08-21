// 共有Webviewバンドルの描画ブリッジ。
//
// 重要な制約: このファイルはホスト固有のグローバルオブジェクト
// (vscode, chrome.webview, JBCefBrowser経由のオブジェクト等)を一切参照しない。
// 各ホストアダプタは `window.postMessage({ type: "render", mermaidText }, "*")`
// 相当の呼び出しでこのバンドルにMermaidテキストを渡すだけでよい。

(function () {
  "use strict";

  function initMermaid() {
    if (typeof window.mermaid === "undefined") {
      console.error("mermaid.min.js が読み込まれていません");
      return;
    }
    window.mermaid.initialize({
      startOnLoad: false,
      theme: "default",
      securityLevel: "strict",
    });
  }

  async function renderFlowchart(mermaidText) {
    const chart = document.getElementById("chart");
    const errorBox = document.getElementById("error");
    if (!chart) return;

    errorBox.textContent = "";
    errorBox.style.display = "none";

    try {
      const { svg } = await window.mermaid.render("flowchart-svg", mermaidText);
      chart.innerHTML = svg;
    } catch (err) {
      chart.innerHTML = "";
      errorBox.style.display = "block";
      errorBox.textContent =
        "フローチャートの描画に失敗しました: " +
        (err && err.message ? err.message : String(err));
    }
  }

  function getSvgString() {
    const svg = document.querySelector("#chart svg");
    return svg ? svg.outerHTML : null;
  }

  async function getPngDataUrl() {
    const svg = document.querySelector("#chart svg");
    if (!svg) return null;

    const svgString = new XMLSerializer().serializeToString(svg);
    const svgBlob = new Blob([svgString], {
      type: "image/svg+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(svgBlob);

    try {
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = url;
      });

      const bbox = svg.getBoundingClientRect();
      const canvas = document.createElement("canvas");
      canvas.width = bbox.width || img.width;
      canvas.height = bbox.height || img.height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  window.addEventListener("message", async (event) => {
    const data = event.data || {};
    switch (data.type) {
      case "render":
        await renderFlowchart(data.mermaidText);
        break;
      case "exportSvg": {
        const svgString = getSvgString();
        window.parent.postMessage(
          { type: "exportSvgResult", svg: svgString },
          "*",
        );
        break;
      }
      case "exportPng": {
        const dataUrl = await getPngDataUrl();
        window.parent.postMessage({ type: "exportPngResult", dataUrl }, "*");
        break;
      }
      default:
        break;
    }
  });

  document.addEventListener("DOMContentLoaded", initMermaid);
})();
