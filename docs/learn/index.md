# FlowchartVisualizerExtension 学習資料(保守・拡張の実務編)

このフォルダは、**この拡張を直す・足す人**のための資料です。基礎から順に学ぶ講義は [../lecture/index.md](../lecture/index.md)(第 0〜7 回)。機能の一覧・コマンド・設定は [features-and-commands.md](../reference/features-and-commands.md)。設計の経緯は [設計書](../../FlowchartVisualizerExtension_DESIGN.md)・[改善設計](../../IMPROVEMENT_DESIGN_2026-10.md)。

| # | 資料 | いつ読むか |
|---|---|---|
| 1 | [全体像](01-overview.md) | 部品・3 ホスト・データの流れ・ビルドの前提 |
| 2 | [コードの読み方](02-code-tour.md) | どのファイルから読むか・1 回の生成の流れ |
| 3 | [内側のしくみ](03-internals.md) | 関数の特定・2 つの読み取り・差分の実行・パネル・書き出し |
| 4 | [拡張のレシピ](04-extend.md) | 構文・言語・ビュー・メッセージ・ホストを**足したい** |
| 5 | [テストの書き方と実行](05-testing.md) | テストを回す・足す・文書の検査・**確かめていないこと** |
| 6 | [トラブルと保守](06-troubleshooting-maintenance.md) | 動かない・**既知の問題**・定期の保守 |
| – | [用語集](glossary.md) | 分からない言葉が出た |

## 最初の 15 分

1. `core/` で `npm install` → `npm run fetch-mermaid` → `npm test`(型検査と単体テスト)。
2. `vscode-extension/` で `npm install` → `npm test`(走査とホストの論理のテスト)。
3. `.vscode/launch.json` の「Run Flowchart Visualizer Extension」(F5)で拡張を起動し、C# か TypeScript のファイルで「Flowchart: カーソル位置の関数から…」を実行。
4. [構成図](../diagrams/architecture.svg)を見ながら、[全体像](01-overview.md)を読む。

## コードの地図(早見表)

| 場所 | 役割 |
|---|---|
| `core/flowchart-ir/schema.ts` | FlowchartIR の型・検証・採番 |
| `core/flowchart-ir/flow-builder.ts` | 文の部品(`Flow`)から線を引く共通部品。**意味づけはここだけ** |
| `core/render/mermaid-emitter.ts` | IR → Mermaid |
| `core/render/magic-circle-emitter.ts` | IR → 魔方陣(エンタメ) |
| `core/diff/ir-diff.ts` | 2 つの IR の差分(LCS) |
| `core/architecture/codeboarding-adapter.ts` | `analysis.json` → 全体の階層 |
| `core/webview-bundle/` | 共有の Webview(`bridge.js`・`views.js`・`motion.js`・`viewport.js`・`motif.js`・`host-shim.js`) |
| `vscode-extension/src/` | VS Code 拡張(`extension.ts`・`flowExtractor.ts`・`controlFlowScanner.ts`・`treeSitter*.ts`・`codeMask.ts`・`functionSlicer.ts`・`gitDiff.ts`・`webviewPanel.ts`) |
| `vs-extension/` | Visual Studio 拡張(Roslyn)。`FlowchartExtractor/`(抽出)・`FlowchartVisualizerVsix/`(VSPackage) |
| `rider-plugin/` | Rider 拡張(Kotlin・Java PSI) |
