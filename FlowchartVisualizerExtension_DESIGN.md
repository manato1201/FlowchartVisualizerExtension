# FlowchartVisualizerExtension 設計書

**設計指標: 3つの異なるIDE基盤に対し、構造抽出はホスト固有・中間表現とレンダリングは完全共有、という非対称な統合戦略でコスト対効果を最大化する**
作成日: 2026-08-18 / 想定規模: 中〜大規模(共有コア1式+ホストアダプタ3種)

---

## Phase 0: コンセプト・要件定義

### 目的

書いたスクリプト(C#/TypeScript/Kotlin等)の制御フローを、開発中に使っているIDE上でそのままフローチャートとして可視化する。Unity C#開発が主戦場のユーザーにとって、Visual Studio・Rider・VSCodeのいずれで作業していても同じ体験でフローチャートが得られることを目指す。エディタを離れて別ツールに貼り付ける手間、外部ドキュメントとの二重管理をなくす。

### 技術選定と理由(最重要)

**課題設定**: VSCode・Visual Studio・Riderは全く異なるプラグイン基盤を持つ。

| ホスト | 拡張言語 | パッケージ形式 | 言語解析基盤 |
|---|---|---|---|
| VSCode | TypeScript | VSCode Extension API (`.vsix`) | LSP経由の各言語サーバー |
| Visual Studio | C#/.NET | VSIX | Roslyn Workspace API |
| Rider | Kotlin | IntelliJ Platform Plugin | PSI (Program Structure Interface) |

この3つに対して単一の言語パーサーを自作して共有しようとするのは脆い設計になる。各ホストの言語サービスは対応言語・精度がバラバラであり、しかも各ホストは既に高精度な構文解析基盤を内部に持っている。ゼロから汎用パーサーを書くのは、この既存資産を捨てて車輪を再発明する行為に等しい。そこで以下の設計方針を採る。

**1. 構造抽出は各ホストのネイティブ言語インテリジェンスAPIを使う(パーサーを自作・共有しない)**

- **Visual Studio**: .NET言語(C#/VB)に対して**Roslyn Workspace API**から完全な構文木・意味解析情報を取得できる。ユーザー自身がUnity C#を多用しているため、3ホストの中で最も精度が要求される経路であり、Roslynの成熟度がそのまま活きる。
- **VSCode**: **Language Server Protocol経由の`DocumentSymbol`**(`vscode.executeDocumentSymbolProvider`)を第一選択とする。対応言語がLSP経由でシンボルを返さない場合のフォールバックとして`tree-sitter`(スタンドアロンCライブラリ、Node.jsバインディングあり)を使う。
- **Rider**: IntelliJ Platformの**PSI(Program Structure Interface)**から全JetBrains対応言語のASTを直接取得できる。

**2. 3ホストが正規化して出力する共通の中間表現(FlowchartIR)を1つ定義する**

各ホストのアダプタは「自分のネイティブAPIで取得した構造 → FlowchartIR」の変換だけを担当する。IR自体はホスト非依存のプレーンなデータ構造であり、どのIDE概念にも依存しない。

**3. FlowchartIRのシリアライズ形式にMermaidのflowchart構文を採用する(独自フォーマットは発明しない)**

理由: 既に広く使われている記法であり、GitHub/Notion/多くのMarkdownビューアがネイティブにレンダリングできる。ユーザーが生成結果をコピーしてドキュメントや他ツールにそのまま貼り付けられる汎用性がある。独自JSON形式を発明すると、それを表示できるのは自作Webviewだけになり可搬性を失う。

**4. 描画層を3ホストで完全共有できるという発見が本設計の核心**

- VSCode拡張は組み込みの`Webview API`(Chromium)を持つ。
- Visual Studio拡張は`WebView2`コントロール(Chromium、.NET拡張での組み込みが標準化済み)を埋め込める。
- Rider(IntelliJ Platform)は`JCEF`(JetBrains Chromium Embedded Framework)をツールウィンドウに埋め込める。

**つまり3ホスト全てがChromiumベースのWebviewを持っており、Mermaid.jsを描画する単一のHTML/JSバンドルを3ホストで一切変更せずに再利用できる。** ホストごとに書く必要があるのは「自分のネイティブAPIで構造を取り、FlowchartIRに変換し、共有HTMLバンドルに`postMessage`で渡す」というアダプタ部分のみである。この非対称性(抽出=個別、表現+描画=共有)が本設計のコスト対効果の源泉になる。

**不採用/延期とする案**:

- **「独自の全言語対応パーサーを1から書く」→ 不採用**: 対応言語を増やすたびに際限なくコストがかかる。C#・TypeScript・Kotlin・Java・Python等をすべて自前で構文解析することは、各ホストが既に持つ言語サービスの再発明になり、精度でも工数でも勝ち目がない。
- **「各ホストが個別の描画UIを持つ」(WPF/Swing/DOM)→ 不採用**: 当初はホストごとにネイティブUIでフローチャートを描画する案も検討したが、WPF(VS)/Swing(Rider)/DOM(VSCode)で3回同じ図を描画する実装を持つことになり、レイアウトアルゴリズムやスタイリングを3回保守する羽目になる。Chromium共有Webviewが3ホスト全てで利用可能と判明した時点でこの案は不要と判断した。

### 対象ユースケース

- 単一ファイルからのフローチャート生成が基本。
- エディタ上での選択範囲(1関数など)からの生成にも対応。
- **将来的な複数ファイル間の呼び出し関係の可視化は明示的にスコープ外**(v1では対象としない)。あくまで1ファイル/1関数内の制御フロー(if/for/while/switch等)を対象とする。

### 要求機能

- **生成トリガー**: コマンドパレット(VSCode)/右クリックメニュー(全ホスト)/保存時自動更新のトグル設定。
- **エクスポート**: SVG/PNG画像としての書き出し、およびMermaidテキストのクリップボードコピー。

### 非機能要件

- 大きなファイル(数千行)でも解析がホストのUIスレッドをブロックしない。**非同期/バックグラウンド解析が必須**(VSCodeは`async`関数、Visual Studioは`Task`ベース非同期、Riderは`ReadAction`のバックグラウンド実行を用いる)。
- 共有Webviewバンドルは外部ネットワークに依存しない(Mermaid.jsをローカル同梱し、オフライン環境でも動作する)。

### 前提・制約

- 本ツールは純粋にローカルで完結するIDE拡張機能である。サーバーコンポーネントは持たない。
- 各ホストの最小サポートバージョン(VSCode 1.85+、Visual Studio 2022+、Rider 2023.3+)を前提とする。

### アンチパターン(全フェーズ共通)

- ホスト固有のAPI(`vscode.*`、Roslynの`SyntaxNode`、IntelliJの`PsiElement`)をFlowchartIR層より上(共有コア・Webview側)に漏らさない。必ずアダプタ層で吸収し、変換した後のFlowchartIRだけを共有コアに渡す。
- 独自のIRシリアライズ形式を発明しない。IRの永続化・ホスト間受け渡しは必ずMermaid flowchart構文を経由する。
- ホストごとの描画UIを個別実装しない。描画は共有Webviewバンドル1本に統一する。
- v1のスコープ外(複数ファイル間の呼び出し関係可視化)に安易に手を広げない。

**検証チェックリスト:**
- [ ] 3ホストの構造抽出手段(Roslyn/DocumentSymbol+tree-sitter/PSI)がそれぞれ技術検証済みであること
- [ ] FlowchartIRのスキーマがホスト固有の型を一切参照していないこと
- [ ] 描画層がMermaid.js単体で、3ホストどのWebviewでも同一バンドルとして動作する設計になっていること
- [ ] スコープ外(複数ファイル間可視化)がv1要件から明確に除外されていること

---

## Phase 1: FlowchartIR + 共有レンダリングコア(最優先・3ホスト共通の土台)

3ホストのアダプタが実装を始める前に、まずこのIRとレンダリングコアを固める。ここが後戻りすると3ホスト全てに影響するため最優先。

### FlowchartIRスキーマ

`core/flowchart-ir/schema.ts`

```typescript
export type NodeKind = "start" | "end" | "process" | "decision" | "loop" | "ioOperation";

export interface FlowchartNode {
  id: string;                                  // 例: "n1"(アダプタ側で採番)
  kind: NodeKind;
  label: string;                                // 例: "if (isGrounded)"
  sourceRange: { startLine: number; endLine: number };
}

export interface FlowchartEdge {
  from: string;                                 // FlowchartNode.id
  to: string;                                    // FlowchartNode.id
  label?: "true" | "false" | "";
}

export interface FlowchartIR {
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
  sourceFile: string;                            // 相対パスまたはURI
  generatedAt: string;                           // ISO8601
}
```

### Mermaid変換と共有Webviewバンドル

`core/render/mermaid-emitter.ts` — FlowchartIRをMermaid `flowchart TD`構文へ直列化する。ノード種別を対応するMermaid図形記法(`([...])`=start/end、`[...]`=process、`{...}`=decision等)にマッピングし、エッジをtrue/falseラベル付きの矢印として出力する単純な変換関数。

```typescript
export function emitMermaid(ir: FlowchartIR): string {
  const shape: Record<NodeKind, [string, string]> = {
    start: ["([", "])"], end: ["([", "])"], process: ["[", "]"],
    decision: ["{", "}"], loop: ["[[", "]]"], ioOperation: ["[/", "/]"],
  };
  const lines = ["flowchart TD"];
  for (const n of ir.nodes) {
    const [o, c] = shape[n.kind];
    lines.push(`  ${n.id}${o}"${n.label.replace(/"/g, "&quot;")}"${c}`);
  }
  for (const e of ir.edges) {
    lines.push(`  ${e.from} ${e.label ? `-->|${e.label}|` : "-->"} ${e.to}`);
  }
  return lines.join("\n");
}
```

`core/webview-bundle/` — `index.html`(Mermaid.jsをローカル同梱、CDN不使用でオフライン動作)+ `bridge.js`(`postMessage`で`{type: "render", mermaidText}`を受信しMermaid.jsで描画するだけ)からなる、フレームワーク非依存の単一静的バンドル。3ホストのアダプタが埋め込むWebview/WebView2/JCEFに、このバンドルをファイルとしてそのまま配布する。

```javascript
// bridge.js
window.addEventListener("message", async (event) => {
  if (event.data.type !== "render") return;
  const { svg } = await mermaid.render("flowchart-svg", event.data.mermaidText);
  document.getElementById("chart").innerHTML = svg;
});
```

このバンドルはホスト固有APIを一切参照しないため、VSCode/VS/Riderのどのコンテナに置いても無修正で動く。ホスト側アダプタの責務は「FlowchartIRをMermaidテキストに変換し、このバンドルへ`postMessage`で渡す」ことだけになる。

**検証チェックリスト:**
- [ ] `FlowchartIR`型がホスト固有の型(vscode.*, Roslyn, PSI)を一切importしていないこと
- [ ] `emitMermaid`の出力がMermaid CLIやMermaid Live Editorでそのままレンダリング可能なこと
- [ ] 共有Webviewバンドルがオフライン(ネットワーク遮断状態)で動作すること
- [ ] バンドルがホスト固有のグローバルオブジェクト(`vscode`, `chrome.webview`等)を直接参照していないこと

---

## Phase 2: VSCode拡張(最初のホストアダプタ)

3ホストの中で最も開発サイクルが速い(ホットリロード、TypeScript)ため最初のアダプタとして選ぶ。

`vscode-extension/src/extension.ts` — コマンド`flowchart.generateFromSelection`/`flowchart.generateFromFile`をpackage.jsonのcontributesに登録し、それぞれ「アクティブエディタ(または選択範囲)からFlowchartIRを抽出→Mermaid変換→WebviewへpostMessage」を行う。

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand("flowchart.generateFromSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const ir = await extractFlowchartIR(editor.document, editor.selection);
    postFlowchart(openFlowchartPanel(context), emitMermaid(ir));
  })
  // flowchart.generateFromFile も同様(selectionを渡さない)
);
```

