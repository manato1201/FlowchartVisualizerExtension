// 動き(X4)。使う動きは次の2種類だけ(IMPROVEMENT_DESIGN_2026-10.md の守ること①):
//   1. スタッガー: 図が出たとき、ノードを順に現す(CSS アニメーション)。
//   2. ライン描画: 「再生」で実行順に線が引かれていく(stroke-dashoffset)。
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

  /**
   * 実行順の再生。
   * steps: [{ edgeEl, fromEl, toEl, edgeLabelEl }] を実行順に並べたもの。
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

      function reveal(s, withDraw) {
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
          }
          s.edgeEl.classList.add("lit");
        }
        if (s.edgeLabelEl) s.edgeLabelEl.classList.add("lit");
        if (s.toEl) s.toEl.classList.add("lit");
      }

      if (reduced) {
        // 動きなし: 到達する全体を一度に強調表示して、少し見せてから戻す
        steps.forEach(function (s) {
          reveal(s, false);
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
            if (!cancelled) reveal(s, true);
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
    playSteps: playSteps,
    reducedMotion: reducedMotion,
  };
})(typeof self !== "undefined" ? self : this);
