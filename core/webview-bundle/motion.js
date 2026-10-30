// 動き(X4)。使う動きは次の2種類だけ(IMPROVEMENT_DESIGN_2026-10.md の守ること①):
//   1. スタッガー: 図が出たとき、ノードを順に現す(CSS アニメーション)。
//   2. ライン描画: 「再生」で実行順に線が引かれていく(stroke-dashoffset)。
//      光点(Y2)は、この線が引かれるのに合わせて線に沿って進むもので、同じ動きの一部(動きの種類は増やさない)。
// 再生中は、通った順に番号つきの丸(X16: 1〜n)を線の上に置く。線の種別は色ではなく形で分ける:
//   true=円 / false=四角 / 通常=ひし形(色だけに頼らない・P1)。番号は動きの設定に関係なく出る。
// すべて prefers-reduced-motion で止める。止めた場合も「再生」は結果だけを見せる(動きなしの強調表示)。
(function (root) {
  "use strict";

  var STAGGER_MAX_NODES = 80; // これを超える大きな図では出現の動きを付けない(把握しやすさ・負荷のため)
  var STAGGER_MAX_TOTAL_MS = 420;

  function reducedMotion() {
    return (
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  /** ノードを順に現す。CSS 側 (#stage.stagger .node) が animation-delay を --fv-delay から読む。 */
  function staggerIn(stage) {
    stage.classList.remove("stagger");
    if (reducedMotion()) return false;
    var nodes = stage.querySelectorAll(".node");
    if (!nodes.length || nodes.length > STAGGER_MAX_NODES) return false;
    var step = Math.min(30, STAGGER_MAX_TOTAL_MS / nodes.length);
    for (var i = 0; i < nodes.length; i++)
      nodes[i].style.setProperty("--fv-delay", Math.round(i * step) + "ms");
    // 再描画を挟んでクラスを付け直し、アニメーションを確実に最初から走らせる
    void stage.getBoundingClientRect();
    stage.classList.add("stagger");
    var total = nodes.length * step + 260;
    setTimeout(function () {
      stage.classList.remove("stagger");
    }, total);
    return true;
  }

  var SVG_NS = "http://www.w3.org/2000/svg";
  var BADGE_R = 9;

  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) e.setAttribute(k, String(attrs[k]));
    return e;
  }

  /** 種別ごとの形(凡例と同じ形)。中心 (0,0)、半径 r。 */
  function badgeShape(kind, r) {
    if (kind === "true") return svgEl("circle", { r: r });
    if (kind === "false")
      return svgEl("rect", {
        x: -r,
        y: -r,
        width: 2 * r,
        height: 2 * r,
        rx: 2,
      });
    var d = r * 1.25;
    return svgEl("polygon", {
      points: "0," + -d + " " + d + ",0 0," + d + " " + -d + ",0",
    });
  }

  /** 線の中ほどに、番号つきの丸を置く。 */
  function addBadge(edgeEl, n, kind) {
    if (!edgeEl || !edgeEl.getTotalLength || !edgeEl.parentNode) return null;
    var pt = edgeEl.getPointAtLength(edgeEl.getTotalLength() / 2);
    var g = svgEl("g", {
      class: "fv-badge",
      "data-kind": kind || "plain",
      transform: "translate(" + pt.x + " " + pt.y + ")",
    });
    g.appendChild(badgeShape(kind, BADGE_R));
    var t = svgEl("text", {
      "text-anchor": "middle",
      "dominant-baseline": "central",
    });
    t.textContent = String(n);
    g.appendChild(t);
    edgeEl.parentNode.appendChild(g);
    return g;
  }

  /** 光点(Y2): 線に沿って端から端まで進み、終わったら消える。 */
  function runDot(edgeEl, ms, isCancelled) {
    if (
      !edgeEl ||
      !edgeEl.getTotalLength ||
      !edgeEl.parentNode ||
      typeof requestAnimationFrame !== "function"
    )
      return;
    var len = edgeEl.getTotalLength();
    var dot = svgEl("circle", { class: "fv-dot", r: 5 });
    edgeEl.parentNode.appendChild(dot);
    var t0 = null;
    function frame(ts) {
      if (t0 === null) t0 = ts;
      var f = Math.min(1, (ts - t0) / Math.max(1, ms));
      var p = edgeEl.getPointAtLength(len * f);
      dot.setAttribute("cx", String(p.x));
      dot.setAttribute("cy", String(p.y));
      if (f < 1 && !isCancelled() && dot.parentNode)
        requestAnimationFrame(frame);
      else if (dot.parentNode) dot.parentNode.removeChild(dot);
    }
    requestAnimationFrame(frame);
  }

  /**
   * 実行順の再生。
   * steps: [{ edgeEl, toEl, edgeLabelEl, kind }] を実行順に並べたもの(kind は "true" / "false" / "")。
   * 戻り値: { promise, cancel }。cancel() で即座に元の表示へ戻す。
   */
  function playSteps(stage, steps, startEl) {
    var cancelled = false;
    var timers = [];
    var reduced = reducedMotion();

    stage.classList.add("playing");
    if (startEl) startEl.classList.add("lit");

    function cleanup() {
      stage.classList.remove("playing");
      var lit = stage.querySelectorAll(".lit");
      for (var i = 0; i < lit.length; i++) lit[i].classList.remove("lit");
      var extra = stage.querySelectorAll(".fv-badge, .fv-dot");
      for (var x = 0; x < extra.length; x++)
        extra[x].parentNode.removeChild(extra[x]);
      var paths = stage.querySelectorAll(".edgePaths path");
      for (var j = 0; j < paths.length; j++) {
        paths[j].style.strokeDasharray = "";
        paths[j].style.strokeDashoffset = "";
        paths[j].style.transition = "";
      }
    }

    var promise = new Promise(function (resolve) {
      if (!steps.length) {
        setTimeout(function () {
          cleanup();
          resolve();
        }, 0);
        return;
      }
      // 全体で最大 ~6 秒、1本あたり 40〜220ms
      var step = Math.max(40, Math.min(220, 6000 / steps.length));

      function reveal(s, withDraw, n) {
        if (s.edgeEl) {
          if (withDraw && !reduced && s.edgeEl.getTotalLength) {
            var len = s.edgeEl.getTotalLength();
            s.edgeEl.style.transition = "none";
            s.edgeEl.style.strokeDasharray = len + " " + len;
            s.edgeEl.style.strokeDashoffset = String(len);
            void s.edgeEl.getBoundingClientRect();
            s.edgeEl.style.transition =
              "stroke-dashoffset " + Math.round(step * 0.8) + "ms linear";
            s.edgeEl.style.strokeDashoffset = "0";
            runDot(s.edgeEl, Math.round(step * 0.8), function () {
              return cancelled;
            });
          }
          s.edgeEl.classList.add("lit");
          addBadge(s.edgeEl, n, s.kind);
        }
        if (s.edgeLabelEl) s.edgeLabelEl.classList.add("lit");
        if (s.toEl) s.toEl.classList.add("lit");
      }

      if (reduced) {
        // 動きなし: 到達する全体を一度に強調表示して、少し見せてから戻す
        steps.forEach(function (s, i) {
          reveal(s, false, i + 1);
        });
        timers.push(
          setTimeout(function () {
            cleanup();
            resolve();
          }, 1800),
        );
        return;
      }

      steps.forEach(function (s, i) {
        timers.push(
          setTimeout(function () {
            if (!cancelled) reveal(s, true, i + 1);
          }, i * step),
        );
      });
      timers.push(
        setTimeout(
          function () {
            cleanup();
            resolve();
          },
          steps.length * step + 700,
        ),
      );
    });

    return {
      promise: promise,
      cancel: function () {
        cancelled = true;
        timers.forEach(clearTimeout);
        cleanup();
      },
    };
  }

  root.FlowchartMotion = {
    staggerIn: staggerIn,
    badgeShape: badgeShape,
    playSteps: playSteps,
    reducedMotion: reducedMotion,
  };
})(typeof self !== "undefined" ? self : this);
