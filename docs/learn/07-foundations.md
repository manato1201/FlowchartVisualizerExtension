# 7. 基礎の補強(言語・設計思想・アルゴリズム・用語)

講義と学習資料の**前提になっている知識**を、ここで補います。この拡張は **TypeScript・C#・Kotlin の 3 言語**で書かれています。**同じ概念が、3 言語でどう書き分けられるか**と、コードを読むための基礎を、動かして確かめます。

## 1. 言語の基礎

### 1.1 同じ「データの入れ物」を、3 言語で書く

FlowchartIR の「ノード」を、3 言語で見比べます。**考え方は同じ**(名前つきの項目を持つ、**値の入れ物**)で、書き方が違うだけです。

```typescript
// 抜粋ファイル: core/flowchart-ir/schema.ts
export type NodeKind =
export interface FlowchartNode {
id: string;
kind: NodeKind;
label: string;
```

```csharp
// 抜粋ファイル: vs-extension/FlowchartExtractor/FlowchartIR.cs
public enum NodeKind
public sealed record SourceRange(int StartLine, int EndLine);
public sealed record FlowchartNode(string Id, NodeKind Kind, string Label, SourceRange SourceRange);
public sealed record FlowchartEdge(string From, string To, string? Label = null);
```

```kotlin
// 抜粋ファイル: rider-plugin/src/main/kotlin/com/flowchartvisualizer/rider/FlowchartIr.kt
enum class NodeKind {
data class SourceRange(val startLine: Int, val endLine: Int)
data class FlowchartNode(
val id: String,
val kind: NodeKind,
val label: String,
```

| 概念 | TypeScript | C# | Kotlin |
|---|---|---|---|
| 値の入れ物 | `interface`(形の約束。実行時には消える) | `record`(不変・値で比べる) | `data class`(不変にもできる・値で比べる) |
| 決まった値の集まり | 文字列の**ユニオン型** `"start" \| "end" …` | `enum` | `enum class` |
| 「無いかもしれない」 | `label?: string` | `string?`(`null` 許容) | `String?` |
| 既定値 | 呼ぶ側で | `Label = null` | `val label: String? = null` |
| 命名 | `camelCase` | `PascalCase` | `camelCase` |

**3 つに写してある**ので、1 つを変えたら、他も変える(学習資料 4)。

### 1.2 ユニオン型と「あり得ない値を作らせない」

`NodeKind` のように、**取りうる値を列挙した型**は、**書き間違いを、実行前に見つける**。`switch` で全部の値を書けば、**足し忘れも**見つけられる。

```javascript
// 実行できる
const { emitMermaid } = require("../core/dist/render/mermaid-emitter");

const range = { startLine: 1, endLine: 1 };
const kinds = ["start", "process", "decision", "loop", "ioOperation", "end"];
const nodes = kinds.map((kind, i) => ({ id: `n${i + 1}`, kind, label: kind, sourceRange: range }));
const text = emitMermaid({ nodes, edges: [], sourceFile: "x", generatedAt: "t" });
console.log(text);
// TypeScript なら、"circle" のような未知の種類は、コンパイルの時点で弾かれる(JavaScript の実行では弾かれない)
```

```text
# 出力
flowchart TD
  n1("start")
  n2["process"]
  n3{"decision"}
  n4{{"loop"}}
  n5[/"ioOperation"/]
  n6("end")
```

### 1.3 クラスと状態: `FlowBuilder` の読み方

`class FlowBuilder` は、**状態(`nodes`・`edges`・`counter`)を持ち、メソッドで更新**する。`private` は**外から触れない**。**採番(`n1`・`n2` …)**が、呼ばれた順に決まる。

```javascript
// 実行できる
class IdAllocator {
  #counter = 0;                    // # は、外から触れない(TypeScript の private に当たる)
  next() {
    this.#counter += 1;
    return `n${this.#counter}`;
  }
}

const ids = new IdAllocator();
console.log(ids.next(), ids.next(), ids.next());
console.log("外からは見えない:", ids.counter, "(undefined)");
```

```text
# 出力
n1 n2 n3
外からは見えない: undefined (undefined)
```

### 1.4 再帰: 入れ子を読む

`if` の中に `for`、その中にまた `if` …。**入れ子の深さが決まっていない**構造は、**自分自身を呼ぶ関数(再帰)**で読む。「**終わる条件**」(もう入れ子が無い)が必須。

```javascript
// 実行できる
// 波括弧の入れ子の深さを、再帰で数える(文字列・コメントは考えない、最小の例)
function maxDepth(text, i = 0) {
  let depth = 0;
  let max = 0;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}") depth--;
    max = Math.max(max, depth);
  }
  return max;
}

// 同じことを、「ブロックを読む関数が、中のブロックを読む関数を呼ぶ」再帰で書く
function readBlock(text, pos) {
  let depth = 1;                                  // pos は、開き括弧の次
  let deepest = 1;
  while (pos < text.length && depth > 0) {
    if (text[pos] === "{") {
      const inner = readBlock(text, pos + 1);     // 自分自身を呼ぶ(入れ子の分だけ)
      deepest = Math.max(deepest, 1 + inner.deepest);
      pos = inner.end;
      continue;
    }
    if (text[pos] === "}") depth--;
    pos++;
  }
  return { end: pos, deepest };
}

