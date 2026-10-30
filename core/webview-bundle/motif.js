// ASCII モチーフ(地形: 川・分岐・三角州)。出す場所は Webview の空状態だけ(原則P8)。
//   - 系統 C. Drift: 水面の文字がゆっくり入れ替わるだけ。形は変えない。
//   - 色は親(#empty)の文字色をそのまま使う(新しい色は足さない)。
//   - prefers-reduced-motion では静止画1枚。空状態でなくなったら止める。
//   - 本文・操作部品には出さない。スクリーンリーダーには読ませない(aria-hidden)。
(function (root) {
  "use strict";

  // '~' が水面。それ以外の文字は動かない。
  var ART = [
    "            ~ ~ ~ ~            ",
    "             ~ ~ ~             ",
    "              ~ ~              ",
    "               ~               ",
    "              ~~~              ",
    "             ~~ ~~             ",
    "            ~~   ~~            ",
    "           ~~ ~~~ ~~           ",
    "          ~~ ~~ ~~ ~~          ",
    "         ~~ ~~     ~~ ~~       ",
    "        ~~ ~~       ~~ ~~      ",
    "       ~~ ~~           ~~ ~~   ",
  ];
  var GLYPHS = ["~", "~", "-"];
  var FRAME_MS = 800;

  /** k コマ目の絵。k=0 が静止画。 */
  function frame(k) {
    return ART.map(function (row, r) {
      var out = "";
      for (var i = 0; i < row.length; i++) {
        out +=
          row.charAt(i) === "~"
            ? GLYPHS[(i + r + k) % GLYPHS.length]
            : row.charAt(i);
      }
      return out;
    }).join("\n");
  }

  var timer = 0;
  var target = null;

  function reduced() {
    return (
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = 0;
  }

  /** el に絵を出す。動きを減らす設定なら静止画のまま。 */
  function start(el) {
    stop();
    target = el;
    if (!el) return;
    el.textContent = frame(0);
    if (reduced()) return;
    var k = 0;
    timer = setInterval(function () {
      k++;
      target.textContent = frame(k);
    }, FRAME_MS);
  }

  root.FlowchartMotif = { start: start, stop: stop, frame: frame, ART: ART };
})(typeof self !== "undefined" ? self : this);
