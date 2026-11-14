# 4. 拡張のレシピ

どのレシピも、**同じ順**で進めます: ①挙動を決める → ②**失敗するテストを先に** → ③実装 → ④3 ホストへの影響を確かめる → ⑤文書。

## 先に知っておく: ミラーが何か所あるか

**IR の型と、Mermaid への変換は、3 つの言語に写してある**(ホストごとに言語が違うため)。

| もの | TypeScript(正本) | C#(Visual Studio) | Kotlin(Rider) |
|---|---|---|---|
| IR の型 | `core/flowchart-ir/schema.ts` | `vs-extension/FlowchartExtractor/FlowchartIR.cs` | `rider-plugin/.../FlowchartIr.kt` |
| Mermaid 変換 | `core/render/mermaid-emitter.ts` | `.../MermaidEmitter.cs` | `.../MermaidEmitter.kt` |
| IR の JSON | – | `.../IrJson.cs` | `.../IrJson.kt` |

さらに、Webview の `views.js` が、**図形の表を同じ内容でもう 1 つ**持つ。**スキーマ・図形・エスケープを変えるときは、これら全部を同時に直す**(`test-views.js` が、フローの Mermaid が `emitMermaid` と一致することを見張る)。

## レシピ A: 新しい構文を足す(例: `foreach` の別名・`using` 相当)

1. **テストを先に**: `vscode-extension/scripts/test-scanner.js` に、その構文を含む小さなコードと、期待する**ノード列・エッジ**を書く。
2. **括弧の走査**(`controlFlowScanner.ts`)を直す。構文を見分ける語は `FLOW_KEYWORDS`・`PAREN_BLOCK_KEYWORDS`・`BARE_BLOCK_KEYWORDS`、判定は `peek`、組み立ては `parseControl`。
3. **構文木版**(`treeSitterWalker.ts`)も直す。ノードの型の集合(`IF_TYPES` など)に、その構文の型名を足す。
4. **意味づけが新しく要る**(新しい種類の線・出口)なら、`FlowBuilder`(`core/`)に**メソッドを足す**。2 つの読み取りのどちらにも、意味づけを書かない。
5. **両方が同じ構造を返す**ことを、テスト(テキスト版と構文木版の比較)で確かめる。
6. **必ず終わる**ことを確かめる(閉じていない括弧・空の本体・到達不能)。

## レシピ B: 言語を足す

1. **対応言語**: `flowExtractor.ts` の `FLOW_LANGUAGE_IDS` と `FLOW_FILE_EXTENSIONS` に足す。
2. **波括弧でブロックを書く言語**に限る(インデントでブロックを表す言語は、括弧の走査では読めない)。
3. tree-sitter の文法も使うなら: `scripts/fetch-wasm.js` の文法の一覧に足し、`treeSitterExtractor.ts` の `LANGUAGE_ID_TO_GRAMMAR` に足し、`treeSitterWalker.ts` の**関数・文の型名**をその文法に合わせる。
4. **検証済みと書かない**。検証してあるのは C# と TypeScript だけ。新しい言語は、サンプルのコードで**走査と構文木版の構造を比べる**テストを足してから、README の表を直す。

## レシピ C: ビューを足す

`core/webview-bundle/views.js` の `VIEWS` に宣言を足し(`id`・`label`・`description`・`kinds`、必要なら `processFilter`)、`VIEW_ORDER` に入れる。**Webview の切替ボタンは `VIEW_ORDER` から作られる**ので、宣言だけで増える。`test-views.js` に、ノード数と繋ぎ直しのテストを足す。

## レシピ D: ホストと Webview のメッセージを足す

1. 向きを決める(ホスト → Webview か、Webview → ホストか)。
2. **Webview → ホスト**: `bridge.js` から `window.flowchartHostPost({type: "…", …})`。ホスト側は `onWebviewMessage("…", handler)`(VS Code)。**他の 2 ホスト(WebView2・JCEF)にも、受け口が要る**。
3. **ホスト → Webview**: `postToPanel({type: "…", …})`。`bridge.js` の `message` の処理に、受け取りを足す。
4. **受け取る側は、型と値を疑う**(`typeof m.text !== "string"` のように検査する。`copyText` の例)。
5. `bridge.js` の先頭の**メッセージの一覧のコメントも直す**(正本)。

## レシピ E: 新しいホスト(IDE)を足す

1. **抽出**を、そのホストの方法で書き、**FlowchartIR を出す**(`FlowBuilder` 相当の意味づけは、そのホストの言語に写す)。
2. **IR の JSON を、Webview へ渡す**。送信口 `window.flowchartHostPost` を、ホストの仕組みで定義する(`host-shim.js` がひな形)。
3. **テーマ**: `--vscode-*` の変数が無いホストは、`theme` メッセージで色を送る。
4. **やらない**: Webview(`core/webview-bundle/`)を、ホストごとに分けること。
5. 検証できない範囲(実機が無い)は、**README の表に「確認の範囲」を正直に書く**。

## レシピ F: 魔方陣のマッピングを変える

`core/render/MAGIC_CIRCLE_MAPPING_SPEC.md`(仕様)→ `magic-circle-emitter.ts`。**別リポジトリ(MagicCircleGenerator)の型のミラー**なので、相手の `schema.ts` が正。**既存の `Ring` スキーマは変えない**。

## 足したら、必ずやること

1. `cd core && npm test`・`cd vscode-extension && npm test`。
2. Webview を触ったら、`cd core && npm run test:webview`(実ブラウザ)。
3. 文書を触ったら、`python tools/check_docs.py`。
4. **3 ホストに影響する変更**は、TypeScript だけで終えない(C# の `dotnet test`、Kotlin の写し)。