const code = "if (a) { for (;;) { if (b) { x(); } } }";
console.log("ループでの深さ:", maxDepth(code));
console.log("再帰での深さ:", readBlock(code, code.indexOf("{") + 1).deepest);
```

```text
# 出力
ループでの深さ: 3
再帰での深さ: 3
```

## 2. 設計思想

| 原則 | 意味 | この拡張のどこに出るか | 破るとどうなるか |
|---|---|---|---|
| **抽出はホスト固有、IR と描画は共有** | 違う所だけ、ホストごとに作る | 3 つの IDE + 共有の Webview | 3 回、図の機能を作る |
| **IR の層を純粋に保つ** | IDE の型を、IR より上に漏らさない | `schema.ts` のコメント | 1 つの IDE でしか動かなくなる |
| **意味づけは 1 か所** | 線のラベル・戻り・終端を、`FlowBuilder` だけが決める | 2 つの読み取りが共有 | 読み取りごとに、結果が食い違う |
| **ヒューリスティックの限界を、文書に書く** | 近似であることを隠さない | `controlFlowScanner.ts` の制約・学習資料 6 | 「完全」だと誤解される |
| **必ず終わる(収束の保証)** | 読み取りに、回数の上限を置く | `maxSteps` | 入力しだいで、無限ループ |
| **誤検出しない** | 行がずれただけで「変更」にしない | `diffIR`(行番号を比べない) | 差分が、ノイズだらけになる |
| **外部入力を信用しない** | 外から来るパスを検査する | `isSafeRelativePath` | リポジトリの外のファイルが開かれる |
| **失敗は帯で、図は消さない** | 入力中の構文エラーで、図を見失わせない | `reportError` | 入力のたびに図が消える |

## 3. 関数・アルゴリズム

| 名前 | 場所 | 何をする | 計算量・注意 |
|---|---|---|---|
| **マスク(文字列・コメントの空白化)** | `codeMask.ts` | 構文を探す前に、文字列・コメントの中身を空白に | O(文字数)。長さ・改行位置は変えない |
| **括弧の対応(深さ)** | `matchBracket` | 開き括弧から、対応する閉じ括弧を探す | O(文字数) |
| **再帰下降** | `controlFlowScanner.ts` | 文を 1 つずつ読み、入れ子は再帰で | O(文字数)。上限つき |
| **LCS(最長共通部分列)** | `diff/ir-diff.ts` | 2 つの列で、順序を保って共通する最長の部分 | **O(n × m)**(動的計画法)。ノード数の積に比例する(1 つの関数の差分なので、数百ノードまでを想定) |
| **グラフの到達(実行順)** | `views.js` の `executionOrder` | 開始から、線をたどる | O(ノード + 線) |

```javascript
// 実行できる
// LCS(最長共通部分列)の動的計画法: 表を後ろから埋める。ir-diff.ts の考え方と同じ
function lcsLength(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp[0][0];
}

const before = ["start", "if (x)", "A()", "B()", "end"];
const after = ["start", "if (x)", "A()", "if (y)", "C()", "B()", "end"];
console.log("共通の長さ:", lcsLength(before, after));
console.log("追加されたノード数:", after.length - lcsLength(before, after), " 削除:", before.length - lcsLength(before, after));
console.log("計算の回数(n × m):", before.length * after.length);
```

```text
# 出力
共通の長さ: 5
追加されたノード数: 2  削除: 0
計算の回数(n × m): 35
```

- **表を埋めるので、同じ小問題を、2 度解かない**(動的計画法)。**順序を保つ**ので、「入れ替え」は、削除 + 追加として見える。

## 4. IT・エンタメの用語の補強

| 用語 | 意味 | この拡張での出番 |
|---|---|---|
| **IDE / 拡張(プラグイン)** | 開発用の統合環境 / それに機能を足す部品 | VS Code・Visual Studio・Rider |
| **AST(抽象構文木)/ CST** | コードの構造を木にしたもの | tree-sitter・Roslyn |
| **制御フロー(CFG)** | 分岐・繰り返しなど、実行の流れのグラフ | 図の元 |
| **言語サーバー / DocumentSymbol** | コードの構造を答える仕組み / 関数・クラスの一覧 | VS Code |
| **Roslyn** | .NET のコンパイラ基盤 | Visual Studio 側 |
| **PSI** | IntelliJ 系のコードのモデル | Rider 側 |
| **WebAssembly / tree-sitter** | ブラウザ・Node で動く形式 / 構文解析器 | 構文木版 |
| **Webview / WebView2 / JCEF** | 拡張の中の、ブラウザの部分 | 描画 |
| **Mermaid** | テキストから図を描く記法 | 出力 |
| **SVG / PNG** | ベクター画像 / ビットマップ画像 | 書き出し |
| **Git / HEAD / diff** | バージョン管理 / 最新のコミット / 差分 | 差分の機能 |
| **CodeBoarding** | リポジトリの構造を解析する外部ツール | 全体の階層 |
| **ヒューリスティック** | 経験則の近似 | 括弧の走査 |
| **ユニットテスト / 結合テスト** | 部品単位 / 実際の環境での総合 | `npm test`・`test:integration` |

## 確認問題

1. 同じ「値の入れ物」が、TypeScript・C#・Kotlin で、どう書き分けられますか。
2. ユニオン型(`"start" | "end" …`)を使う利点は何ですか。
3. 再帰で読む構造には、何が必要ですか。
4. LCS で「入れ替え」が、削除 + 追加に見えるのは、なぜですか。

## 解答

1. `interface`(TypeScript)・`record`(C#)・`data class`(Kotlin)。どれも名前つきの項目を持つ値の入れ物。
2. 書き間違いと、足し忘れ(`switch` の全部の場合分け)を、実行前に見つけられる。
3. 「終わる条件」(もう入れ子が無い)。無いと、無限に自分を呼ぶ。
4. LCS は順序を保った共通部分だけを対応づけるので、順序が入れ替わった要素は、共通に数えられないから。
