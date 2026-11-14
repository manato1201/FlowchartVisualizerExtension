# 2. コードの読み方

## どこから読むか(おすすめの順)

| 順 | ファイル | 見るところ |
|---|---|---|
| 1 | `core/flowchart-ir/schema.ts` | IR の型(90 行)。**ホスト固有の型を参照しない**約束 |
| 2 | `core/render/mermaid-emitter.ts` | 図形の決めごと表(`SHAPE`)とエスケープ(56 行) |
| 3 | `core/flowchart-ir/flow-builder.ts` | `Flow`・`Seq`・`rollback`。**線の意味づけは、ここだけ** |
| 4 | `vscode-extension/src/codeMask.ts` → `functionSlicer.ts` | マスクと括弧・名前での切り出し(`vscode` に依存しない) |
| 5 | `vscode-extension/src/controlFlowScanner.ts` | 括弧の走査の再帰下降(`peek` → `parseSequence` → `parseControl`) |
| 6 | `vscode-extension/src/treeSitterWalker.ts` | 構文木版。**同じ `FlowBuilder`** を使う |
| 7 | `vscode-extension/src/flowExtractor.ts` | どの読み取りを使うかの分岐(3 段) |
| 8 | `vscode-extension/src/extension.ts` | コマンド・差分・全体階層・書き出し |
| 9 | `core/webview-bundle/views.js` → `bridge.js` | ビュー・メッセージ・描画 |
| 10 | `core/diff/ir-diff.ts`・`architecture/codeboarding-adapter.ts` | 差分・全体階層 |
| 11 | `vs-extension/FlowchartExtractor/`・`rider-plugin/src/` | 他の 2 ホストの抽出 |

## 1 回の生成の流れ(VS Code)

1. **コマンド**(`flowchart.generateFromFile`)→ `generateAtCursor` が、アクティブなエディタとカーソルを取る。
2. `generateAt`: 前の解析があれば**取り消す**(`CancellationTokenSource`)。「もう一度」用の関数 `lastGenerate` を保存。
3. `extractFlowchartIR`(`flowExtractor.ts`):
   1. **対応言語か**(波括弧の言語の一覧)。違えば `FlowchartUserError`(帯で知らせる)。
   2. `vscode.executeDocumentSymbolProvider` で**シンボルを取る**。
   3. シンボルがある → カーソルを含む**最も内側の関数**を選び、その範囲のテキストの括弧の対応を確かめて、**括弧の走査**で IR にする。
   4. シンボルが無い → tree-sitter が使える言語(C#・TypeScript・TSX・JavaScript)なら**構文木版**。失敗、または未同梱の言語なら、**括弧の走査**。
4. `publishIR`: Mermaid のテキスト(`lastMermaidText`)を覚え、パネルを作り(または出し)、`render {ir, meta}` を送る。
5. Webview が描く → `rendered` を返す(テスト用の合図)。

エラーは、`reportError` が**図の上の帯**に出す(図は消さない)。想定内のエラー(`FlowchartUserError`)はそのまま、想定外は「フローチャート生成に失敗しました: …」と前置きする。

## 流儀(このコードの約束)

- **IR の層は、ホスト固有の型を参照しない**(`vscode`・Roslyn・PSI)。
- **意味づけは `FlowBuilder` の 1 か所**。2 つの読み取りに、同じ規則を 2 回書かない。
- **構文を探すのはマスク、ラベルを取るのは元のテキスト**。
- **`vscode` に依存しないものは、依存しないままにする**(`codeMask`・`functionSlicer`・`controlFlowScanner`・`treeSitterWalker` は、Node 単体でテストできる)。
- **失敗は帯で、図は消さない**。想定内の失敗は、利用者に読める文面で。
- **コメントに「なぜ」と「過去の不具合」を書く**(例: 無限ループ・誤検出の経緯)。足すときも、同じ粒度で書く。
