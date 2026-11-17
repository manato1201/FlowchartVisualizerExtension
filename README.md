# FlowchartVisualizerExtension

書いたスクリプト(C# / TypeScript / Python / Kotlin など)の**制御フロー**を、開発中の IDE 上で、そのまま**フローチャート**として見る拡張。

![全体の構成図](docs/diagrams/architecture.svg)

- **関数を図にする**: カーソルのある関数 → 開始・処理・分岐・繰り返し・終了。ノードを押すと、**その行へ飛ぶ**。
- **ビューの切替**: 同じデータから「フロー / 呼び出し / 状態」。ライト・ダーク・高コントラストに追従。
- **HEAD との差分**: 変わった関数だけを、追加=緑・削除=赤の破線・変更=黄の太枠で(VS Code)。
- **全体の階層**: CodeBoarding の `analysis.json` から、全体 › ファイル › 関数 と掘り下げる(VS Code)。
- **書き出し**: Mermaid のコピー・SVG・PNG。おまけで、魔方陣(エンタメ)。

**設計の方針**: 3 つの IDE 基盤で、**コードの読み方(抽出)はホスト固有**、**中間表現(FlowchartIR)と描画は完全に共有**する(非対称な統合)。

## 状態

| ホスト | 基盤 | 状態 |
|---|---|---|
| **VS Code** | DocumentSymbol + 括弧の走査 / tree-sitter | **実機で検証済み**(Extension Host・実ブラウザの自動テスト) |
| **Visual Studio** | Roslyn `ControlFlowGraph` + SyntaxWalker | **コンパイル確認のみ**(`dotnet build`・C# のテスト 8 件)。実機の VS 2022 での起動は未確認 |
| **Rider** | Java PSI | **ビルド未確認**(JDK / Gradle が無い環境)。**C# は未対応** |

**検証してある言語は C#・TypeScript・Python**。ほかの波括弧の言語は、同じ構文規則に沿う範囲での対応です。Ruby のようにインデントでブロックを表す他の言語は、図を作らず「未対応」と知らせます。機能の一覧とコマンドは [docs/reference/features-and-commands.md](docs/reference/features-and-commands.md)。

## クイックスタート

```bash
# 共有コア(初回のみ。mermaid.min.js をローカル同梱する)
cd core
npm install
npm run fetch-mermaid
npm test                 # 型チェック + ビュー・差分・アダプタの単体テスト
npm run test:webview     # 実ブラウザ(Chrome/Edge)で Webview を検証。ブラウザが無ければスキップ

# VS Code 拡張
cd ../vscode-extension
npm install
npm test                 # コンパイル + ホスト側ロジックのテスト
npm run test:integration # 実際の VS Code(Extension Host)で結合テスト。VS Code が無ければスキップ
```

`.vscode/launch.json` の「Run Flowchart Visualizer Extension」(F5)で Extension Development Host が開きます。コマンドパレットの「Flowchart: カーソル位置の関数からフローチャートを生成」を実行。

> `npm run compile` は毎回、共有バンドルを `vscode-extension/webview-bundle/` へ複製し直します(古いコピーが `core/` の最新版より優先されるのを防ぐため)。**複製は直接編集しません。**

## 対応言語・フローの JSON 入力・大きな図

**対応言語(VS Code)**

| 言語 | 読み方 | 検証 |
|---|---|---|
| C# | 言語サーバーのシンボル + 括弧の走査 / tree-sitter | 検証済み |
| TypeScript・TSX・JavaScript | 同上 | 検証済み(TypeScript) |
| **Python** | **tree-sitter のみ**(`def`・`if/elif/else`・`for`/`while`+`else`・`try/except/else/finally`・`with`・`match`・`return`/`raise`・`break`/`continue`) | 単体テスト・Extension Host の結合テスト。HEAD との差分は未対応 |
| Java・Kotlin・Go・Rust など | 括弧の走査(同じ構文規則に沿う範囲) | 未検証 |

**フローの JSON を渡して描く(LLM・外部ツール向け)**: コードの代わりに、ノードと線の JSON を渡せます。仕様は [JSON Schema](docs/reference/flowchart-ir.schema.json)。**入力は信用しません**: 未知のキー・ID の重複・存在しないノードを指す線・Mermaid の構文語の ID は理由つきで拒否し、ラベルは 200 文字に切り詰めて制御文字を除き、Mermaid の特殊文字はエスケープします(HTML として解釈されません)。LLM の呼び出し自体はここにはありません(JSON を受け取るだけ)。

```bash
cd core && npm run build
echo '{"nodes":[{"id":"n1","kind":"start","label":"login()"},{"id":"n2","kind":"decision","label":"ok?"},{"id":"n3","kind":"end","label":"End"}],"edges":[{"from":"n1","to":"n2"},{"from":"n2","to":"n3","label":"true"}]}' | node scripts/ir-to-mermaid.js
```

VS Code では、コマンド `Flowchart: フローの JSON(IR)から図を描く`(選択範囲、なければエディタ全文を読む)か、`vscode.commands.executeCommand("flowchart.renderFromIrJson", jsonStringOrObject)` で描けます。TypeScript からは `core/flowchart-ir/ir-input.ts` の `parseFlowchartIRInput(input)`(成功すれば `ir`、失敗すれば `errors`)。

**大きな図**: ノードが **300 個**を超えると(Mermaid の描画時間はノード数の約 2 乗で増えるため)、描く前に帯で知らせ、既定では簡易表示(分岐とループの要約)で描きます。「全体を描く」で全体も描けます(データは捨てません)。長いラベルは折り返し、省略した全文はホバーで見られます。

**同梱する WASM の出典**: tree-sitter の文法は npm の [`tree-sitter-wasms`](https://github.com/Gregoor/tree-sitter-wasms)(Unlicense)から `vscode-extension/wasm/` へコピーします(`npm run fetch-wasm`)。Python の文法は [`tree-sitter-python`](https://github.com/tree-sitter/tree-sitter-python)(MIT)を `tree-sitter-wasms` が WASM にしたもの(`tree-sitter-python.wasm`、約 465 KB。`wasm/` 全体は約 9.1 MiB から約 9.6 MiB へ、約 5% 増)。実行系は [`web-tree-sitter`](https://github.com/tree-sitter/tree-sitter)(MIT)。

## ドキュメント

| 読むもの | 内容 |
|---|---|
| [**講義資料**](docs/lecture/index.md) | **基礎から**(IR・マスク・制御フロー・差分・ビュー・全体階層・テスト)。全 8 回・実行できる例つき |
| [**学習資料**](docs/learn/index.md) | **保守・拡張の実務編**(コードの読み方・拡張のレシピ・テスト・トラブルと保守・用語集) |
| [機能・コマンド・設定](docs/reference/features-and-commands.md) | ホストごとの機能表・コマンド・設定・魔方陣 |
| [設計書](FlowchartVisualizerExtension_DESIGN.md) | なぜこの形か |
| [改善設計](IMPROVEMENT_DESIGN_2026-10.md) / [改善計画](IMPROVEMENT_PLAN_2026-10.md) | 2026-10 の改善(UI・複数ビュー・差分・全体階層) |
| [vs-extension/README.md](vs-extension/README.md)・[SPIKE_RESULTS.md](vs-extension/SPIKE_RESULTS.md) | Visual Studio 拡張のビルド・Roslyn CFG のスパイク結果 |
| [rider-plugin/README.md](rider-plugin/README.md)・[RIDER_NOTES.md](rider-plugin/RIDER_NOTES.md) | Rider 拡張のビルド・C# 未対応の理由 |
