# FlowchartVisualizerExtension

書いたスクリプト(C#/TypeScript/Kotlin等)の制御フローを、開発中に使っているIDE上でそのまま
フローチャートとして可視化するIDE拡張。設計方針の詳細は
[`FlowchartVisualizerExtension_DESIGN.md`](FlowchartVisualizerExtension_DESIGN.md)、
2026-10 の改善(UI・複数ビュー・差分・全体階層)は
[`IMPROVEMENT_DESIGN_2026-10.md`](IMPROVEMENT_DESIGN_2026-10.md) /
[`IMPROVEMENT_PLAN_2026-10.md`](IMPROVEMENT_PLAN_2026-10.md) を参照。

**設計指標**: 3つの異なるIDE基盤(VSCode/Visual Studio/Rider)に対し、構造抽出はホスト固有・
中間表現(FlowchartIR)とレンダリングは完全共有、という非対称な統合戦略を採る。

## 構成

| ディレクトリ | 内容 |
|---|---|
| [`core/`](core) | FlowchartIRスキーマ・Mermaid変換・差分(`diff/`)・CodeBoardingアダプタ(`architecture/`)・**共有Webviewバンドル**(3ホスト共通) |
| [`vscode-extension/`](vscode-extension) | VSCode拡張(DocumentSymbol + tree-sitterフォールバック) |
| [`vs-extension/`](vs-extension) | Visual Studio拡張(Roslyn `ControlFlowGraph` + SyntaxWalkerフォールバック) |
| [`rider-plugin/`](rider-plugin) | Rider拡張(Java PSIベース。C#対応は次スパイク、詳細はRIDER_NOTES.md) |

## 使えること

| 機能 | 内容 | VS Code | Visual Studio | Rider |
|---|---|---|---|---|
| フロー表示 | カーソル位置の関数を図にする。ノードは決めごと表の図形(開始/終了=角丸・処理=長方形・分岐=ひし形・繰り返し=六角形) | 実機検証済み | コンパイル確認のみ | 未検証 |
| ビュー切替(X1) | 同じIRから フロー / 呼び出し / 状態 を切替 | 実機検証済み | コンパイル確認のみ | 未検証 |
| テーマ追従(U1) | ライト/ダーク/高コントラストで読める。`--vscode-*` を渡せないホストは `theme` メッセージで色を送る | 実機検証済み | コンパイル確認のみ | 未検証 |
| パンくず・ズーム・ミニマップ(U2) | 全体 › ファイル › 関数 / [−][全体][＋] / 右下ミニマップ | 実機検証済み | コンパイル確認のみ | 未検証 |
| ノードのクリックでジャンプ | 該当行へ移動(行番号のずれなし) | 実機検証済み | コンパイル確認のみ | 未検証 |
| HEADとのフロー差分(X3) | 追加=緑 / 削除=赤の破線 / 変更=黄の太枠。変更のない関数は出さない | 実機検証済み | 未対応 | 未対応 |
| CodeBoarding `analysis.json`(X2) | 「全体」から コンポーネント → ファイル → 関数 | 実機検証済み | 未対応 | 未対応 |
| 動き(X4) | ノードの順次表示 / 実行順の再生(線が引かれる)。`prefers-reduced-motion` で停止 | 実機検証済み | 同左(バンドル共通) | 同左 |
| 書き出し | Mermaidコピー(いま表示中のビュー)/ SVG / PNG | 実機検証済み | コンパイル確認のみ | 未検証 |
| 魔方陣(エンタメ) | `Flowchart: 魔方陣として書き出し` | 動作確認済み | — | — |

- **実機検証済み**: 実際の VS Code(Extension Host)・実ブラウザ(Chrome)で自動テストを通している。
- **コンパイル確認のみ**: Visual Studio 本体が無い環境のため、`dotnet build` で型の整合まで。実機(VS 2022)での起動は未確認。
- **未検証 / 未対応**: Rider は JDK / Gradle が無い環境のためビルド未確認。X3・X2 は VS Code のみ。
- **未実装(意図的)**: X5(カバレッジ連携)。TakayuStudio 系の追補は設計書で「提案(未実装)」とされているため対象外。

VS Code のコマンド(コマンドパレット / エディタの右クリック「Flowchart」):

| コマンド | 内容 |
|---|---|
| `Flowchart: カーソル位置の関数からフローチャートを生成` | カーソルのある関数を図にする(関数の外ならファイルの先頭の関数) |
| `Flowchart: 選択範囲からフローチャートを生成` | 選択範囲を含む関数を図にする |
| `Flowchart: HEAD とのフロー差分を表示` | Git の HEAD と比べ、変更のあった関数だけを差分表示にする |
| `Flowchart: CodeBoarding の analysis.json を読み込む(全体)` | `.codeboarding/analysis.json` を読み、パンくずの「全体」から掘り下げる |
| `Flowchart: Mermaidテキストをコピー` / `SVGとしてエクスポート` / `PNGとしてエクスポート` | 表示中の図を書き出す |

設定: `flowchart.autoRefresh`(保存時に更新)、`flowchart.followCursor`(カーソルのある関数が変わったら図を切替。既定オフ)。

対応言語は、制御構文を波括弧で書く言語(C#・TypeScript・JavaScript・Java・Kotlin・Go・Rust など)。
Python のようにインデントでブロックを表す言語は、図を作らず帯で「未対応」と知らせる。
**検証してあるのは C# と TypeScript のみ**で、他は同じ構文規則に沿う範囲での対応。

## クイックスタート

```bash
# 共有コア(初回のみ。mermaid.min.js をローカル同梱する)
cd core
npm install
npm run fetch-mermaid
npm test                 # 型チェック + ビュー・差分・アダプタの単体テスト
npm run test:webview     # 実ブラウザ(Chrome/Edge)でWebviewを検証。ブラウザが無ければスキップ

# VS Code 拡張
cd ../vscode-extension
npm install
npm test                 # コンパイル + ホスト側ロジックのテスト
npm run test:integration # 実際の VS Code(Extension Host)で結合テスト。VS Code が無ければスキップ
```

`.vscode/launch.json` の「Run Flowchart Visualizer Extension」(F5)で Extension Development Host が開く。
`npm run compile` は毎回、共有バンドルを `vscode-extension/webview-bundle/` へ複製し直す
(古いコピーが `core/` の最新版より優先されて読み込まれるのを防ぐため)。

## 各ホストの詳細

- Visual Studio拡張のビルド手順・既知の制約・Roslyn `ControlFlowGraph` スパイク検証結果は
  [`vs-extension/README.md`](vs-extension/README.md) と [`vs-extension/SPIKE_RESULTS.md`](vs-extension/SPIKE_RESULTS.md)。
- Rider拡張のビルド手順・既知の制約(C#未対応の理由)は
  [`rider-plugin/README.md`](rider-plugin/README.md) と [`rider-plugin/RIDER_NOTES.md`](rider-plugin/RIDER_NOTES.md)。

## おまけ: 魔方陣化(エンタメ用)

`core/render/magic-circle-emitter.ts`は同じ`FlowchartIR`を、姉妹リポジトリ
[`MagicCircleGenerator`](../MagicCircleGenerator)が読める魔方陣レシピ(JSON)に変換する
もう1つのエミッター。Mermaidフローチャートの代替ではなく、あくまでエンタメ用途。
マッピング仕様は [`core/render/MAGIC_CIRCLE_MAPPING_SPEC.md`](core/render/MAGIC_CIRCLE_MAPPING_SPEC.md)。

```bash
cd core
node scripts/smoke-test-magic-circle.js   # レシピJSONをdist/output/へ生成
```
