// 共有Webviewバンドルの描画ブリッジ(3ホスト共通)。
//
// 重要な制約: このファイルはホスト固有のグローバルオブジェクト
// (vscode, chrome.webview, JBCefBrowser経由のオブジェクト等)を一切参照しない。
// WebView → ホストの送信は window.flowchartHostPost(message) だけを使い、
// その定義はホストアダプタが差し込む(host-shim.js)。ホスト → WebView は
// window.postMessage 相当で次のメッセージを送る:
//
//   {type:"render", ir, meta, view?}      IR を描く(ビュー切替・差分・ジャンプが有効)
//   {type:"render", mermaidText, meta}    Mermaid テキストだけ描く(旧形式。フロービューのみ)
//   {type:"error", message, retry?}       図の上に帯でエラーを出す(図は消さない)
//   {type:"clearError"}
//   {type:"theme", variables?, kind?}     ホストが --vscode-* 相当の値を渡せない場合の色指定
//   {type:"config", followCursor?}
//   {type:"architecture", model}          CodeBoarding の analysis.json を変換したモデル(全体ビュー)
//   {type:"exportSvg"} / {type:"exportPng"}   書き出し要求(結果は *Result で返す)
//
// WebView → ホスト:
//   {type:"jump", line, nodeId}   {type:"copyText", text}   {type:"saveImage", format, data}
//   {type:"requestAction", action:"retry"|"generate"|"loadArchitecture"}
//   {type:"openFunction", path, line}   {type:"exportSvgResult"|"exportPngResult", ...}