構造抽出(`vscode-extension/src/flowExtractor.ts`)は`vscode.executeDocumentSymbolProvider`によるシンボル取得を第一選択とし、制御フロー構造(if/for/while/switch文)はASTウォークで検出する。対応言語がLSP経由で拾えない場合は`web-tree-sitter`(ブラウザ/Node両対応のWASM版tree-sitter)にフォールバックする。

```typescript
export async function extractFlowchartIR(doc: vscode.TextDocument, sel?: vscode.Selection) {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    "vscode.executeDocumentSymbolProvider", doc.uri
  );
  return symbols?.length
    ? buildIRFromDocumentSymbols(doc, symbols, sel)
    : buildIRFromTreeSitter(doc, sel); // フォールバック
}
```

Webviewの埋め込みは`vscode-extension/src/webviewPanel.ts`が担当する。Phase1の共有バンドルを`vscode.window.createWebviewPanel`でロードし、`postMessage`でMermaidテキストを渡す。

```typescript
export function openFlowchartPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel("flowchartView", "Flowchart", vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "webview-bundle")] });
  panel.webview.html = buildHtmlWithWebviewUris(panel.webview, context.extensionUri);
  return panel;
}
```

`package.json`のcontributesには`commands`(上記2コマンド)と`menus.editor/context`(選択範囲がある時のみ`generateFromSelection`を表示)を登録する。

