# FlowchartVisualizerExtension

書いたスクリプト(C# / TypeScript / Kotlin など)の**制御フロー**を、開発中の IDE 上で、そのまま**フローチャート**として見る拡張。

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

**検証してある言語は C# と TypeScript だけ**。ほかの波括弧の言語は、同じ構文規則に沿う範囲での対応です。インデントでブロックを表す言語(Python など)は、図を作らず「未対応」と知らせます。機能の一覧とコマンドは [docs/reference/features-and-commands.md](docs/reference/features-and-commands.md)。

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
