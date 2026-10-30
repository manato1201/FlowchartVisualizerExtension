# FlowchartVisualizerExtension 改善書(2026-10 X調査反映)

作成日: 2026-10-07 / 対象: IDE拡張(VSCode / Visual Studio / Rider)でスクリプトの制御フローを可視化。共通の中間表現(FlowchartIR)+ Mermaid変換 + Webview
関連: [X_POSTS_BY_GENRE_2026-10.md](../X_POSTS_BY_GENRE_2026-10.md)、[FlowchartVisualizerExtension_DESIGN.md](FlowchartVisualizerExtension_DESIGN.md)

**前提**: 構造抽出はホスト固有、中間表現とレンダリングは共有する設計。「1つの中間データから複数の見せ方を出す」考えがすでにある。

## 改善項目一覧

| ID | ジャンル | 改善内容 | 出典 | 効果 | 工数 |
|---|---|---|---|---|---|
| X1 | G3 | 1つのIRから複数ビュー(フローチャート / 呼び出し関係 / 状態遷移 / データ関係)をメニューで切り替え | mayugelion | 見たい角度で読める。片方の修正が追従 | 中 |
| X2 | G3 | 上位階層に CodeBoarding の `analysis.json`(アーキテクチャ)を取り込み、ファイル → 関数 → フローと掘れるようにする | shiba_program | 全体 → 詳細のズームができる | 中 |
| X3 | G3 | PR用: 変更した関数のフローチャート差分を画像 / Mermaid で出す | CodeBoarding のPR連携 | レビューが速くなる | 中 |
| X4 | G5 | 図の追加・切替に小さな演出(ノードが順に現れる、タップ波紋) | yui540 | 見やすく楽しい | 小 |
| X5 | G3 | 実行パスのハイライト(テスト実行のカバレッジ連携) | 一般 | どこが通ったか分かる | 大 |

## Phase 1: X1
- FlowchartIR を `nodes` / `edges` / `kind` で拡張し、ビューごとに「どのkindを表示するか」を宣言的に切り替える。
- メニュー: 「フロー」「呼び出し」「状態」。同じIRから描くので、データの修正が全ビューに反映される。
- 既存のMermaid変換は、ビューごとの変換関数に分ける。

## Phase 2: X2
- CodeBoarding は Python / TypeScript / JavaScript / Java / Go / PHP / Rust / **C#** に対応(C++は非対応)。Unity の C# スクリプトの全体像を上位階層、本拡張を詳細階層、という分担にする。
- `analysis.json` の読み込みアダプタを `core/` に足す。コンポーネント → ファイルの対応表を作り、クリックで本拡張のフロー表示に移る。
- 注意: CodeBoarding はLLMを使うため、プロバイダの設定とコストが要る。ローカルモデル(Ollama)にも対応と記載がある。

## Phase 3: X3 / X4
- X3: Git の差分から変更関数を特定し、前後のIRを比較して、追加 / 削除 / 変更のノードを色分けする。
- X4: 演出は `prefers-reduced-motion` で止める。

## Final Phase
- 3つのIDEで同じ切替メニューが動くか、README の状態表を更新する。VS / Rider は実機が必要な部分が残る。

**検証チェックリスト:**
- [ ] 同じIRから3ビューを描いて、ノード数の整合が取れている
- [ ] `analysis.json` の読み込みで、存在しないファイルを指す項目が出てもエラーにならない
- [ ] PR差分で、変更のない関数が「変更あり」と誤表示されない
- [ ] 大きなスクリプト(1,000行超)で描画が固まらない

## 注意・未確認
- CodeBoarding の `analysis.json` のスキーマの細部は未確認。着手時に実物を1回出力して確認する。


---

## UI/デザイン改善(2026-10 追補)

参照: [UI_DESIGN_PRINCIPLES_2026-10.md](../UI_DESIGN_PRINCIPLES_2026-10.md)(原則 P1〜P10)/ 設計: [IMPROVEMENT_DESIGN_2026-10.md](IMPROVEMENT_DESIGN_2026-10.md)
追加の参考: 東京終電図・ONE ASIA ATLAS・文字画像APNGメーカー・中台の小さな家・re-presentation.jp と、デザインに関する2件の記事。
**方針**: 骨格(配色・書体・レイアウト)は維持し、「決めていないこと」を無くす方向で直す。装飾は足さない。

| ID | 原則 | 改善内容 | 工数 |
|---|---|---|---|
| U1 | P10 | Webviewを VS Code のテーマ変数に追従させる(ライト/ダークが自動で合う) | 小 |
| U2 | P3 | 上=ビュー切替(フロー/呼び出し/状態)、下=ズーム階層のパンくず(全体 → ファイル → 関数) | 中 |
| U3 | P1 | ノード・矢印の決めごと(分岐=ひし形、遷移=右向き、等)を1表に | 小 |


### UIパーツ・Motion 追補(2026-10-11)

