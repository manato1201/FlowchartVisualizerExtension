// パン・ズーム・ミニマップ。DOM だけに依存し、ホスト固有のグローバルは参照しない。
//
// 大きな図(300ノード超)でも固まらないための方針:
//   - 動かすのは #stage の CSS transform だけ(SVG の再レイアウトをしない)。
//   - 入力は requestAnimationFrame で1フレームに1回へまとめる。
//   - ミニマップは図を描画し終えた時に1回だけ画像化し、操作中は枠(div)の位置を動かすだけ。
(function (root) {
  "use strict";

  var MIN_SCALE = 0.02;
  var MAX_SCALE = 4;
  var FIT_PADDING = 24;
  var READABLE_MIN = 0.3; // これ未満に縮む図は、初回だけ読める倍率で先頭を見せる
  var READABLE_INITIAL = 0.75;

  function createViewport(opts) {
    var viewport = opts.viewport;
    var stage = opts.stage;
    var minimap = opts.minimap; // { root, img, view }
    var onChange = opts.onChange || function () {};

    var scale = 1;
    var tx = 0;
    var ty = 0;
    var content = { w: 0, h: 0 };
    var raf = 0;
    var hasMinimapImage = false;
    var suppressClick = false;
    // 全体表示のままか。手動でズーム・パンするまでは、リサイズ(帯の出入り・パネル幅の変更)に追従して収め直す
    var autoFit = false;

    function viewSize() {
      return { w: viewport.clientWidth, h: viewport.clientHeight };
    }

    function clampScale(s) {
      return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
    }

    /** 画面上で見えている範囲を、図の座標系(px)で返す。 */
    function visibleRect() {
      var v = viewSize();
      return { x: -tx / scale, y: -ty / scale, w: v.w / scale, h: v.h / scale };
    }

    function updateMinimap() {
      if (!minimap) return;
      var vis = visibleRect();
      var eps = 2;
      var fully =
        vis.x <= eps &&
        vis.y <= eps &&
        vis.x + vis.w >= content.w - eps &&
        vis.y + vis.h >= content.h - eps;
      var show = hasMinimapImage && !fully && content.w > 0;
      minimap.root.hidden = !show;
      if (!show) return;

      var mw = minimap.root.clientWidth;
      var mh = minimap.root.clientHeight;
      var k = Math.min(mw / content.w, mh / content.h);
      var ox = (mw - content.w * k) / 2;
      var oy = (mh - content.h * k) / 2;
      // 枠は図の範囲内にクリップして描く
      var x0 = Math.max(0, vis.x);
      var y0 = Math.max(0, vis.y);
      var x1 = Math.min(content.w, vis.x + vis.w);
      var y1 = Math.min(content.h, vis.y + vis.h);
      var s = minimap.view.style;
      s.left = ox + x0 * k + "px";
      s.top = oy + y0 * k + "px";
      s.width = Math.max(2, (x1 - x0) * k) + "px";
      s.height = Math.max(2, (y1 - y0) * k) + "px";
    }

    function apply() {
      raf = 0;
      stage.style.transform =
        "translate(" + tx + "px, " + ty + "px) scale(" + scale + ")";
      updateMinimap();
      onChange({ scale: scale, tx: tx, ty: ty });
    }

    function schedule() {
      if (!raf) raf = requestAnimationFrame(apply);
    }

    function setContent(w, h) {
      content = { w: w, h: h };
    }

    /**
     * 全体が収まる倍率にして中央へ。小さい図は 100% を超えて拡大しない。
     * opts.initial: 図を最初に出すときだけ true。全体表示だと読めないほど縮む大きな図(< 30%)は、
     * 先頭から読める倍率(最大 75%)にして上端へ寄せる(続きはミニマップ・パンで)。
     */
    function fit(opts) {
      var v = viewSize();
      if (!content.w || !content.h || !v.w || !v.h) return;
      var whole = Math.min((v.w - FIT_PADDING * 2) / content.w, (v.h - FIT_PADDING * 2) / content.h, 1);
      if (opts && opts.initial && whole < READABLE_MIN) {
        var byWidth = (v.w - FIT_PADDING * 2) / content.w;
        scale = clampScale(Math.min(READABLE_INITIAL, Math.max(whole, byWidth)));
        tx = (v.w - content.w * scale) / 2;
        ty = FIT_PADDING;
        autoFit = false; // 全体表示ではないので、リサイズで勝手に収め直さない
        schedule();
        return;
      }
      scale = clampScale(whole);
      tx = (v.w - content.w * scale) / 2;
      ty = (v.h - content.h * scale) / 2;
      autoFit = true;
      schedule();
    }

    /** (cx, cy) = ビューポート内の座標。省略時は中央。点を動かさずに倍率を変える。 */
    function zoomTo(next, cx, cy) {
      var v = viewSize();
      if (cx === undefined) cx = v.w / 2;
      if (cy === undefined) cy = v.h / 2;
      autoFit = false;
      var s = clampScale(next);
      var k = s / scale;
      tx = cx - (cx - tx) * k;
      ty = cy - (cy - ty) * k;
      scale = s;
      schedule();
    }

    function zoomBy(factor, cx, cy) {
      zoomTo(scale * factor, cx, cy);
    }

    function panBy(dx, dy) {
      autoFit = false;
      tx += dx;
      ty += dy;
      schedule();
    }

    /** 図の座標 (x, y) が画面中央に来るようにする。 */
    function centerOn(x, y) {
      autoFit = false;
      var v = viewSize();
      tx = v.w / 2 - x * scale;
      ty = v.h / 2 - y * scale;
      schedule();
    }

    // ---- ドラッグでパン ----
    var drag = null;
    viewport.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest("[data-no-pan]")) return;
      drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        moved: 0,
        captured: false,
      };
    });
    viewport.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.x;
      var dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved > 4) autoFit = false;
      if (drag.moved > 4) {
        viewport.classList.add("dragging");
        if (!drag.captured) {
          // ドラッグと分かってから捕まえる(押した直後に捕まえると click の対象が変わってしまう)
          drag.captured = true;
          try {
            viewport.setPointerCapture(e.pointerId);
          } catch (err) {
            /* 既に離されている場合など */
          }
        }
      }
      tx += dx;
      ty += dy;
      schedule();
    });
    function endDrag(e) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      suppressClick = drag.moved > 4;
      drag = null;
      viewport.classList.remove("dragging");
    }
    viewport.addEventListener("pointerup", endDrag);
    viewport.addEventListener("pointercancel", endDrag);
    // ドラッグ直後の click は「ノードを押した」ことにしない(ジャンプの誤爆防止)
    viewport.addEventListener(
      "click",
      function (e) {
        if (suppressClick) {
          suppressClick = false;
          e.stopPropagation();
        }
      },
      true,
    );

    // ---- ホイール: Ctrl/⌘ + ホイール(トラックパッドのピンチ含む)でズーム、それ以外はパン ----
    viewport.addEventListener(
      "wheel",
      function (e) {
        if (e.target.closest && e.target.closest("[data-no-pan]")) return;
        e.preventDefault();
        var unit = e.deltaMode === 1 ? 16 : 1;
        var dx = e.deltaX * unit;
        var dy = e.deltaY * unit;
        if (e.ctrlKey || e.metaKey) {
          var rect = viewport.getBoundingClientRect();
          zoomBy(
            Math.exp(-dy * 0.0025),
            e.clientX - rect.left,
            e.clientY - rect.top,
          );
        } else if (e.shiftKey && dx === 0) {
          panBy(-dy, 0);
        } else {
          panBy(-dx, -dy);
        }
      },
      { passive: false },
    );

    viewport.addEventListener("dblclick", function (e) {
      if (e.target.closest && e.target.closest(".node, [data-no-pan]")) return;
      fit();
    });

    // ---- ミニマップ: 押す/ドラッグで、その位置へ移動 ----
    if (minimap) {
      var mmDrag = false;
      var moveTo = function (e) {
        var r = minimap.root.getBoundingClientRect();
        var k = Math.min(r.width / content.w, r.height / content.h);
        var ox = (r.width - content.w * k) / 2;
        var oy = (r.height - content.h * k) / 2;
        centerOn((e.clientX - r.left - ox) / k, (e.clientY - r.top - oy) / k);
      };
      minimap.root.addEventListener("pointerdown", function (e) {
        mmDrag = true;
        minimap.root.setPointerCapture(e.pointerId);
        moveTo(e);
        e.stopPropagation();
      });
      minimap.root.addEventListener("pointermove", function (e) {
        if (mmDrag) moveTo(e);
      });
      var mmEnd = function () {
        mmDrag = false;
      };
      minimap.root.addEventListener("pointerup", mmEnd);
      minimap.root.addEventListener("pointercancel", mmEnd);
    }

    var ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(function () {
            if (autoFit) fit();
            else schedule();
          })
        : null;
    if (ro) ro.observe(viewport);

    return {
      setContent: setContent,
      fit: fit,
      zoomBy: zoomBy,
      zoomTo: zoomTo,
      panBy: panBy,
      centerOn: centerOn,
      state: function () {
        return {
          scale: scale,
          tx: tx,
          ty: ty,
          content: content,
          view: viewSize(),
        };
      },
      visibleRect: visibleRect,
      /** ミニマップに使う画像(Blob URL)を差し替える。null で消す。 */
      setMinimapImage: function (url) {
        if (!minimap) return;
        var old = minimap.img.getAttribute("src");
        if (old && old.indexOf("blob:") === 0) URL.revokeObjectURL(old);
        if (url) minimap.img.setAttribute("src", url);
        else minimap.img.removeAttribute("src");
        hasMinimapImage = !!url;
        schedule();
      },
      refresh: schedule,
    };
  }

  root.FlowchartViewport = {
    createViewport: createViewport,
    MIN_SCALE: MIN_SCALE,
    MAX_SCALE: MAX_SCALE,
  };
})(typeof self !== "undefined" ? self : this);