(function () {
  "use strict";

  var Views = window.FlowchartViews;
  var Motion = window.FlowchartMotion;
  var VP = window.FlowchartViewport;
  var $ = function (id) {
    return document.getElementById(id);
  };

  var KIND_LABEL = {
    start: "開始",
    end: "終了",
    process: "処理",
    decision: "分岐",
    loop: "繰り返し",
    ioOperation: "入出力",
  };

  var state = {
    ir: null, // FlowchartIR(差分付きの場合あり)
    rawText: null, // IR なしで Mermaid テキストだけ渡された場合
    meta: {},
    view: "flow",
    architecture: null,
    config: { followCursor: false },
    showing: "empty", // "empty" | "diagram" | "overview"
    renderSeq: 0,
    contentSig: "", // file + function + view。変わったときだけ全体表示に戻し、順次表示を走らせる
    nodeInfo: {}, // 表示中ノード id -> IR ノード
    projected: null,
    cleanMermaid: "",
    player: null,
    bannerMode: null, // "host" | "render" | null
    lastPaletteSig: "",
  };

  var stage = $("stage");
  var viewportEl = $("viewport");

  function post(message) {
    if (typeof window.flowchartHostPost === "function") window.flowchartHostPost(message);
  }

  // ------------------------------------------------------------------ テーマ (U1)

  var colorCtx = null;
  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  /** 任意のCSS色 → "#rrggbb" か "rgba(...)"。色名・rgb()・hsl() などをそろえる。 */
  function normalizeColor(c) {
    if (!colorCtx) colorCtx = document.createElement("canvas").getContext("2d");
    colorCtx.fillStyle = "#000000";
    colorCtx.fillStyle = c || "#000000";
    return colorCtx.fillStyle;
  }
  /** [r, g, b, a]。canvas が正規化した "#rrggbb" か "rgba(...)" を読む。 */
  function rgbaOf(c) {
    var n = normalizeColor(c);
    var m = /^#([0-9a-f]{6})$/i.exec(n);
    if (m) {
      var v = parseInt(m[1], 16);
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 1];
    }
    var r = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(n);
    return r ? [+r[1], +r[2], +r[3], r[4] === undefined ? 1 : +r[4]] : [0, 0, 0, 1];
  }
  /** 半透明の色は over(背景)に合成して [r, g, b] にする。 */
  function rgbOf(c, over) {
    var f = rgbaOf(c);
    if (f[3] >= 1 || !over) return [f[0], f[1], f[2]];
    var b = rgbOf(over);
    return [0, 1, 2].map(function (i) {
      return Math.round(f[i] * f[3] + b[i] * (1 - f[3]));
    });
  }
  function toHex(rgb) {
    return (
      "#" +
      rgb
        .map(function (v) {
          return ("0" + v.toString(16)).slice(-2);
        })
        .join("")
    );
  }
  function luminance(rgb) {
    var f = rgb.map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  }
  /** WCAG のコントラスト比 */
  function contrast(a, b) {
    var la = luminance(rgbOf(a, b));
    var lb = luminance(rgbOf(b));
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  /**
   * fg が bg 上で min 以上のコントラストにならなければ、黒か白に置き換える(高コントラストでも文字が読める)。
   * 半透明の色は背景に合成した不透明色で返す(Mermaid へ渡す色を確定させるため)。
   */
  function ensureContrast(fg, bg, min) {
    if (contrast(fg, bg) >= min) return toHex(rgbOf(fg, bg));
    return contrast("#000000", bg) >= contrast("#ffffff", bg) ? "#000000" : "#ffffff";
  }
  /**
   * 補助文字(灰色)は、ホストの値が面(バー・ツールチップ)の上で基準に届かないことがある
   * (VS Code 既定のライトテーマの descriptionForeground は #f3f3f3 の上で 4.4:1)。
   * その場合だけ --fv-muted-ui で上書きする。値が同じなら書き込まない(MutationObserver の連鎖防止)。
   */
  function applyUiContrast(bg, hc) {
    var min = hc ? 7 : 4.5;
    var surface = normalizeColor(css("--fv-surface"));
    var muted = ensureContrast(ensureContrast(css("--fv-muted"), bg, min), surface, min);
    var style = document.documentElement.style;
    var set = function (name, value) {
      if (style.getPropertyValue(name) !== value) style.setProperty(name, value);
    };
    set("--fv-muted-ui", muted);
    // 帯の文字も、ホストの組み合わせが基準に届かなければ補正する(高コントラスト(明)の errorForeground は 6.6:1)
    set("--fv-error-text", ensureContrast(css("--fv-error-fg"), normalizeColor(css("--fv-error-bg")), min));
    set("--fv-info-text", ensureContrast(css("--fv-info-fg"), normalizeColor(css("--fv-info-bg")), min));
  }
  function isHighContrast() {
    var c = document.body.classList;
    return c.contains("vscode-high-contrast") || c.contains("vscode-high-contrast-light");
  }

  function readPalette() {
    var hc = isHighContrast();
    var bg = normalizeColor(css("--fv-bg"));
    applyUiContrast(bg, hc);
    var node = normalizeColor(css("--fv-node"));
    var textMin = hc ? 7 : 4.5;
    var p = {
      bg: bg,
      node: node,
      text: ensureContrast(css("--fv-fg"), node, textMin),
      labelText: ensureContrast(css("--fv-fg"), bg, textMin),
      nodeBorder: ensureContrast(css("--fv-node-border"), bg, 3),
      line: ensureContrast(css("--fv-muted"), bg, hc ? 7 : 3),
      mono: css("--fv-mono") || "monospace",
      added: ensureContrast(css("--fv-added"), bg, 3),
      removed: ensureContrast(css("--fv-removed"), bg, 3),
      changed: ensureContrast(css("--fv-changed"), bg, 3),
      hc: hc,
    };
    return p;
  }

  function mermaidConfig(p) {
    return {
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: p.mono,
      themeVariables: {
        background: p.bg,
        fontFamily: p.mono,
        fontSize: "13px",
        primaryColor: p.node,
        secondaryColor: p.node,
        tertiaryColor: p.node,
        mainBkg: p.node,
        primaryTextColor: p.text,
        nodeTextColor: p.text,
        textColor: p.labelText,
        labelTextColor: p.labelText,
        primaryBorderColor: p.nodeBorder,
        nodeBorder: p.nodeBorder,
        lineColor: p.line,
        edgeLabelBackground: p.bg,
      },
      flowchart: {
        htmlLabels: false, // 文字を SVG のテキストにする(画像書き出し・ミニマップが安全で、色の指定も確実)
        useMaxWidth: false,
        curve: "basis",
        nodeSpacing: 36,
        rankSpacing: 44,
        padding: 8,
      },
      maxTextSize: 2000000,
      maxEdges: 10000,
    };
  }

  function applyThemeMessage(d) {
    var root = document.documentElement;
    if (d.variables) {
      Object.keys(d.variables).forEach(function (k) {
        root.style.setProperty("--" + k.replace(/^--/, ""), d.variables[k]);
      });
    }
    if (d.kind) {
      var c = document.body.classList;
      ["vscode-light", "vscode-dark", "vscode-high-contrast", "vscode-high-contrast-light"].forEach(function (n) {
        c.remove(n);
      });
      c.add(
        {
          light: "vscode-light",
          dark: "vscode-dark",
          "high-contrast": "vscode-high-contrast",
          "high-contrast-light": "vscode-high-contrast-light",
        }[d.kind] || "vscode-dark",
      );
    }
  }

  var themeTimer = 0;
  function onThemeMaybeChanged() {
    clearTimeout(themeTimer);
    themeTimer = setTimeout(function () {
      var sig = JSON.stringify(readPalette());
      if (sig === state.lastPaletteSig) return;
      state.lastPaletteSig = sig;
      if (state.showing === "diagram") renderDiagram({ fit: false, animate: false });
    }, 80);
  }
  new MutationObserver(onThemeMaybeChanged).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(onThemeMaybeChanged).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class"],
  });
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", onThemeMaybeChanged);
  }

  // ------------------------------------------------------------------ 表示部品

  var viewport = VP.createViewport({
    viewport: viewportEl,
    stage: stage,
    minimap: { root: $("minimap"), img: $("minimap").querySelector("img"), view: $("minimap").querySelector(".mm-view") },
    onChange: function (s) {
      $("zoom-level").textContent = Math.round(s.scale * 100) + "%";
    },
  });
  $("minimap").setAttribute("data-no-pan", "");

  function showPane(which) {
    state.showing = which;
    $("empty").hidden = which !== "empty";
    $("overview").hidden = which !== "overview";
    stage.hidden = which !== "diagram";
    if (which !== "diagram") $("minimap").hidden = true;
    $("overview").setAttribute("data-no-pan", "");
    renderBreadcrumb();
    updateControls();
  }

  function updateControls() {
    var hasDiagram = !!(state.ir || state.rawText);
    var diagramShown = state.showing === "diagram";
    $("btn-copy").disabled = !hasDiagram;
    $("btn-save").disabled = !diagramShown;
    $("btn-play").disabled = !diagramShown || !state.ir;
    ["zoom-in", "zoom-out", "zoom-fit"].forEach(function (id) {
      $(id).disabled = !diagramShown;
    });
    var reduced = Motion.reducedMotion();
    $("btn-play").title = reduced
      ? "動きを減らす設定のため、通る経路をまとめて強調表示します"
      : state.player
        ? "再生を止める"
        : "実行順に再生";
    renderViewTabs();
  }

  // ---- ビュー切替(セグメントコントロール) ----
  function renderViewTabs() {
    var root = $("views");
    var canSwitch = !!state.ir;
    if (!root.children.length) {
      Views.VIEW_ORDER.forEach(function (id) {
        var b = document.createElement("button");
        b.type = "button";
        b.setAttribute("role", "radio");
        b.dataset.view = id;
        b.textContent = Views.VIEWS[id].label;
        b.addEventListener("click", function () {
          setView(id);
        });
        b.addEventListener("keydown", function (e) {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          var order = Views.VIEW_ORDER;
          var next = order[(order.indexOf(id) + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
          if (state.ir) setView(next);
          var nb = root.querySelector('[data-view="' + next + '"]');
          if (nb) nb.focus();
          e.preventDefault();
        });
        root.appendChild(b);
      });
    }
    Array.prototype.forEach.call(root.children, function (b) {
      var id = b.dataset.view;
      var selected = id === state.view && state.showing !== "overview";
      b.setAttribute("aria-checked", String(selected));
      b.tabIndex = selected ? 0 : -1;
      b.disabled = !canSwitch && id !== "flow";
      var n = state.ir ? Views.countVisible(state.ir, id) : null;
      b.title =
        Views.VIEWS[id].description +
        (n !== null ? "(" + n + "ノード)" : id !== "flow" ? "(このホストはIRを送っていないため切り替えできません)" : "");
    });
  }

  function setView(id) {
    if (!Views.VIEWS[id]) return;
    if (state.showing === "overview") {
      if (!state.ir && !state.rawText) return;
      state.view = id;
      showPane("diagram");
      renderDiagram({ fit: true, animate: true });
      return;
    }
    if (id === state.view) return;
    state.view = id;
    stopPlayback();
    renderDiagram({ fit: true, animate: true });
  }

  // ---- パンくず(全体 › ファイル › 関数) ----
  function chevron() {
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("class", "icon");
    var u = document.createElementNS("http://www.w3.org/2000/svg", "use");
    u.setAttribute("href", "#i-chev-right");
    s.appendChild(u);
    var span = document.createElement("span");
    span.className = "sep";
    span.setAttribute("aria-hidden", "true");
    span.appendChild(s);
    return span;
  }
  function renderBreadcrumb() {
    var nav = $("breadcrumb");
    nav.textContent = "";
    var crumbs = [];
    var archReady = !!state.architecture;
    var overview = state.showing === "overview";
    crumbs.push({ label: "全体", action: archReady && !overview ? "overview" : null, current: overview });
    if (!overview) {
      if (state.meta.file) crumbs.push({ label: state.meta.file, action: archReady ? "overview" : null });
      if (state.meta.functionName) crumbs.push({ label: state.meta.functionName, current: true });
    }
    crumbs.forEach(function (c, i) {
      if (i > 0) nav.appendChild(chevron());
      var el;
      if (c.action) {
        el = document.createElement("button");
        el.type = "button";
        el.addEventListener("click", function () {
          showOverview();
        });
        el.title = "CodeBoarding の解析結果(全体)を開く";
      } else {
        el = document.createElement("span");
        if (c.label === "全体" && !archReady) {
          el.title = "CodeBoarding の analysis.json を読み込むと、全体から掘り下げられます";
        }
      }
      el.className = "crumb";
      el.textContent = c.label;
      if (c.current) el.setAttribute("aria-current", "page");
      nav.appendChild(el);
    });
  }

  // ---- 帯(エラー・通知) ----
  function showBanner(text, opts) {
    var o = opts || {};
    $("banner").hidden = false;
    $("banner").dataset.kind = o.kind || "error";
    $("banner-text").textContent = text;
    $("banner-retry").hidden = !o.retry;
    state.bannerMode = o.mode || "host";
  }
  function hideBanner(mode) {
    if (mode && state.bannerMode !== mode) return;
    $("banner").hidden = true;
    state.bannerMode = null;
  }
  $("banner-close").addEventListener("click", function () {
    hideBanner();
  });
  $("banner-retry").addEventListener("click", function () {
    if (state.bannerMode === "render") renderDiagram({ fit: false, animate: false });
    else post({ type: "requestAction", action: "retry" });
  });

  // ---- 空状態 ----
  function updateEmptyText() {
    $("empty-lead").textContent = state.config.followCursor
      ? "関数にカーソルを置くと図が出ます"
      : "関数にカーソルを置いて、図を生成します";
    $("empty-sub").textContent = state.config.followCursor
      ? ""
      : "自動では更新されません。下のボタン、またはエディタの右クリックメニュー「Flowchart」から生成できます。";
  }
  $("empty-generate").addEventListener("click", function () {
    post({ type: "requestAction", action: "generate" });
  });

  // ------------------------------------------------------------------ 描画

  function diffColors(p) {
    return { added: p.added, removed: p.removed, changed: p.changed };
  }

  var renderQueue = Promise.resolve();
  function renderDiagram(opts) {
    // 1回の失敗(想定外の例外)が、以降の描画を巻き込んで止めないようにする
    renderQueue = renderQueue
      .then(function () {
        return doRender(opts || {});
      })
      .catch(function (err) {
        showBanner("図の描画に失敗しました: " + (err && err.message ? err.message : String(err)), {
          retry: true,
          mode: "render",
        });
      });
    return renderQueue;
  }

  async function doRender(opts) {
    var seq = ++state.renderSeq;
    var p = readPalette();
    state.lastPaletteSig = JSON.stringify(p);
    var text;
    var clean;
    state.projected = null;
    if (state.ir) {
      state.projected = Views.projectView(state.ir, state.view);
      text = Views.emitMermaid(state.ir, {
        view: state.view,
        lineNumbers: true,
        maxLabel: 34,
        diffColors: diffColors(p),
      });
      clean = Views.emitMermaid(state.ir, { view: state.view, diffColors: diffColors(p) });
    } else if (state.rawText) {
      text = clean = state.rawText;
    } else {
      showPane("empty");
      return;
    }
    state.cleanMermaid = clean;

    var id = "fv-svg-" + seq;
    try {
      window.mermaid.initialize(mermaidConfig(p));
      var out = await window.mermaid.render(id, text);
      if (seq !== state.renderSeq) return; // 新しい描画が始まっていたら捨てる
      stage.innerHTML = out.svg;
      hideBanner("render");
      afterRender(opts);
    } catch (err) {
      // 図の中にエラーは出さない。前の図を残したまま、図の上に帯で出す。
      var leftover = document.getElementById("d" + id);
      if (leftover) leftover.remove();
      if (seq !== state.renderSeq) return;
      var msg = err && err.message ? err.message : String(err);
      showBanner("図の描画に失敗しました: " + msg.split("\n")[0], { retry: true, mode: "render" });
    }
  }

  /**
   * Mermaid は SVG テキストモード(htmlLabels:false)だと、`#lt;` のようなエンティティを
   * `&lt;` という文字列のまま <text> に入れてしまう(画面に「&lt;」と出る)。
   * 描画後に、エミッターが付けた4種(& < > ")だけを元の文字へ戻す。1回の置換で行うため、
   * ソース中の `&lt;` という文字列そのもの(`#amp;lt;` で送っている)は壊れない。
   */
  var ENTITY = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"' };
  function decodeLabelEntities(svg) {
    var texts = svg.querySelectorAll("text, tspan");
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i];
      if (t.children.length === 0 && t.textContent.indexOf("&") >= 0) {
        t.textContent = t.textContent.replace(/&(lt|gt|amp|quot);/g, function (m) {
          return ENTITY[m];
        });
      }
    }
  }

  function afterRender(opts) {
    var svg = stage.querySelector("svg");
    if (!svg) return;
    decodeLabelEntities(svg);
    var vb = svg.viewBox && svg.viewBox.baseVal;
    var w = vb && vb.width ? vb.width : svg.getBoundingClientRect().width;
    var h = vb && vb.height ? vb.height : svg.getBoundingClientRect().height;
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.style.maxWidth = "none";
    viewport.setContent(w, h);

    // ノード ↔ IR の対応(クリックでジャンプ・ホバーで全文)
    state.nodeInfo = {};
    if (state.projected) {
      state.projected.nodes.forEach(function (n) {
        state.nodeInfo[n.id] = n;
      });
    }
    var nodeEls = stage.querySelectorAll("g.node");
    for (var i = 0; i < nodeEls.length; i++) {
      var m = /^flowchart-(.+)-\d+$/.exec(nodeEls[i].id || "");
      if (m) {
        nodeEls[i].dataset.nodeId = m[1];
        if (state.nodeInfo[m[1]] && state.nodeInfo[m[1]].diff) {
          nodeEls[i].dataset.diff = state.nodeInfo[m[1]].diff;
        }
      }
    }
    viewportEl.dataset.jump = String(!!state.meta.canJump);

    var sig = [state.meta.file, state.meta.functionName, state.view, state.meta.mode].join("|");
    var contentChanged = sig !== state.contentSig;
    state.contentSig = sig;
    showPane("diagram");
    if (opts.fit || contentChanged) viewport.fit({ initial: true });
    else viewport.refresh();
    if (opts.animate !== false && contentChanged) Motion.staggerIn(stage);

    // ミニマップは描画のたびに1回だけ画像化(操作中は枠を動かすだけ)
    scheduleMinimap(svg);

    // ホストへ描画完了を知らせる(ホストの準備確認・結合テストで使う)
    post({
      type: "rendered",
      view: state.view,
      mode: state.meta.mode || "flow",
      functionName: state.meta.functionName || null,
      nodeCount: Object.keys(state.nodeInfo).length || stage.querySelectorAll("g.node").length,
    });
  }

  var minimapTimer = 0;
  function scheduleMinimap(svg) {
    clearTimeout(minimapTimer);
    minimapTimer = setTimeout(function () {
      var xml = serializeSvg(svg, true);
      var blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
      viewport.setMinimapImage(URL.createObjectURL(blob));
    }, 30);
  }

  // ------------------------------------------------------------------ ツールチップとジャンプ

  var tooltip = $("tooltip");
  function nodeFromEvent(e) {
    var n = e.target.closest ? e.target.closest("g.node") : null;
    return n && stage.contains(n) ? n : null;
  }
  function showTooltip(nodeEl, e) {
    var info = state.nodeInfo[nodeEl.dataset.nodeId];
    if (!info) return;
    tooltip.textContent = "";
    var meta = document.createElement("span");
    meta.className = "tt-meta";
    var parts = [KIND_LABEL[info.kind] || info.kind];
    if (info.sourceRange && info.sourceRange.startLine > 0) parts.push("L" + info.sourceRange.startLine);
    if (info.diff && info.diff !== "unchanged") {
      parts.push({ added: "追加", removed: "削除", changed: "変更" }[info.diff]);
    }
    meta.textContent = parts.join(" · ");
    var code = document.createElement("code");
    code.className = "tt-code";
    code.textContent = info.label;
    tooltip.appendChild(meta);
    tooltip.appendChild(code);
    if (info.previousLabel) {
      var prev = document.createElement("code");
      prev.className = "tt-prev";
      prev.textContent = info.previousLabel;
      tooltip.appendChild(prev);
    }
    tooltip.hidden = false;
    moveTooltip(e);
  }
  function moveTooltip(e) {
    var pad = 12;
    var w = tooltip.offsetWidth;
    var h = tooltip.offsetHeight;
    var x = e.clientX + pad;
    var y = e.clientY + pad + 4;
    if (x + w > window.innerWidth - 4) x = Math.max(4, e.clientX - w - pad);
    if (y + h > window.innerHeight - 4) y = Math.max(4, e.clientY - h - pad);
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
  }
  viewportEl.addEventListener("pointerover", function (e) {
    var n = nodeFromEvent(e);
    if (n) showTooltip(n, e);
  });
  viewportEl.addEventListener("pointermove", function (e) {
    if (!tooltip.hidden) moveTooltip(e);
  });
  viewportEl.addEventListener("pointerout", function (e) {
    if (nodeFromEvent(e)) tooltip.hidden = true;
  });
  viewportEl.addEventListener("pointerdown", function () {
    tooltip.hidden = true;
  });

  var selectedEl = null;
  viewportEl.addEventListener("click", function (e) {
    var n = nodeFromEvent(e);
    if (!n) return;
    if (selectedEl) selectedEl.classList.remove("selected");
    selectedEl = n;
    n.classList.add("selected");
    var info = state.nodeInfo[n.dataset.nodeId];
    if (!info || !state.meta.canJump) return;
    if (info.diff === "removed") return; // 削除されたノードは現在のファイルに行がない
    var line = info.sourceRange && info.sourceRange.startLine;
    if (line > 0) post({ type: "jump", line: line, nodeId: info.id });
  });

  // ------------------------------------------------------------------ 再生 (X4: ライン描画)

  function stopPlayback() {
    if (state.player) {
      state.player.cancel();
      state.player = null;
    }
    setPlayButton(false);
  }
  function setPlayButton(playing) {
    $("btn-play").querySelector("use").setAttribute("href", playing ? "#i-stop" : "#i-play");
    $("btn-play-label").textContent = playing ? "停止" : "再生";
    $("btn-play").title = playing ? "再生を止める" : "実行順に再生";
  }
  $("btn-play").addEventListener("click", function () {
    if (state.player) {
      stopPlayback();
      return;
    }
    if (!state.projected) return;
    var order = Views.executionOrder(state.projected);
    var edgeIndex = new Map();
    state.projected.edges.forEach(function (e, i) {
      edgeIndex.set(e, i);
    });
    var paths = stage.querySelectorAll(".edgePaths path");
    var labels = stage.querySelectorAll(".edgeLabels .edgeLabel");
    var nodesById = {};
    stage.querySelectorAll("g.node").forEach(function (el) {
      nodesById[el.dataset.nodeId] = el;
    });
    var steps = order.map(function (e) {
      var i = edgeIndex.get(e);
      return {
        edgeEl: paths[i] || null,
        edgeLabelEl: labels[i] || null,
        toEl: nodesById[e.to] || null,
      };
    });
    var startNode = state.projected.nodes.filter(function (n) {
      return n.kind === "start";
    })[0];
    state.player = Motion.playSteps(stage, steps, startNode ? nodesById[startNode.id] : null);
    setPlayButton(true);
    var current = state.player;
    current.promise.then(function () {
      if (state.player === current) {
        state.player = null;
        setPlayButton(false);
      }
    });
  });

  // ------------------------------------------------------------------ 書き出し

  function serializeSvg(svg, forMinimap) {
    var clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    var vb = svg.viewBox.baseVal;
    var bg = readPalette().bg;
    var rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(vb.x));
    rect.setAttribute("y", String(vb.y));
    rect.setAttribute("width", String(vb.width));
    rect.setAttribute("height", String(vb.height));
    rect.setAttribute("fill", bg);
    clone.insertBefore(rect, clone.firstChild);
    if (!forMinimap) clone.removeAttribute("style");
    // 動き・選択の一時状態は書き出さない
    clone.querySelectorAll(".selected,.lit").forEach(function (el) {
      el.classList.remove("selected", "lit");
    });
    return new XMLSerializer().serializeToString(clone);
  }
  function currentSvgString() {
    var svg = stage.querySelector("svg");
    return svg ? serializeSvg(svg, false) : null;
  }
  async function currentPngDataUrl() {
    var svg = stage.querySelector("svg");
    if (!svg) return null;
    var vb = svg.viewBox.baseVal;
    var scale = Math.min(2, 8192 / Math.max(vb.width, vb.height));
    var url = URL.createObjectURL(new Blob([serializeSvg(svg, false)], { type: "image/svg+xml;charset=utf-8" }));
    try {
      var img = await new Promise(function (resolve, reject) {
        var im = new Image();
        im.onload = function () {
          resolve(im);
        };
        im.onerror = reject;
        im.src = url;
      });
      var canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vb.width * scale);
      canvas.height = Math.ceil(vb.height * scale);
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = readPalette().bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  $("btn-copy").addEventListener("click", function () {
    if (state.cleanMermaid) post({ type: "copyText", text: state.cleanMermaid });
  });
  function setMenu(open) {
    $("save-wrap").dataset.open = String(open);
    $("save-menu").hidden = !open;
    $("btn-save").setAttribute("aria-expanded", String(open));
  }
  $("btn-save").addEventListener("click", function (e) {
    e.stopPropagation();
    setMenu($("save-menu").hidden);
  });
  document.addEventListener("click", function () {
    setMenu(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") setMenu(false);
  });
  $("save-menu").addEventListener("click", async function (e) {
    var b = e.target.closest("button[data-save]");
    if (!b) return;
    setMenu(false);
    if (b.dataset.save === "svg") {
      var svg = currentSvgString();
      if (svg) post({ type: "saveImage", format: "svg", data: svg });
    } else {
      try {
        var data = await currentPngDataUrl();
        if (data) post({ type: "saveImage", format: "png", data: data });
      } catch (err) {
        showBanner("PNGの作成に失敗しました: " + (err && err.message ? err.message : err), { mode: "host" });
      }
    }
  });

  // ---- ズーム ----
  $("zoom-in").addEventListener("click", function () {
    viewport.zoomBy(1.25);
  });
  $("zoom-out").addEventListener("click", function () {
    viewport.zoomBy(0.8);
  });
  $("zoom-fit").addEventListener("click", function () {
    viewport.fit();
  });

  // ------------------------------------------------------------------ 全体 (X2: CodeBoarding)

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function showOverview() {
    if (!state.architecture) return;
    stopPlayback();
    buildOverview(state.architecture);
    showPane("overview");
    post({ type: "architectureShown", components: state.architecture.components.length });
  }

  function buildOverview(model) {
    var root = $("overview");
    root.textContent = "";
    root.appendChild(el("h2", "", model.repoName ? "全体 — " + model.repoName : "全体"));
    // 誠実な注記(原則P9): どこから来た情報で、いつ時点のものか
    var when = model.generatedAt ? "(生成: " + model.generatedAt.slice(0, 10) + ")" : "";
    root.appendChild(
      el("p", "note", "CodeBoarding の解析結果" + when + "。コードの現状と異なる場合があります。"),
    );
    if (model.warnings && model.warnings.length) {
      root.appendChild(el("p", "note", "読み飛ばした項目: " + model.warnings.length + " 件"));
    }

    var currentFile = state.meta.file || "";
    var ul = el("ul", "tree");
    model.components.forEach(function (c) {
      ul.appendChild(componentNode(c, currentFile));
    });
    root.appendChild(ul);

    if (model.relations && model.relations.length) {
      root.appendChild(el("h3", "", "コンポーネントの関係"));
      var rl = el("ul", "rels");
      model.relations.slice(0, 200).forEach(function (r) {
        var li = el("li", "rel");
        li.appendChild(el("span", "", r.fromName));
        var arrow = el("span", "arrow");
        arrow.innerHTML = '<svg class="icon"><use href="#i-chev-right"/></svg>';
        li.appendChild(arrow);
        li.appendChild(el("span", "", r.toName));
        if (r.label) li.appendChild(el("span", "count", "  " + r.label));
        rl.appendChild(li);
      });
      root.appendChild(rl);
    }
  }

  function countFunctions(c) {
    var n = 0;
    c.files.forEach(function (f) {
      n += f.functions.length;
    });
    c.children.forEach(function (k) {
      n += countFunctions(k);
    });
    return n;
  }

  function componentNode(c, currentFile) {
    var li = el("li");
    var d = document.createElement("details");
    var s = document.createElement("summary");
    s.appendChild(el("span", "name", c.name));
    if (c.description) s.appendChild(el("span", "desc", c.description.length > 80 ? c.description.slice(0, 79) + "…" : c.description));
    s.appendChild(el("span", "count", countFunctions(c) + " 関数"));
    d.appendChild(s);
    var built = false;
    d.addEventListener("toggle", function () {
      if (!d.open || built) return;
      built = true; // 開いたときに初めて子を作る(大きな解析結果でも固まらない)
      var ul = el("ul");
      c.children.forEach(function (k) {
        ul.appendChild(componentNode(k, currentFile));
      });
      c.files.forEach(function (f) {
        ul.appendChild(fileNode(f, currentFile));
      });
      d.appendChild(ul);
    });
    li.appendChild(d);
    return li;
  }

  function fileNode(f, currentFile) {
    var li = el("li");
    var d = document.createElement("details");
    var s = document.createElement("summary");
    var isCurrent = currentFile && f.path.split("/").pop() === currentFile;
    var path = el("span", "path");
    if (isCurrent) {
      var mark = el("mark", "current", f.path);
      path.appendChild(mark);
    } else {
      path.textContent = f.path;
    }
    s.appendChild(path);
    if (f.missing) s.appendChild(el("span", "badge", "ファイルが見つかりません"));
    else if (f.unsupportedReason) s.appendChild(el("span", "badge", f.unsupportedReason));
    s.appendChild(el("span", "count", f.functions.length + " 関数"));
    d.appendChild(s);
    var built = false;
    var disabledReason = f.missing ? "ファイルが見つかりません" : f.unsupportedReason || "";
    d.addEventListener("toggle", function () {
      if (!d.open || built) return;
      built = true;
      var ul = el("ul");
      f.functions.forEach(function (fn) {
        var b = el("button", "fn");
        b.type = "button";
        b.disabled = !!disabledReason;
        if (disabledReason) b.title = disabledReason;
        b.appendChild(el("span", "fname", fn.name + "()"));
        b.appendChild(el("span", "lines", "L" + fn.startLine + "–L" + fn.endLine));
        b.addEventListener("click", function () {
          post({ type: "openFunction", path: f.path, line: fn.startLine });
        });
        var li2 = el("li");
        li2.appendChild(b);
        ul.appendChild(li2);
      });
      d.appendChild(ul);
    });
    if (isCurrent) d.open = true;
    li.appendChild(d);
    return li;
  }

  // ------------------------------------------------------------------ ホストからのメッセージ

  window.addEventListener("message", async function (event) {
    var d = event.data || {};
    switch (d.type) {
      case "render": {
        stopPlayback();
        state.ir = d.ir || null;
        state.rawText = d.ir ? null : d.mermaidText || null;
        state.meta = d.meta || {};
        if (d.view && Views.VIEWS[d.view]) state.view = d.view;
        if (!state.ir) state.view = "flow";
        hideBanner("host");
        if (state.meta.banner) showBanner(state.meta.banner, { kind: "info", mode: "host" });
        await renderDiagram({ fit: false, animate: true });
        break;
      }
      case "error":
        showBanner(String(d.message || "エラーが発生しました"), { retry: !!d.retry, mode: "host" });
        break;
      case "clearError":
        hideBanner("host");
        break;
      case "theme":
        applyThemeMessage(d);
        onThemeMaybeChanged();
        break;
      case "config":
        if (typeof d.followCursor === "boolean") state.config.followCursor = d.followCursor;
        updateEmptyText();
        break;
      case "architecture":
        state.architecture = d.model || null;
        renderBreadcrumb();
        if (state.architecture) {
          showOverview();
          if (state.architecture.warnings && state.architecture.warnings.length) {
            showBanner("解析結果の一部を読み飛ばしました(" + state.architecture.warnings.length + " 件)", {
              kind: "info",
              mode: "host",
            });
          }
        }
        break;
      case "getMermaid":
        // コマンドパレットの「Mermaidテキストをコピー」用: いま表示している図(行番号なし)を返す
        post({ type: "mermaidResult", text: state.cleanMermaid || null });
        break;
      case "exportSvg":
        post({ type: "exportSvgResult", svg: currentSvgString() });
        break;
      case "exportPng": {
        var dataUrl = null;
        try {
          dataUrl = await currentPngDataUrl();
        } catch (err) {
          dataUrl = null;
        }
        post({ type: "exportPngResult", dataUrl: dataUrl });
        break;
      }
      default:
        break;
    }
  });

  // テスト・診断用の読み取り専用ハンドル
  window.__flowchartDebug = function () {
    return {
      view: state.view,
      showing: state.showing,
      scale: viewport.state().scale,
      nodeCount: Object.keys(state.nodeInfo).length,
      palette: readPalette(),
      bannerMode: state.bannerMode,
    };
  };

  function init() {
    updateEmptyText();
    showPane("empty");
    state.lastPaletteSig = JSON.stringify(readPalette());
    // 準備ができたことをホストへ知らせる(ホストは設定などを送り直す)
    post({ type: "ready" });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
