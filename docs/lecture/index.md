# FlowchartVisualizerExtension 講義(基礎から)

コードの制御構造を、フローチャートにする**考え方**を、順に学ぶ講義です。各回は、コードを**実際に動かして**確かめます(`tests/test_docs.py` が、ずれと出力を検査します)。

| 回 | 題 | 学ぶこと | 目安 |
|---|---|---|---|
| [0](00-introduction.md) | 全体の見取り図 | 3 つの IDE・**抽出はホスト固有、IR と描画は共有**する非対称な戦略 | 1 h |
| [1](01-ir.md) | 中間表現(FlowchartIR) | ノード・エッジ・検証・Mermaid への変換・図形の決めごと | 2 h |
| [2](02-masking.md) | ソースを読む下ごしらえ | 文字列・コメントを**マスク**する・括弧の対応・関数の切り出し | 2.5 h |
| [3](03-scanner.md) | 制御フローを組み立てる | 再帰下降・`FlowBuilder`・到達不能コードの除去・switch / try | 3 h |
| [4](04-diff.md) | フローの差分 | **LCS**・行番号を使わない比較・追加 / 削除 / 変更 | 2.5 h |
| [5](05-views.md) | ビューと Webview | 同じ IR から 3 つのビュー・ホストとのメッセージ | 2.5 h |
| [6](06-architecture.md) | 全体の階層 | CodeBoarding の `analysis.json`・寛容な読み方・**外を指すパスを通さない** | 2 h |
| [7](07-testing-capstone.md) | テストと総合演習 | どこまでを自動で確かめているか・演習 | 2.5 h |

例は、`vscode-extension/` で `node` が動かします(`tools/docs_node_cwd.txt`)。**先に、`core/` と `vscode-extension/` で一度 `npm install` と `npm test`(ビルド)を済ませてください**(`dist/` を使うため)。講義のあとは [学習資料](../learn/index.md)。
