# 第 3 回 制御フローを組み立てる(再帰下降と FlowBuilder)

> 所要時間の目安: 3 時間 / 前提: 第 2 回

## この回のゴール

- 文を 1 つずつ読む**再帰下降**の考え方を説明できる。
- `Flow`(入口・出口・終端)で、文を**部品として**組み立てる方法を説明できる。
- **到達不能コード**の除去と、`switch`・`try`・`do/while` の扱いを説明できる。

## 1. 分担: 読む人と、組み立てる人

制御フローの「**どの構文か**」を判断する人(読み取り側)と、「**どう線を引くか**」を決める人(`FlowBuilder`)を、**分ける**。

| 役割 | 場所 | やること |
|---|---|---|
| 読み取り(括弧の走査) | `controlFlowScanner.ts` | `if`・`for` などの**構文を見分け**、`FlowBuilder` を呼ぶ |
| 読み取り(構文木) | `treeSitterWalker.ts` | tree-sitter の木から、同じく `FlowBuilder` を呼ぶ |
| 組み立て | `core/flowchart-ir/flow-builder.ts` | true / false の線・戻りの線・`return` の終端・到達不能の除去 |

> 以前は、2 つの読み取りが**それぞれ別の規則で**組み立てていて、**結果が食い違っていた**。意味づけを `FlowBuilder` の 1 か所にまとめたのが、この設計。

## 2. Flow: 文を「部品」として見る

```typescript
// 抜粋ファイル: core/flowchart-ir/flow-builder.ts
export interface Flow {
  entryId?: string;
  exits: Exit[];
  terminals: string[];
}
```

- `entryId`: **入口**のノード。空の文は `undefined`。
- `exits`: **次の文へ繋ぐ口**。空なら「ここから先へは進まない」(`return`・`throw`)。
- `terminals`: `return`・`throw` のノード。**最後に、関数の `End` へ繋ぐ**。

`if` は、「条件のノード」を作り、then と else の `Flow` を**部品として受け取って**、`true` / `false` の線で繋ぎ、**両方の出口を合わせて**自分の出口にする。`for` は、本体の出口から**条件へ戻る線**を引き、出口は「条件の false」だけ。

## 3. 動かしてみる

```javascript
// 実行できる
const { irFromFunctionText } = require("./dist/vscode-extension/src/functionSlicer");

const show = (ir) => {
  console.log(ir.nodes.map((n) => `${n.id}:${n.kind}:${n.label}`).join(" | "));
  console.log(ir.edges.map((e) => `${e.from}>${e.to}${e.label ? ":" + e.label : ""}`).join(" "));
};

// return のあとの Dead(); は到達できないので、ノードにならない
show(irFromFunctionText("void F(int x)\n{\n  if (x < 0)\n  {\n    return;\n  }\n  Work();\n  return;\n  Dead();\n}", 0, "F()", "a.cs"));
```

```text
# 出力
n1:start:F() | n2:decision:if (x < 0) | n3:process:return; | n4:process:Work(); | n5:process:return; | n6:end:End
n2>n3:true n2>n4:false n4>n5 n1>n2 n3>n6 n5>n6
```

- `return;` が **2 つ**ある(早期 return と、最後の return)。**どちらも `End` へ繋がる**(`n3>n6`・`n5>n6`)。
- `Dead();` は**図に出ない**(読んだあとで**取り消す**: `FlowBuilder.rollback`)。
- 連続する**単純な文**(`A(); B();`)は、**1 つの処理ノード**にまとまる。

## 4. 難しい構文

```javascript
// 実行できる
const { irFromFunctionText } = require("./dist/vscode-extension/src/functionSlicer");

const code = `int G(int k)
{
  switch (k)
  {
    case 1: A(); break;
    case 2: B(); break;
    default: C(); break;
  }
  do { Step(); } while (more);
  try { Risky(); } catch (Exception e) { Log(e); }
}`;
const ir = irFromFunctionText(code, 0, "G()", "a.cs");
console.log(ir.nodes.map((n) => `${n.id}:${n.kind}:${n.label}`).join(" | "));
console.log(ir.edges.map((e) => `${e.from}>${e.to}${e.label ? ":" + e.label : ""}`).join(" "));
```

```text
# 出力
n1:start:G() | n2:decision:switch (k) | n3:process:A(); break; | n4:process:B(); break; | n5:process:C(); break; | n6:process:Step(); | n7:loop:do/while (more) | n8:process:Risky(); | n9:process:catch (Exception e) | n10:process:Log(e); | n11:end:End
n2>n3 n2>n4 n2>n5 n6>n7 n7>n6:true n3>n6 n4>n6 n5>n6 n9>n10 n8>n9 n7>n8:false n1>n2 n8>n11 n10>n11
```

- **switch**: 条件(ひし形)から、**各 case の先頭へ線**。**線のラベルは空**(スキーマは `true`・`false`・空のみなので、`case 1` という値は出さない)。`break` は流れを変えず、ふつうの文として並ぶ。
- **do/while**: 本体が**先**。条件が `true` なら、本体の先頭へ**戻る**。
- **try/catch**: 本体の先頭から `catch` へ**線を 1 本**。出口は本体と各 `catch` の和集合。

## 5. 必ず終わる作り(安全装置)

```typescript
// 抜粋ファイル: vscode-extension/src/controlFlowScanner.ts
this.maxSteps = src.length * 8 + 1000;
if (++this.steps > this.maxSteps) {
throw new Error("構文を解析しきれませんでした(読み取りが収束しませんでした)");
```

読み取りの回数に**上限**を置く。どんな入力でも**必ず終わる**(以前は、波括弧なしの `if` で**無限ループ**して、メモリを使い切った)。**ヒューリスティックな読み取りは、収束を保証する仕組みを、必ず持つ**。

## 6. 限界(ヒューリスティックであること)

- `break`・`continue` は流れを変えず、**ループの外へ出る線は描かない**。
- `try/catch` は、本体の先頭から `catch` へ 1 本だけ(**例外が起きうる位置までは見ない**)。
- **ラムダ・ローカル関数の中**は、外側の 1 文として扱い、中の `if`・`for` は図にしない。
- 検証してあるのは **C# と TypeScript** だけ。他の波括弧の言語は、**同じ規則に沿う範囲**での対応。

## 確認問題

1. `Flow` の `exits` が**空**のとき、何を意味しますか。
2. `return;` のあとの文は、なぜ図に出ませんか。
3. `switch` の線に `case` の値が出ないのは、なぜですか。
4. 読み取りの回数に上限があるのは、なぜですか。

## 解答

1. 「ここから先へは進まない」(`return`・`throw` で終わる)。
2. 到達できないので、読んだあとで**取り消す**(`rollback`)から。
3. エッジのラベルは `true`・`false`・空だけ、とスキーマが決めているから。
4. 入力によって読み取りが進まなくなっても、**必ず終わらせる**ため。

## まとめ

- **読み取り(構文の判断)と組み立て(線の意味づけ)を分ける**。意味づけは `FlowBuilder` の 1 か所。
- 文は `Flow`(入口・出口・終端)の**部品**。`if`・`for`・`switch`・`try` は、部品を組み合わせて作る。
- ヒューリスティックなので**限界を文書に書き**、読み取りは**必ず終わる**ようにする。次の回は、2 つの IR の**差分**。