**検証チェックリスト:**
- [ ] `DocumentSymbol`が取得できる言語(TypeScript/JavaScript等)でif/for混在コードから正しいFlowchartIRが生成されること
- [ ] `DocumentSymbol`非対応言語で`web-tree-sitter`フォールバックが機能すること
- [ ] コマンドパレットと右クリックメニューの両方からトリガーできること
- [ ] Webviewが共有バンドルを無修正でロードし、Mermaidが描画されること

---

## Phase 3: Visual Studio拡張(Roslynネイティブ)(C#に対して最も精度が高い経路)

ユーザーのUnity C#開発と直結するため、実用上の優先度が最も高いホスト。

`vs-extension/FlowchartExtractor.cs`

Roslynの`SyntaxTree`/`SemanticModel`を使い、Roslynが標準で提供する制御フローグラフAPIである**`ControlFlowGraph.Create()`**から直接FlowchartIRへマッピングできる可能性を第一候補とする。本来はC#コンパイラの解析(到達不能コード検出等)用のAPIだが、拡張機能からも利用可能であり、これを使えれば自前でif/forを判定するウォーク処理を大幅に削減できる。

```csharp
public class FlowchartExtractor
{
    public FlowchartIR Extract(SyntaxTree tree, SemanticModel model, MethodDeclarationSyntax method)
    {
        ControlFlowGraph cfg = ControlFlowGraph.Create(method, model);
        // BasicBlock単位でFlowchartNodeへ、ConditionalSuccessor/FallThroughSuccessorを
        // FlowchartEdgeへマッピングする
        return MapCfgToIR(cfg, tree.FilePath);
    }
}
```

