// FlowchartIR からビュー(フロー / 呼び出し / 状態)と Mermaid テキストを作る純粋関数群。
//
// - DOM もホスト固有のグローバルも参照しない(ブラウザ・Node 双方で動く UMD)。
// - Webview では bridge.js が使い、VSCode ホスト(Node)は同じファイルを require して
//   PR 用の差分 Mermaid 出力に使う。ビュー変換の実装は常にこの1か所だけ(3ホストで二重実装しない)。
// - 図形の決めごとは core/render/mermaid-emitter.ts の SHAPE と同一の表(IMPROVEMENT_DESIGN_2026-10.md §3)。
//   同じ入力なら「フロー」ビュー(既定オプション)の出力が emitMermaid(ir) とバイト同一になることを
//   core/scripts/test-views.js が検証する。

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FlowchartViews = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** 図形の決めごと表。開始/終了=角丸、処理=長方形、分岐=ひし形、繰り返し=六角形。 */
  var SHAPES = {
    start: ["(", ")"],
    end: ["(", ")"],
    process: ["[", "]"],
    decision: ["{", "}"],
    loop: ["{{", "}}"],
    ioOperation: ["[/", "/]"],
  };

  var ALL_KINDS = ["start", "end", "process", "decision", "loop", "ioOperation"];

  /**
   * ビューの宣言。ビューごとに「どの kind を表示するか」を宣言的に切り替えるだけで、
   * 同じ IR から描くためデータの修正が全ビューに反映される。
   * processFilter は process ノードに対する追加条件(呼び出しビューのみ)。
   */
  var VIEWS = {
    flow: {
      id: "flow",
      label: "フロー",
      description: "制御フローの全体",
      kinds: ALL_KINDS.slice(),
    },
    calls: {
      id: "calls",
      label: "呼び出し",
      description: "関数呼び出しらしい文 name( … ) を実行順に並べた図",
      kinds: ["start", "end", "process", "ioOperation"],
      processFilter: /[A-Za-z_][\w.]*\s*\(/,
    },
    state: {
      id: "state",
      label: "状態",
      description: "分岐と繰り返しだけの骨格",
      kinds: ["start", "end", "decision", "loop"],
    },
  };

  var VIEW_ORDER = ["flow", "calls", "state"];

  function isVisible(node, view) {
    if (view.kinds.indexOf(node.kind) < 0) return false;
    if (node.kind === "process" && view.processFilter) {
      return view.processFilter.test(node.label || "");
    }
    return true;
  }

  /** 表示対象ノード数(整合チェック用)。 */
  function countVisible(ir, viewId) {
    var view = VIEWS[viewId];
    if (!view) throw new Error("unknown view: " + viewId);
    var n = 0;
    for (var i = 0; i < ir.nodes.length; i++) if (isVisible(ir.nodes[i], view)) n++;
    return n;
  }

  /**
   * ビューに表示するノードだけを残し、隠したノードを経由するエッジは「次に見えるノード」へ繋ぎ直す。
   * 繋ぎ直したエッジは、見えるノードから出る最初のエッジのラベル(true/false)を引き継ぐ
   * (分岐の意味が消えないようにするため)。自己ループは捨て、同一 from>to>label は1本にまとめる。
   */
  function projectView(ir, viewId) {
    var view = VIEWS[viewId];
    if (!view) throw new Error("unknown view: " + viewId);

    var visible = {};
    var nodes = [];
    for (var i = 0; i < ir.nodes.length; i++) {
      if (isVisible(ir.nodes[i], view)) {
        visible[ir.nodes[i].id] = true;
        nodes.push(ir.nodes[i]);
      }
    }
    if (nodes.length === ir.nodes.length) {
      return { nodes: ir.nodes.slice(), edges: ir.edges.slice() };
    }

    var out = {};
    for (var k = 0; k < ir.edges.length; k++) {
      var ed = ir.edges[k];
      (out[ed.from] = out[ed.from] || []).push(ed);
    }

    var edges = [];
    var seen = {};
    function push(from, to, label, source) {
      if (from === to) return;
      var key = from + ">" + to + ">" + (label || "");
      if (seen[key]) return;
      seen[key] = true;
      var e = { from: from, to: to };
      if (label) e.label = label;
      if (source && source.diff) e.diff = source.diff;
      edges.push(e);
    }

    for (var n = 0; n < nodes.length; n++) {
      var outs = out[nodes[n].id] || [];
      for (var j = 0; j < outs.length; j++) {
        var first = outs[j];
        if (visible[first.to]) {
          push(nodes[n].id, first.to, first.label, first);
          continue;
        }
        // 隠れたノードを幅優先でたどり、最初に見えるノードへ繋ぐ
        var queue = [first.to];
        var visited = {};
        visited[first.to] = true;
        while (queue.length) {
          var h = queue.shift();
          var hs = out[h] || [];
          for (var q = 0; q < hs.length; q++) {
            var t = hs[q].to;
            if (visible[t]) {
              push(nodes[n].id, t, first.label, first);
            } else if (!visited[t]) {
              visited[t] = true;
              queue.push(t);
            }
          }
        }
      }
    }
    return { nodes: nodes, edges: edges };
  }

  /** Mermaid のエンティティ記法(core/render/mermaid-emitter.ts の escapeLabel と同一)。 */
  function escapeLabel(label) {
    return String(label)
      .replace(/&/g, "#amp;")
      .replace(/"/g, "#quot;")
      .replace(/</g, "#lt;")
      .replace(/>/g, "#gt;")
      .replace(/\n/g, "<br/>");
  }

  function truncateLabel(label, max) {
    var one = String(label).replace(/\s+/g, " ").trim();
    if (!max || one.length <= max) return one;
    return one.slice(0, max - 1) + "…";
  }

  var DIFF_CLASS = {
    added: "diffAdded",
    removed: "diffRemoved",
    changed: "diffChanged",
  };

  var DEFAULT_DIFF_COLORS = { added: "#2ea043", removed: "#f85149", changed: "#d29922" };

  /**
   * IR(またはその射影)を Mermaid `flowchart TD` に直列化する。
   * opts:
   *   view        'flow' | 'calls' | 'state'(既定 flow)
   *   lineNumbers ノードに「L12」と行番号を併記する(Webview 表示用。コピー用の出力では false)
   *   maxLabel    ノード内の文字数上限(全文はホバーで見せる)。0 = 切らない
   *   diffColors  差分ノードの色 {added, removed, changed}
   * 差分(node.diff / edge.diff)がある場合のみ classDef / linkStyle を末尾に足す。
   */
  function emitMermaid(ir, opts) {
    var o = opts || {};
    var viewId = o.view || "flow";
    var p = projectView(ir, viewId);
    var lines = ["flowchart TD"];

    for (var i = 0; i < p.nodes.length; i++) {
      var n = p.nodes[i];
      var shape = SHAPES[n.kind] || SHAPES.process;
      var text = o.maxLabel ? truncateLabel(n.label, o.maxLabel) : n.label;
      var label = escapeLabel(text);
      if (o.lineNumbers && n.sourceRange && n.sourceRange.startLine > 0) {
        label += "<br/>L" + n.sourceRange.startLine;
      }
      lines.push("  " + n.id + shape[0] + '"' + label + '"' + shape[1]);
    }

    for (var k = 0; k < p.edges.length; k++) {
      var e = p.edges[k];
      var arrow = e.label ? "-->|" + e.label + "|" : "-->";
      lines.push("  " + e.from + " " + arrow + " " + e.to);
    }

    // ---- 差分の着色(X3)。色だけに頼らず、線の太さ・破線でも区別する ----
    var colors = Object.assign({}, DEFAULT_DIFF_COLORS, o.diffColors || {});
    var byClass = { diffAdded: [], diffRemoved: [], diffChanged: [] };
    for (var a = 0; a < p.nodes.length; a++) {
      var cls = DIFF_CLASS[p.nodes[a].diff];
      if (cls) byClass[cls].push(p.nodes[a].id);
    }
    var anyNodeDiff = byClass.diffAdded.length + byClass.diffRemoved.length + byClass.diffChanged.length > 0;
    if (anyNodeDiff) {
      lines.push("  classDef diffAdded stroke:" + colors.added + ",stroke-width:3px");
      lines.push("  classDef diffRemoved stroke:" + colors.removed + ",stroke-width:2px,stroke-dasharray:5 3");
      lines.push("  classDef diffChanged stroke:" + colors.changed + ",stroke-width:3px,stroke-dasharray:1 0");
      Object.keys(byClass).forEach(function (c) {
        if (byClass[c].length) lines.push("  class " + byClass[c].join(",") + " " + c);
      });
    }
    for (var b = 0; b < p.edges.length; b++) {
      var d = p.edges[b].diff;
      if (d === "added") lines.push("  linkStyle " + b + " stroke:" + colors.added + ",stroke-width:3px");
      else if (d === "removed")
        lines.push("  linkStyle " + b + " stroke:" + colors.removed + ",stroke-width:2px,stroke-dasharray:5 3");
    }

    return lines.join("\n");
  }

  /** 実行順の再生(X4)用: start から辿るエッジ列。戻りエッジ(閉路を作る辺)は含めない。 */
  function executionOrder(ir) {
    var start = null;
    for (var i = 0; i < ir.nodes.length; i++) {
      if (ir.nodes[i].kind === "start") {
        start = ir.nodes[i];
        break;
      }
    }
    if (!start) return [];
    var out = {};
    for (var k = 0; k < ir.edges.length; k++) {
      (out[ir.edges[k].from] = out[ir.edges[k].from] || []).push(ir.edges[k]);
    }
    var order = [];
    var state = {}; // 1 = 探索中, 2 = 完了
    function dfs(u) {
      state[u] = 1;
      var es = out[u] || [];
      for (var j = 0; j < es.length; j++) {
        var v = es[j].to;
        if (state[v] === 1) continue; // 戻りエッジ
        order.push(es[j]);
        if (!state[v]) dfs(v);
      }
      state[u] = 2;
    }
    dfs(start.id);
    return order;
  }

  return {
    SHAPES: SHAPES,
    VIEWS: VIEWS,
    VIEW_ORDER: VIEW_ORDER,
    isVisible: isVisible,
    countVisible: countVisible,
    projectView: projectView,
    emitMermaid: emitMermaid,
    escapeLabel: escapeLabel,
    truncateLabel: truncateLabel,
    executionOrder: executionOrder,
  };
});
