# 第 5 回 ビューと Webview

> 所要時間の目安: 2.5 時間 / 前提: 第 4 回

## この回のゴール

- **同じ IR から 3 つのビュー**(フロー・呼び出し・状態)を作る仕組みを説明できる。
- 隠したノードを**飛び越えて、線を繋ぎ直す**規則を説明できる。
- ホストと Webview の**メッセージのやりとり**と、ホストごとの差し替え点を説明できる。

## 1. 3 つのビュー

| ビュー | 見せるもの |
|---|---|
| **フロー** | 制御フローの全体 |
| **呼び出し** | 関数呼び出しらしい文(`name(…)`)を、実行順に |
| **状態** | **分岐と繰り返しだけ**の骨格 |

ビューは、**「どの種別を見せるか」の宣言**だけ。**同じ IR を描き直す**ので、データを直せば、**3 つのビューに同時に反映**される。呼び出しビューだけ、処理ノードに**追加の条件**(`name(` の形)がある。

`views.js` は、**DOM にもホスト固有のものにも依存しない純粋関数**の集まり(UMD。ブラウザでも Node でも動く)。Webview の `bridge.js` が使い、VS Code のホスト(Node)も、**同じファイルを `require`** して差分の Mermaid を作る。**ビューの変換の実装は、常にこの 1 か所**。

## 2. 隠したノードを飛び越える

```javascript
// 抜粋ファイル: core/webview-bundle/views.js
function projectView(ir, viewId) {
var view = VIEWS[viewId];
if (!view) throw new Error("unknown view: " + viewId);
```

見えるノードだけを残し、**隠したノードを経由する線は、「次に見えるノード」へ繋ぎ直す**。繋ぎ直した線は、見えるノードから出る**最初の線のラベル**(true / false)を引き継ぐ(**分岐の意味が消えない**ため)。自己ループは捨て、同じ `from>to>label` は 1 本にまとめる。

```javascript
// 実行できる
const { irFromFunctionText } = require("./dist/vscode-extension/src/functionSlicer");
const { emitMermaid } = require("../core/dist/render/mermaid-emitter");
const Views = require("../core/webview-bundle/views.js");

const ir = irFromFunctionText("void H()\n{\n  Setup();\n  if (ok) { Run(); }\n  for (var i = 0; i < n; i++) { Step(i); }\n}", 0, "H()", "a.cs");

for (const id of Views.VIEW_ORDER) {
  const p = Views.projectView(ir, id);
  console.log(id, "ノード", p.nodes.length, "エッジ", p.edges.length);
}
console.log("状態ビューのノード:", Views.projectView(ir, "state").nodes.map((n) => n.label).join(" , "));
console.log("フローの Mermaid が、core の emitMermaid と同一:", Views.emitMermaid(ir) === emitMermaid(ir));
try {
  Views.projectView(ir, "zzz");
} catch (e) {
  console.log("未知のビュー:", e.message);
}
```

```text
# 出力
flow ノード 7 エッジ 8
calls ノード 5 エッジ 7
state ノード 4 エッジ 4
状態ビューのノード: H() , if (ok) , for (var i = 0; i < n; i++) , End
フローの Mermaid が、core の emitMermaid と同一: true
未知のビュー: unknown view: zzz
```

- **「フロー」ビューの Mermaid は、`core/render/mermaid-emitter.ts` の出力と、バイトまで同一**(`core/scripts/test-views.js` が検証)。TypeScript 版と JavaScript 版の**2 つの実装が、ずれない**ようにする。
- 未知のビュー ID は**例外**(黙って別のビューを出さない)。

## 3. ホストと Webview のやりとり

Webview は、ホストの API(`vscode`・WebView2・JCEF)を**直接は触らない**。送る口は `window.flowchartHostPost(message)` **だけ**で、その定義を**ホストが差し込む**(`host-shim.js`)。

| 向き | 主なメッセージ |
|---|---|
| ホスト → Webview | `render`(IR と、必要なら表示するビュー)・`error`(図の上の帯)・`clearError`・`theme`・`config`・`architecture`・`exportSvg` / `exportPng` |
| Webview → ホスト | `jump`(行へ飛ぶ)・`copyText`・`saveImage`・`requestAction`・`openFunction`・`ready`・`rendered` |

**ホストごとの差し替え点は、3 つだけ**:

1. **送信口**: VS Code は `acquireVsCodeApi().postMessage`・Visual Studio は WebView2 の `chrome.webview.postMessage`・Rider は JCEF の JS クエリ。
2. **IR の渡し方**: Mermaid のテキストではなく、**FlowchartIR の JSON**を渡す(ビュー切替・ジャンプはバンドルが行う)。
3. **テーマ**: VS Code は `--vscode-*` の CSS 変数がある。ない 2 つのホストは、**同じ名前の値を `theme` メッセージで送る**。

> エラーは**図を消さず、図の上の帯**に出す。入力中の構文エラーで、図が消えて見失わないように。

## 4. 大きな図でも固まらない

- 動かすのは `#stage` の **CSS transform** だけ(SVG の再レイアウトをしない)。
- 入力は `requestAnimationFrame` で**1 フレームに 1 回**にまとめる。
- ミニマップは、描画の終わりに**1 回だけ**画像にして、操作中は枠の位置を動かすだけ。
- **80 ノードを超える図**では、出現の動き(スタッガー)を付けない。`prefers-reduced-motion` では、動きを止める。

## 確認問題

1. 3 つのビューは、**同じデータ**から作られます。その利点は何ですか。
2. 隠したノードを飛び越えた線が、`true` / `false` のラベルを引き継ぐのは、なぜですか。
3. Webview がホストの API を直接参照しないのは、なぜですか。
4. ホストごとに差し替えるのは、何ですか(3 つ)。

## 解答

1. データを直すだけで、全ビューに反映される(ビューごとに、データを持たない)。
2. 分岐の意味(どちらの道か)が、繋ぎ直しで消えないようにするため。
3. 3 つのホストで**同じバンドル**を使うため(ホスト固有のものを参照すると、1 つのホストでしか動かない)。
4. メッセージの送信口・IR の渡し方(IR の JSON)・テーマの色の渡し方。

## まとめ

- ビューは、**種別の宣言 + 繋ぎ直し**。実装は `views.js` の 1 か所で、フローは core の出力と同一。
- Webview ↔ ホストは、**メッセージだけ**。差し替えるのは、送信口・IR の渡し方・テーマ。
- 次の回は、**関数の外**(全体の階層)。