`ControlFlowGraph`が実運用で扱いにくいケース(LINQクエリ式やローカル関数を含む複雑な制御フロー等)に遭遇した場合のフォールバックとして、従来型の`SyntaxWalker`(`if`/`for`/`while`/`switch`ノードを直接ウォーク)を用意しておく。

Webview埋め込みは`vs-extension/FlowchartToolWindow.xaml`が担当する。WPFツールウィンドウ内に`Microsoft.Web.WebView2.Wpf.WebView2`コントロールを配置し、Phase1の共有バンドルをロードする。

```xml
<UserControl x:Class="FlowchartExtension.FlowchartToolWindow"
             xmlns:wv2="clr-namespace:Microsoft.Web.WebView2.Wpf;assembly=Microsoft.Web.WebView2.Wpf">
    <Grid><wv2:WebView2 x:Name="FlowchartWebView" Source="{Binding SharedBundleUri}" /></Grid>
</UserControl>
```

```csharp
public async Task LoadAndRenderAsync(string mermaidText)
{
    await FlowchartWebView.EnsureCoreWebView2Async();
    var json = JsonSerializer.Serialize(new { type = "render", mermaidText });
    await FlowchartWebView.CoreWebView2.ExecuteScriptAsync($"window.postMessage({json}, '*')");
}
```

