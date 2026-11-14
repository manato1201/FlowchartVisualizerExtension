# 第 7 回 テストと総合演習

> 所要時間の目安: 2.5 時間 / 前提: 第 0〜6 回

## この回のゴール

- この拡張の**テストの層**(単体・ブラウザ・IDE 本体・C#)と、**何を確かめていないか**を説明できる。
- 新しい構文に対する**テストの書き方**を説明できる。
- 総合演習を通して、**IR → 差分 → ビュー**の流れを、自分で動かせる。

## 1. テストの層

| 層 | どこで | 何を確かめるか | 実行 |
|---|---|---|---|
| IR・ビュー・差分・全体階層 | `core/scripts/test-*.js`(Node) | 図形の表・ビューの繋ぎ直し・LCS の差分・`analysis.json` の読み取り | `cd core && npm test` |
| 走査・ホストの論理 | `vscode-extension/scripts/`(Node) | 括弧の走査・関数の切り出し・構文木版と走査版が**同じ構造**を返す | `cd vscode-extension && npm test` |
| Webview(実ブラウザ) | `core/scripts/test-webview.js` | 実際の Chrome / Edge で、描画・テーマ・ズーム・**330 ノードでの操作の滑らかさ** | `npm run test:webview`(ブラウザが無ければスキップ) |
| IDE 本体 | `vscode-extension/test/` | 実際の VS Code(Extension Host)での結合 | `npm run test:integration`(VS Code が必要) |
| C#(Visual Studio 側) | `vs-extension/FlowchartExtractor.Tests/` | Roslyn の CFG の採用可否・IR の JSON | `dotnet test` |

**自動で確かめていないこと**: Visual Studio 本体での起動(コンパイル確認まで)・Rider のビルド(JDK / Gradle が無い環境)。**確かめていないことを、README の表に書く**。

## 2. テストの型

- **構造で比べる**: 「ノードの種別の並び」と「辺の数」を、**テキスト版と構文木版**で比べる。同じコードで、**同じ構造**が出ること(`test-scanner.js`)。
- **性質で守る**: 「行がずれただけなら変更なし」「入力の IR を壊さない」「空の IR 同士でも落ちない」(`test-diff.js`)。
- **速さを守る**: 「1,000 ノード級でも変換が 300 ms 未満」(`test-views.js`)。
- **実物で確かめる**: `analysis.json` は、**CodeBoarding の実物の抜粋**で確かめる(想像で作った形ではなく)。

## 3. 新しい構文を足したときの手順

1. **失敗するテストを先に**: その構文を含む小さなコードで、期待する**ノード列とエッジ**を書く(`vscode-extension/scripts/test-scanner.js`)。
2. 読み取り(走査と構文木の**両方**)を直す。意味づけは **`FlowBuilder` で**(2 か所に分けない)。
3. **両方の実装が同じ構造を返す**ことを確かめる。
4. 到達不能・空の本体・**閉じていない括弧**でも、**必ず終わる**ことを確かめる。

## 4. 総合演習

次を、自分で動かしてください(答えは、各回の実行例に近い形です)。

```javascript
// 実行できる
const { irFromFunctionText } = require("./dist/vscode-extension/src/functionSlicer");
const { diffIR } = require("../core/dist/diff/ir-diff");
const { emitMermaid } = require("../core/dist/render/mermaid-emitter");
const Views = require("../core/webview-bundle/views.js");

const before = irFromFunctionText("void Tick()\n{\n  Read();\n  if (ready) { Send(); }\n}", 0, "Tick()", "t.cs");
const after = irFromFunctionText("void Tick()\n{\n  Read();\n  if (ready) { Send(); }\n  while (busy) { Wait(); }\n}", 0, "Tick()", "t.cs");

const result = diffIR(before, after);
console.log("追加:", result.summary.nodesAdded, "削除:", result.summary.nodesRemoved, "変更:", result.summary.nodesChanged);
console.log("状態ビューのノード数:", Views.projectView(result.ir, "state").nodes.length);
console.log("元の関数の Mermaid の行数:", emitMermaid(before).split("\n").length);
```

```text
# 出力
追加: 2 削除: 0 変更: 0
状態ビューのノード数: 4
元の関数の Mermaid の行数: 11
```

**演習**:

1. 上の `after` に、`return;` の**後ろ**へ `Dead();` を足すと、ノードは増えますか。理由も答えてください。
2. `while (busy)` を `for (;;)` に変えると、差分は「変更」と「追加」のどちらですか。
3. 呼び出しビュー(`calls`)のノード数を、状態ビューと比べてください。差の理由を説明してください。
4. (発展)switch の `case` の値を、線のラベルに出したくなりました。スキーマと、3 ホストのどこを直す必要がありますか。

**解答の方針**:

1. 増えない。`return;` の後ろは到達できないので、`FlowBuilder.rollback` が取り消す。
2. 種別が同じ(どちらも繰り返し)なので「変更」(`previousLabel` に元のラベル)。
3. 呼び出しビューは、`name(` の形の処理ノードを残す。状態ビューは分岐と繰り返しだけ。
4. `EdgeLabel`(`core/flowchart-ir/schema.ts`)・3 ホストのエミッター(TypeScript・C#・Kotlin)・`views.js`・差分のエッジのキー。**スキーマは 3 ホストで共有**なので、1 か所だけ直すと食い違う。

## 確認問題

1. 「テキスト版と構文木版が同じ構造を返す」ことを、テストで確かめるのは、なぜですか。
2. 実ブラウザのテストが、ブラウザが無いとスキップされるのは、なぜ許されますか。
3. この拡張で、自動では確かめていないことを 2 つ挙げてください。

## 解答

1. 2 つの読み取りが**別々に実装**されているので、片方だけ直したときの食い違いを、すぐ見つけるため。
2. ブラウザが無い環境でも、他のテスト(Node)を回せるように。ただし**スキップされた事実は、結果に出る**。
3. Visual Studio 本体での起動・Rider のビルド。(VS Code の結合テストも、VS Code 本体が要るので、文書の検査では回していない。)

## まとめ

- テストは**層**に分けてある。Node の単体・実ブラウザ・IDE 本体・C#。
- **確かめていないこと**を、README の表に正直に書く。
- 新しい構文は、**失敗するテストを先に**。意味づけは `FlowBuilder` の 1 か所。これで講義は終わり。続きは [学習資料](../learn/index.md)。
