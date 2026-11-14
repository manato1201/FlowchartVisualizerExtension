# 用語集

| 用語 | 意味 |
|---|---|
| **FlowchartIR** | ホストに依存しない中間表現。ノード・エッジ・元ファイル・生成時刻 |
| **ノード / エッジ** | 図の箱 / 線。ノードは種別・ラベル・元のコードの行範囲を持つ |
| **種別(NodeKind)** | `start`・`end`・`process`・`decision`(分岐)・`loop`(繰り返し)・`ioOperation` |
| **ラベル(true / false)** | 分岐から出る線の印。スキーマが許すのは `true`・`false`・空だけ |
| **ホスト** | この拡張が載る IDE(VS Code・Visual Studio・Rider) |
| **抽出器(extractor)** | コードを読んで IR にする部分。ホストごとに別の実装 |
| **DocumentSymbol** | VS Code の言語サーバーが返す、関数・クラスなどの名前と範囲の一覧 |
| **tree-sitter** | コードを構文木にする解析器。ここでは WebAssembly 版(`web-tree-sitter`)を使う |
| **構文木(AST / CST)** | コードの構造を木にしたもの |
| **括弧の走査(ヒューリスティックスキャナ)** | 波括弧とキーワード(`if`・`for` …)を読んで制御構造を推定する、自前の読み取り |
| **ヒューリスティック** | 厳密な解析ではなく、経験則で近似する方法。限界がある |
| **再帰下降** | 文法の規則ごとに関数を作り、入れ子を再帰で読む構文の読み方 |
| **マスク** | 文字列・コメントの中身を空白にしたテキスト(長さ・改行位置は同じ)。構文を探すときに使う |
| **FlowBuilder** | 文の部品(`Flow`)から、true / false の線・戻りの線・終端を引く共通部品 |
| **Flow** | 文を部品として見たもの。入口(`entryId`)・次へ繋ぐ口(`exits`)・終端(`terminals`) |
| **到達不能コード** | `return` などの後ろの、実行されない文。図に出さない(`rollback`) |
| **LCS** | 最長共通部分列。2 つの列の、順序を保って共通する最長の部分。差分の対応づけに使う |
| **差分(diff)** | 追加(`added`)・削除(`removed`)・変更(`changed`)・変更なし(`unchanged`)の印を付けた IR |
| **ビュー** | 同じ IR の見せ方。フロー・呼び出し・状態 |
| **Webview** | 拡張の中に埋め込まれたブラウザの部分。ここでは 3 ホスト共通のバンドル |
| **バンドル(webview-bundle)** | Webview の HTML・JS・CSS の一式(`core/webview-bundle/`) |
| **host-shim** | Webview → ホストの送信口 `flowchartHostPost` を、ホストごとに定義する薄いファイル |
| **Mermaid** | テキストから図を描く記法とライブラリ。出力は `flowchart TD` |
| **CodeBoarding** | リポジトリの構造(コンポーネント・ファイル・関数)を `analysis.json` に出す外部ツール |
| **Roslyn / ControlFlowGraph** | .NET のコンパイラ基盤 / その制御フローグラフの API(Visual Studio 側の抽出に使う) |
| **PSI** | IntelliJ 系の、コードの構造のモデル(Rider 側。Java 向けのみ対応) |
| **WebView2 / JCEF** | Visual Studio / Rider が、Webview を載せる仕組み |
| **Extension Host** | VS Code が拡張を動かすプロセス。結合テストは、これを使う |
| **魔方陣** | IR を、別リポジトリの魔方陣のレシピ(JSON)にするエンタメ用の出力 |