VSIXパッケージング(`.vsixmanifest`)の骨子: `Identity`(Id/Version/Publisher)、`InstallationTarget`(Visual Studio 2022以降を指定)、`Assets`にツールウィンドウとコンテキストメニューコマンドを登録するVsPackageを列挙する。

**注記**: 最大の不確実性はVisual Studioの`ControlFlowGraph` APIが実際にどこまで使えるかという一点である(正式にAPI提供はされているが、拡張機能実装での利用例が少なく、実運用ケースでの網羅性が未検証)。Phase3の早い段階でこのAPIのスパイク検証(小さなサンプルC#メソッドで実際にCFGを取得しFlowchartIRへマッピングできるかの確認)を最優先で行うべきである。

**検証チェックリスト:**
- [ ] `ControlFlowGraph.Create()`がUnity C#の典型的なメソッド(MonoBehaviourのUpdate等)で動作すること(早期スパイク)
- [ ] `ControlFlowGraph`が使えないケースでの`SyntaxWalker`フォールバックが機能すること
- [ ] `WebView2`コントロールが共有バンドルをVSCode版と同一のHTMLファイルからロードできること
- [ ] VSIXがVisual Studio 2022にインストール・起動できること

---

## Phase 4: Rider拡張(PSIベース)

`rider-plugin/src/main/kotlin/FlowchartAction.kt`

IntelliJ Platform SDKの`PsiElement`ツリーウォークによる制御フロー構造抽出を行う。`PsiTreeUtil`等のユーティリティで対象メソッドのPSIサブツリーを走査し、if/for/while/switch相当のPSI要素を検出してFlowchartNode/Edgeへマッピングする。

```kotlin
class FlowchartAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val psiFile = e.getData(CommonDataKeys.PSI_FILE) ?: return
        val offset = e.getData(CommonDataKeys.EDITOR)?.caretModel?.offset ?: return
        val method = PsiTreeUtil.getParentOfType(psiFile.findElementAt(offset), PsiMethod::class.java) ?: return
        val mermaidText = MermaidEmitter.emit(FlowchartIrBuilder().build(method))
        FlowchartToolWindow.getInstance(e.project!!).render(mermaidText)
    }
}
```

Webview埋め込みは`rider-plugin/src/main/kotlin/FlowchartToolWindow.kt`が担当する。`JBCefBrowser`(JCEFラッパー)にPhase1の共有バンドルをロードし、`executeJavaScript`で`window.postMessage`相当のスクリプトを注入してMermaidテキストを渡す。`plugin.xml`では`toolWindow`(anchor="right")と`EditorPopupMenu`への`action`登録を行う。

Rider(.NETプロジェクト向けJetBrains IDE)は特にUnity C#開発との親和性が高いため、Visual Studioと同様C#への適用を主要ユースケースとして明記する。ただしPSIはKotlin/Java等JetBrains対応言語全般をカバーできる汎用性も併せ持つため、C#以外での利用を将来的に妨げない設計にする。

**検証チェックリスト:**
- [ ] `PsiTreeUtil`によるC#メソッドのif/for/switch検出がRider上で正しく動作すること
- [ ] `JBCefBrowser`が共有バンドルをVSCode/VS版と同一のHTMLファイルからロードできること
- [ ] エディタ右クリックメニューからアクションが起動できること
- [ ] Kotlin/JavaコードでもPSIベースの抽出が機能すること(汎用性の確認)

---

## Phase 5: 差分・リアルタイム更新(編集追従)

ファイル保存時、または一定のデバウンス後の自動再生成をトグル可能な設定として3ホスト共通で提供する。設定キーは3ホストで揃える。

```json
{ "flowchart.autoRefresh": { "type": "boolean", "default": false,
    "description": "ファイル保存時に自動でフローチャートを再生成する" } }
```

Phase0で挙げた非機能要件(大きなファイルでの非同期解析)をここで実装する。各ホストのバックグラウンドスレッド/Task APIで解析を実行し、UIスレッドをブロックしない。VSCodeは`async`関数+`CancellationTokenSource`(保存イベント連打時は前回解析をキャンセル)、Visual Studioは`Task.Run`で解析しUIスレッドへの復帰は`JoinableTaskFactory.SwitchToMainThreadAsync()`、Riderは`ApplicationManager.executeOnPooledThread`でPSI解析を行い`invokeLater`でUIスレッドへ戻す。代表としてVSCodeの実装例を示す。

```typescript
let pending: vscode.CancellationTokenSource | undefined;

vscode.workspace.onDidSaveTextDocument(async (doc) => {
  if (!config.get("flowchart.autoRefresh")) return;
  pending?.cancel();
  pending = new vscode.CancellationTokenSource();
  const ir = await extractFlowchartIR(doc, undefined, pending.token);
  if (!pending.token.isCancellationRequested) postFlowchart(currentPanel, emitMermaid(ir));
});
```

差分再生成(変更のあった関数のみ再解析)は将来最適化として明記するに留め、**v1は全体再解析でよい**とする(過剰最適化を避ける)。デバウンス(保存イベントの連続発火の抑制、目安500ms)のみv1でも実装し、体感の重さを緩和する。

**検証チェックリスト:**
- [ ] `flowchart.autoRefresh`設定が3ホスト全てで有効/無効を切り替えられること
- [ ] 1000行規模のファイル保存時にUIスレッドがブロックされないこと(体感遅延なし)
- [ ] 連続保存時にデバウンスが機能し、解析が多重発火しないこと
- [ ] v1では差分再解析を実装せず全体再解析のみであることがコード上明確であること

---

## Final Phase: 統合検証

- 3ホスト全てで同一のFlowchartIRサンプル(if/for混在の合成コード、例: `for`ループ内に`if/else`を含むメソッド)から、バイト同一ではないが構造的に同じMermaid出力が得られること。判定基準はノード数・エッジ数の一致とする(ラベルの厳密一致までは求めない)。
- 共有Webviewバンドル(`core/webview-bundle/`)が3ホストいずれの埋め込みコンテナ(VSCode Webview / WebView2 / JCEF)でも**ファイルを一切変更せず**表示されること。
- 1000行規模のファイルでも各ホストのUIスレッドがブロックされないこと(Phase5の非同期化の実証)。
- エクスポート機能(SVG/PNG/Mermaidテキストのコピー)が3ホスト全てで動作すること。
- Phase3で残した`ControlFlowGraph`スパイク検証の結果が、採用可否を含めて文書化されていること。

**検証チェックリスト:**
- [ ] 合成if/forコードでの3ホスト構造一致検証(ノード数・エッジ数)が完了していること
- [ ] 共有Webviewバンドルの無修正動作が3ホスト全てで確認されていること
- [ ] 1000行ファイルでの非同期化がVSCode/VS/Riderそれぞれで確認されていること
- [ ] SVG/PNG/Mermaidテキストのエクスポートが3ホスト全てで動作すること
- [ ] `ControlFlowGraph` APIのスパイク結果が記録され、Phase3の実装方針(採用/フォールバック)が確定していること

---

## 相互参照セクション

本ツールは純粋にローカルで完結するIDE拡張機能であり、ワークスペース内の他の設計書(サーバー/CIコンポーネントを持つもの)とは実行時の連携を持たない。ただし、FlowchartIRのシリアライズ形式にMermaid flowchart構文というポータブルな出力形式を採用したことで、将来的に別文書「AssetDataInsightSuite設計書」のようなドキュメント生成系ツールが本ツールの出力を消費する可能性はゼロではない。現時点では無理に統合を主張せず、緩い接続の余地として留めておく。

## 優先度注記

中〜大規模だが、各ホストが最も得意な形で構造抽出を担当させる設計により、車輪の再発明を避けている点で技術リスクは抑えられている。最大の不確実性はVisual Studioの`ControlFlowGraph` APIが実際にどこまで使えるか(正式サポートされているが利用例が少ない)という一点であり、Phase3の早い段階でこのAPIのスパイク検証を行うべきである。
