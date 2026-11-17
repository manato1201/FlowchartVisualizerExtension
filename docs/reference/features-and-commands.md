# 機能・コマンド・設定(旧 README より移動)

> README を入口に絞るため、旧 README の内容をそのまま移した(見出しの階層だけ調整)。入口は [README](../../README.md)。

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
- **実装済み(2026-10-30)**: X16 番号つきの丸と凡例 / Y2 光点 / 空状態の ASCII モチーフ。
- **未実装(意図的)**: X5(カバレッジ連携)、X3 graphify・Z16(スキーマ未確認・参考のみ)。TakayuStudio 系の追補は設計書で「提案(未実装)」とされているため対象外。

VS Code のコマンド(コマンドパレット / エディタの右クリック「Flowchart」):

| コマンド | 内容 |
|---|---|
| `Flowchart: カーソル位置の関数からフローチャートを生成` | カーソルのある関数を図にする(関数の外ならファイルの先頭の関数) |
| `Flowchart: 選択範囲からフローチャートを生成` | 選択範囲を含む関数を図にする |
| `Flowchart: フローの JSON(IR)から図を描く` | コードの代わりに、フロー(ノード・線)の JSON を渡して描く。エディタの選択範囲(なければ全文)か、コマンドの引数(文字列 / オブジェクト)を読む。検証に通らなければ理由を帯で知らせる。仕様は [flowchart-ir.schema.json](flowchart-ir.schema.json) |
| `Flowchart: HEAD とのフロー差分を表示` | Git の HEAD と比べ、変更のあった関数だけを差分表示にする |
| `Flowchart: CodeBoarding の analysis.json を読み込む(全体)` | `.codeboarding/analysis.json` を読み、パンくずの「全体」から掘り下げる |
| `Flowchart: Mermaidテキストをコピー` / `SVGとしてエクスポート` / `PNGとしてエクスポート` | 表示中の図を書き出す |

設定: `flowchart.autoRefresh`(保存時に更新)、`flowchart.followCursor`(カーソルのある関数が変わったら図を切替。既定オフ)。

対応言語は、制御構文を波括弧で書く言語(C#・TypeScript・JavaScript・Java・Kotlin・Go・Rust など)。
**Python** は、波括弧のスキャナを通さず tree-sitter だけで読む(`def`・`if/elif/else`・`for`/`while`(`else` つき)・`try/except/else/finally`・`with`・`match`・`return`/`raise`・`break`/`continue`)。HEAD との差分は未対応。
Ruby のようにインデントでブロックを表す他の言語は、図を作らず帯で「未対応」と知らせる。
**検証してあるのは C#・TypeScript・Python のみ**で、他は同じ構文規則に沿う範囲での対応。

ノードが **300 個**を超える関数は、描く前に帯で知らせ、既定では簡易表示(「状態」ビュー = 分岐とループの要約)で描く。帯の「全体を描く」(または「フロー」タブ)で全体を描ける(IR は捨てない)。しきい値は `core/webview-bundle/views.js` の `RENDER_NODE_LIMIT` の 1 か所。


## おまけ: 魔方陣化(エンタメ用)

`core/render/magic-circle-emitter.ts`は同じ`FlowchartIR`を、姉妹リポジトリ
`MagicCircleGenerator`が読める魔方陣レシピ(JSON)に変換する
もう1つのエミッター。Mermaidフローチャートの代替ではなく、あくまでエンタメ用途。
マッピング仕様は [`core/render/MAGIC_CIRCLE_MAPPING_SPEC.md`](../../core/render/MAGIC_CIRCLE_MAPPING_SPEC.md)。

```bash
cd core
node scripts/smoke-test-magic-circle.js   # レシピJSONをdist/output/へ生成
```