詳細は [IMPROVEMENT_DESIGN_2026-10.md](IMPROVEMENT_DESIGN_2026-10.md) の同名の節。
- **パーツ**: セグメントコントロール(12)、パンくず(18)、ツールチップ(06)・ドロワー(02)
- **動き**: SVG ラインドロー(13)、スタッガー(03)


---

## 実装状況(2026-10-17)

| ID | 状態 | 実装場所 / メモ |
|---|---|---|
| X1 ビュー切替 | 実装済み | `core/webview-bundle/views.js`(ビューは kind の宣言で切替)。フロー/呼び出し/状態。呼び出しビューは「関数呼び出しらしい文 `name(` を含む処理」に絞る |
| X2 CodeBoarding | 実装済み(VS Code のみ) | `core/architecture/codeboarding-adapter.ts`。**実物の analysis.json でスキーマを確認済み**(後述) |
| X3 PRのフロー差分 | 実装済み(VS Code のみ) | `core/diff/ir-diff.ts` + `vscode-extension/src/gitDiff.ts`。画像 / Mermaid は Webview の書き出しから |
| X4 演出 | 実装済み | ノードの順次表示 + 実行順の再生(ライン描画)。`prefers-reduced-motion` で停止。使う動きは2種類のみ。タップ波紋は「動きは2種類まで」の守ることに反するため入れていない |
| X5 カバレッジ連携 | **未実装** | 工数「大」。テスト実行基盤との連携が要るため、今回は対象外 |
| U1 テーマ追従 | 実装済み | `style.css` の `--fv-*` トークン。VS / Rider は `theme` メッセージで色を送る |
| U2 ビュー切替・パンくず | 実装済み | セグメントコントロール / 全体 › ファイル › 関数 / ズーム / ミニマップ |
| U3 図形の決めごと | 実装済み | 開始/終了=角丸、処理=長方形、分岐=ひし形、繰り返し=六角形。TS・C#・Kotlin・`views.js` の4か所で同じ表(テストでバイト同一を確認) |
| X16 番号つき図 | 実装済み(2026-10-30) | `motion.js` の再生で、線の中ほどに番号つきの丸(1〜n)を置く。種別は形で分ける(true=円 / false=四角 / 通常=ひし形)。凡例は再生中だけ表示。書き出しには入れない。動きを減らす設定でも番号と形は出る |
| Y2 Motion path | 実装済み(2026-10-30) | 線が引かれるのに合わせ、光点が線に沿って進む。ライン描画と同じ動きの一部なので、動きは2種類のまま。動きを減らす設定では出ない |
| ASCII モチーフ(C. Drift) | 実装済み(2026-10-30) | `motif.js`。Webview の空状態だけに、川・分岐・三角州を出す。色は親の文字色のまま(新色なし)。装飾なので読み上げ対象外・選択不可。静止画(動きを減らす設定)・空状態でなくなったら停止 |
| X3 graphify / Z16 oh-my-mermaid | **対象外** | graph.json のスキーマが未確認で、Python CLI が前提。Z16 は参考のみ(設計書の記載どおり) |

**analysis.json のスキーマ(確認結果)**: CodeBoarding リポジトリが公開している `.codeboarding/analysis.json`
(2026-10-15 生成)を取得して確認した。トップレベルは `metadata` / `description` / `files` / `methods_index` /
`components` / `components_relations`。コンポーネントは `name`・`description`・`key_entities`(`qualified_name`・
`reference_file`・`reference_start_line`・`reference_end_line`)・`file_methods`(`file_path`・`methods[]`)・入れ子の
`components`。関数の行範囲は `methods_index["<file>|<qualified_name>"]`(`start_line`・`end_line`・`type`=FUNCTION/METHOD/CLASS)。
スキーマは CodeBoarding 側で変わりうるため、アダプタは寛容に読む(壊れた項目は警告にして読み飛ばす)。

**検証チェックリストの結果**:

| チェック | 結果 | 確認方法 |
|---|---|---|
| 同じIRから3ビューを描いて、ノード数の整合が取れている | OK | `core/scripts/test-views.js`(ノード数 = kind 条件に合うIRのノード数)と、実ブラウザで 14 / 8 / 7 ノードを描画 |
| analysis.json で存在しないファイルを指す項目でもエラーにならない | OK | `test-architecture.js` + 実VS Codeの結合テスト(存在しないファイルを含む analysis.json を読込) |
| PR差分で、変更のない関数が「変更あり」と誤表示されない | OK | `test-diff.js` / `test-host-logic.js`(行がずれただけ・ID採番が違うだけ・空白だけ・CRLF/LF の混在 → 変更なし) |
| 大きなスクリプト(1,000行超)で描画が固まらない | OK(330ノードで実測) | 1,000ノードのビュー変換+Mermaid生成は < 300ms。実ブラウザで 330 ノードの初回描画 約1.2秒、パン・ズームの操作は p95 約17ms(60fps) |
