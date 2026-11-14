# 第 6 回 全体の階層(CodeBoarding の analysis.json)

> 所要時間の目安: 2 時間 / 前提: 第 5 回

## この回のゴール

- **全体 › ファイル › 関数**の階層が、どこから来るのかを説明できる。
- 外部ツールの出力を、**寛容に読む**方針(警告に積む・例外にしない)を説明できる。
- **リポジトリの外を指すパスを通さない**理由と方法を説明できる。

## 1. 何をしているか

[CodeBoarding](https://github.com/CodeBoarding/CodeBoarding) が出す `.codeboarding/analysis.json`(コンポーネント・ファイル・関数・関係)を読み、**拡張の上位階層用の中立なモデル**に直す(`core/architecture/codeboarding-adapter.ts`)。パンくずの「全体」から、コンポーネント → ファイル → 関数と掘り下げ、関数を選ぶと**その関数のフロー**を開く。

- 変換する側(アダプタ)は、**ファイルが実在するか**を判断しない(ホストが `missing` を付ける)。
- **CLASS は関数として出さない**。入れ子のコンポーネントも読む。

## 2. 寛容に読む

`analysis.json` は**外部のツールの出力**で、**そのツールの側で形が変わりうる**。だから:

- **項目ごとの欠落・型違い**は、例外にせず**読み飛ばして `warnings` に積む**。
- 例外を投げるのは、**ルートがオブジェクトでないとき**だけ(分かる文面で)。
- 空のオブジェクトでも落ちない(警告のみ)。

## 3. 外を指すパスを通さない

`analysis.json` は外部の出力なので、**開くファイルのパスを信用しない**。`../../secret.ts` のようなパスで、**リポジトリの外のファイルを開かせない**。

```javascript
// 実行できる
const { parseCodeBoardingAnalysis, isSafeRelativePath } = require("../core/dist/architecture/codeboarding-adapter");

for (const p of ["src/a.ts", "./src/a.ts", "src\\a.ts", "../x.ts", "C:/x.ts", "/etc/passwd", "a/../../b"]) {
  console.log(JSON.stringify(p), isSafeRelativePath(p));
}

const model = parseCodeBoardingAnalysis({
  components: [
    {
      name: "Core",
      description: "中核",
      file_methods: [
        { file_path: "src/a.ts", methods: ["a.run"] },
        { file_path: "../x.ts", methods: ["x.f"] },
      ],
    },
  ],
  methods_index: {
    "src/a.ts|a.run": { file_path: "src/a.ts", qualified_name: "a.run", start_line: 3, end_line: 9, type: "FUNCTION" },
  },
});
console.log(JSON.stringify(model.components[0].files));
console.log(model.warnings);

try {
  parseCodeBoardingAnalysis([1, 2]);
} catch (e) {
  console.log("例外:", e.message);
}
```

```text
# 出力
"src/a.ts" true
"./src/a.ts" true
"src\\a.ts" true
"../x.ts" false
"C:/x.ts" false
"/etc/passwd" false
"a/../../b" false
[{"path":"src/a.ts","functions":[{"name":"run","qualifiedName":"a.run","startLine":3,"endLine":9,"kind":"function"}]}]
[ 'リポジトリの外を指すパス「../x.ts」を読み飛ばしました' ]
例外: analysis.json の形式が不正です(ルートがオブジェクトではありません)
```

- **絶対パス・ドライブ指定・`..` を含むものは、通さない**。区切りは `/` にそろえる(Windows の `\` も同じに扱う)。
- 通さなかった項目は、**警告に積んで**、残りは読み続ける。
- **開く側(`openFunction`)でも、存在確認でも、同じ検査**を使う。

## 4. 関数の行範囲

`methods_index` に、`ファイル|名前` ごとの**開始・終了行**がある。**無ければ警告**(関数の行範囲を取得できない)。関数を開くとき、その行へ飛ぶ。

## 確認問題

1. アダプタが、ファイルの実在を判断しないのは、なぜですか。
2. 項目の欠落で例外にしない理由は何ですか。
3. `../x.ts` を通さない理由は何ですか。
4. 通さなかった項目は、どう扱われますか。

## 解答

1. アダプタはホストに依存しない純粋な変換で、ファイルの実在はホストが確かめる(`missing` を付ける)ため。
2. 外部ツールの出力は形が変わりうるので、一部が壊れていても、読める所は読むため。
3. 外部の出力を信用すると、リポジトリの外の任意のファイルを開かせられるため。
4. 読み飛ばして、警告に積む(残りは読み続ける)。

## まとめ

- 全体の階層は、**外部ツールの出力を、寛容に読んで**作る。壊れた項目は**警告**・ルートだけが例外。
- **外部入力のパスは、信用しない**。絶対パス・ドライブ指定・`..` は通さない。
- 次の回は、これまでを**どこまで自動で確かめているか**と、総合演習。
