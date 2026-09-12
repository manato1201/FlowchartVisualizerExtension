# FlowchartVisualizerExtension

書いたスクリプト(C#/TypeScript/Kotlin等)の制御フローを、開発中に使っているIDE上でそのまま
フローチャートとして可視化するIDE拡張。設計方針の詳細は
[`FlowchartVisualizerExtension_DESIGN.md`](FlowchartVisualizerExtension_DESIGN.md) を参照。

**設計指標**: 3つの異なるIDE基盤(VSCode/Visual Studio/Rider)に対し、構造抽出はホスト固有・
中間表現(FlowchartIR)とレンダリングは完全共有、という非対称な統合戦略を採る。

## 構成

| ディレクトリ | 内容 | 状態 |
|---|---|---|
| [`core/`](core) | FlowchartIRスキーマ・Mermaid変換・共有Webviewバンドル(3ホスト共通) | 実装・検証済み |
| [`vscode-extension/`](vscode-extension) | VSCode拡張(DocumentSymbol + tree-sitterフォールバック) | 実装・ビルド・スモークテスト済み |
| [`vs-extension/`](vs-extension) | Visual Studio拡張(Roslyn `ControlFlowGraph` + SyntaxWalkerフォールバック) | 抽出ロジックは実装・テスト済み。VSIXパッケージングは実機VS必要(README参照) |
| [`rider-plugin/`](rider-plugin) | Rider拡張(Java PSIベース。C#対応は次スパイク、詳細はRIDER_NOTES.md) | ソース実装済み。実機ビルド未検証(JDK/Gradle未導入環境のため) |

## クイックスタート(共有コア)

```bash
cd core
npm install
npm run fetch-mermaid   # mermaid.min.jsをローカル同梱(オフライン動作のため)
npm run build
node scripts/smoke-test.js
```

## クイックスタート(VSCode拡張、実際に動作確認可能)

```bash
cd vscode-extension
npm install
npm run package   # tree-sitter wasm取得 + 共有バンドル複製 + コンパイル
```

その後、リポジトリルートの `.vscode/launch.json` から「Run Flowchart Visualizer Extension」で
F5起動すると、Extension Development Hostが開く。C#/TS/JSファイルを開き、コマンドパレットまたは
右クリックメニューから `Flowchart: ファイル全体からフローチャートを生成` を実行する。

## おまけ: 魔方陣化(エンタメ用)

`core/render/magic-circle-emitter.ts`は同じ`FlowchartIR`を、姉妹リポジトリ
[`MagicCircleGenerator`](../MagicCircleGenerator)が読める魔方陣レシピ(JSON)に変換する
もう1つのエミッター。Mermaidフローチャートの代替ではなく、あくまでエンタメ用途。
マッピング仕様は [`core/render/MAGIC_CIRCLE_MAPPING_SPEC.md`](core/render/MAGIC_CIRCLE_MAPPING_SPEC.md)、
プロトタイプの検証手順は`MagicCircleGenerator/README.md`の該当節を参照。

```bash
cd core
node scripts/smoke-test-magic-circle.js   # レシピJSONをdist/output/へ生成
```

## 各ホストの詳細

- Visual Studio拡張のビルド手順・既知の制約・Roslyn `ControlFlowGraph` スパイク検証結果は
  [`vs-extension/README.md`](vs-extension/README.md) と [`vs-extension/SPIKE_RESULTS.md`](vs-extension/SPIKE_RESULTS.md)。
- Rider拡張のビルド手順・既知の制約(C#未対応の理由)は
  [`rider-plugin/README.md`](rider-plugin/README.md) と [`rider-plugin/RIDER_NOTES.md`](rider-plugin/RIDER_NOTES.md)。
