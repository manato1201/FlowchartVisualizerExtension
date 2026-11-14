# 第 2 回 ソースを読む下ごしらえ(マスクと括弧)

> 所要時間の目安: 2.5 時間 / 前提: 第 1 回

## この回のゴール

- 文字列・コメントを**マスク**する理由と、その**不変条件**(長さ・改行位置が同じ)を説明できる。
- 括弧の対応を調べ、**編集中の構文エラー**を見つけられる。
- ファイル全文から、**名前で関数を切り出す**方法と、その限界を説明できる。

## 1. なぜマスクするか

制御構文(`if`・`for`・`{`)を**文字で探す**とき、次の行を取り違えたくない。

```
var s = "if (x) { y(); }";   // for (;;) { }
```

文字列や `//` の中の `if` は、構文ではない。そこで、**文字列・コメントの中身を空白に置き換えた**テキスト(**マスク**)を作り、**キーワードと括弧はマスクに対してだけ探す**。ラベルに出す文字は、**同じ位置**の元のテキストから取る。

マスクの**約束**:

- **長さが同じ**。位置(オフセット)が、元のテキストと**1 対 1 に対応**する。
- **改行は残す**。行番号が狂わない。
- 中身だけを空白にし、**引用符そのもの**は残す。

```typescript
// 抜粋ファイル: vscode-extension/src/codeMask.ts
const blank = (from: number, to: number) => {
  for (let k = from; k < to; k++) {
    const c = out[k];
    if (c !== "\n" && c !== "\r") out[k] = " ";
```

対応している文字列: 通常の `"…"`(同じ行で閉じる)・C# の**生文字列** `"""…"""` と**逐語的** `@"…"`・`'…'`・JS の**テンプレートリテラル** `` `…` ``。閉じ忘れは**行末で打ち切る**(後ろを巻き込まない)。

## 2. 括弧の対応と、編集中のエラー

`checkBraceBalance` は、**マスクした**テキストの `{` と `}` を数える。入力中の(閉じていない)コードで、**間違った図を出さず**、理由を伝えるために使う。

```javascript
// 実行できる
const { maskCode } = require("./dist/vscode-extension/src/codeMask");
const { checkBraceBalance, plainFunctionName } = require("./dist/vscode-extension/src/functionSlicer");

const src = 'var s = "if (x) { y(); }"; // for (;;) { }';
const masked = maskCode(src);
console.log("長さが同じ:", masked.length === src.length);
console.log("マスク:", JSON.stringify(masked));

console.log(checkBraceBalance("void F() { if (x) { } }"));
console.log(checkBraceBalance("void F() { if (x) { }"));
console.log(checkBraceBalance("void F() { } }"));
console.log(checkBraceBalance('void F() { /* まだ閉じていない'));
console.log(checkBraceBalance('void F() { var s = "}"; }'));
console.log(plainFunctionName("void Update(int x)"), plainFunctionName("Player.Update"));
```

```text
# 出力
長さが同じ: true
マスク: "var s = \"               \";                "
{ ok: true }
{ ok: false, reason: '開き波括弧 { が閉じられていません' }
{ ok: false, reason: '閉じ波括弧 } が余っています' }
{ ok: false, reason: 'コメント /* が閉じられていません' }
{ ok: true }
Update Update
```

- 文字列の中の `"}"` は、**数えない**(最後から 2 番目)。
- 閉じていないブロックコメントは、**専用の理由**で知らせる。

## 3. 名前で関数を切り出す

差分(第 4 回)では、**変更前(HEAD)のファイル全文**から、同じ名前の関数を取り出す。

```javascript
// 実行できる
const { sliceFunctionByName } = require("./dist/vscode-extension/src/functionSlicer");

const file = `class P {
  void Update(int x) {
    if (x > 0) { Tick(); }
  }
  void Run() { Update(1); }
  void Update(string s) {
    Log(s);
  }
}`;

const first = sliceFunctionByName(file, "Update", 0);
const second = sliceFunctionByName(file, "Update", 1);
console.log(JSON.stringify(first));
console.log(JSON.stringify(second));
console.log("呼び出し(Update(1);)は定義ではない:", first.text.includes("Update(1)") === false);
console.log("無い名前:", sliceFunctionByName(file, "Missing"));
```

```text
# 出力
{"text":"  void Update(int x) {\n    if (x > 0) { Tick(); }\n  }","startLine":1}
{"text":"  void Update(string s) {\n    Log(s);\n  }","startLine":5}
呼び出し(Update(1);)は定義ではない: true
無い名前: null
```

- **同名の定義が複数あるとき**(C# のオーバーロード)は、出現順の `nth` 番目(0 始まり)を返す。
- **呼び出しを定義と取り違えない**工夫: 名前の直前が `(`・`=`・`.`・`,` など、または `return`・`new` などの語なら定義ではない。引数の後ろが `;` なら、宣言か呼び出し。
- **式形式のメンバー**(`=> expr;`)は波括弧が無いので、**対象外**。

## 確認問題

1. マスクが「長さ・改行位置を変えない」のは、なぜですか。
2. `checkBraceBalance` は、文字列の中の `}` をどう扱いますか。
3. `sliceFunctionByName(file, "Update", 1)` の `1` は何ですか。
4. 呼び出し `Update(1);` を、定義と取り違えないために、何を見ていますか。

## 解答

1. マスクで見つけた位置を、**そのまま元のテキストの位置**として使い、行番号を保つため。
2. 数えない(マスクで空白になっているため)。
3. 同名の定義のうち、**出現順の 2 番目**(0 始まり)。
4. 名前の直前の文字・語(`(`・`=`・`return` など)と、引数の後ろが `;` か `{` か。

## まとめ

- **構文を探すのはマスク、ラベルを取るのは元のテキスト**。位置は 1 対 1。
- 括弧の対応で、編集中のコードを**図にせず、理由を伝える**。
- 名前による切り出しは**ヒューリスティック**(式形式のメンバーは対象外)。次の回は、いよいよ**制御フローの組み立て**。
