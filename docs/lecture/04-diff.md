# 第 4 回 フローの差分(LCS)

> 所要時間の目安: 2.5 時間 / 前提: 第 3 回

## この回のゴール

- 2 つの IR を比べるとき、**行番号を比較に使わない**理由を説明できる。
- **LCS(最長共通部分列)**で、ノードを対応づける方法を説明できる。
- 追加・削除・変更の判定と、**エッジの比較**(対応づけ後の ID で)を説明できる。

## 1. 何を解きたいか

Git の HEAD の関数と、いまの関数を比べ、**変わった所だけ**を色分けしたい(追加=緑・削除=赤の破線・変更=黄の太枠)。

**誤検出を避ける**ことが、最も大事。**上に 1 行足されて、全体の行番号がずれただけ**の関数を、「変更あり」にしてはいけない。そこで:

- 比較のキーは、**種別と、空白をたたんだラベル**だけ(**行番号は使わない**)。
- ノードの ID は、両方の IR で**別々に採番**されるので、比較に使わない。

## 2. LCS で対応づける

ノードの列(キーの並び)を、**順序を保ったまま**、最も長く共通する部分に対応づける。対応したノードは `unchanged`。

```typescript
// 抜粋ファイル: core/diff/ir-diff.ts
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp = new Uint32Array((n + 1) * width);
```

対応しなかった**区間の中**で、**同じ種別**のものは「削除 + 追加」ではなく「**変更**」と見なす(`if (a)` → `if (b)` は、変更)。

## 3. 動かしてみる

```javascript
// 実行できる
const { irFromFunctionText } = require("./dist/vscode-extension/src/functionSlicer");
const { diffIR } = require("../core/dist/diff/ir-diff");

const before = irFromFunctionText("void F()\n{\n  if (x) { A(); }\n  B();\n}", 0, "F()", "a.cs");
const after = irFromFunctionText("// 1行足した\nvoid F()\n{\n  if (x) { A(); }\n  if (y) { C(); }\n  B();\n}", 0, "F()", "a.cs");

const r = diffIR(before, after);
console.log(r.summary);
console.log(r.ir.nodes.map((n) => `${n.id}:${n.diff}:${n.label}`).join(" | "));

// 上に空行を足しただけ(行番号だけがずれた)なら、変更なし
const shifted = irFromFunctionText("\n\nvoid F()\n{\n  if (x) { A(); }\n  B();\n}", 0, "F()", "a.cs");
console.log("行がずれただけ → 変更あり?", diffIR(before, shifted).hasChanges);

// ラベルだけ変えると「変更」。変更前のラベルを持つ
const edited = irFromFunctionText("void F()\n{\n  if (z) { A(); }\n  B();\n}", 0, "F()", "a.cs");
const e = diffIR(before, edited).ir.nodes.find((n) => n.diff === "changed");
console.log(e.label, "←", e.previousLabel);
```

```text
# 出力
{
  nodesAdded: 2,
  nodesRemoved: 0,
  nodesChanged: 0,
  nodesUnchanged: 5,
  edgesAdded: 5,
  edgesRemoved: 2
}
n1:unchanged:F() | n2:unchanged:if (x) | n3:unchanged:A(); | n4:added:if (y) | n5:added:C(); | n6:unchanged:B(); | n7:unchanged:End
行がずれただけ → 変更あり? false
if (z) ← if (x)
```

- 新しい `if (y)` と `C();` は `added`。他は `unchanged`。
- **行がずれただけ**では、変更なし(行番号を比べないから)。
- `if (x)` → `if (z)` は `changed`で、`previousLabel` に**変更前**のラベルが残る(ツールチップで見せる)。

## 4. エッジの比較

ノード ID は両版で別採番なので、**対応づけの後の ID**に直してから、エッジ(`from>to>label`)を比べる。

- 後にだけあるエッジ → `added`・前にだけあるエッジ → `removed`。
- **ノードは同じでも、線の付け替え**(分岐先が変わった)は、エッジの差分として**検出される**。
- **削除されたノード**は、ID に `rm_` を付けて**共存させる**(後の IR の ID とぶつからない)。

**新規の関数**(変更前に無い)は、`allAdded`(すべて追加)。**入力の IR は壊さない**(コピーして返す)。

## 確認問題

1. 比較に行番号を使わないのは、なぜですか。
2. `if (a)` が `if (b)` に変わったとき、「変更」になるのはなぜですか。
3. 削除されたノードの ID に `rm_` を付けるのは、なぜですか。
4. ノードは同じで、`true` の行き先だけが変わったとき、差分に出ますか。

## 解答

1. 上に 1 行足されただけで全体がずれた関数を、「変更あり」と誤検出しないため。
2. LCS で対応しなかった区間の中で、**同じ種別**のものを「変更」と見なすから。
3. 前後の IR は別々に採番しているので、ID がぶつからないようにするため。
4. 出る。エッジを、対応づけ後の ID で比べるので、「前にだけ・後にだけあるエッジ」として検出される。

## まとめ

- 比較のキーは**種別とラベル**。行番号・ID は使わない。
- **LCS で対応づけ**、未対応の区間の同種を「変更」にする。エッジは、**対応づけ後の ID**で比べる。
- **誤検出しないこと**が最優先。次の回は、差分も含めて、図を**描く側**(Webview)。
