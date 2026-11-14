# 3. 内側のしくみ

講義(第 1〜6 回)で扱った「IR の形」「マスク」「`FlowBuilder`」「LCS の差分」「ビューの繋ぎ直し」「全体階層の読み取り」は、繰り返しません。ここでは、**講義に出ない部分**を読みます。

## 3 段のフォールバック(`flowExtractor.ts`)

```typescript
// 抜粋ファイル: vscode-extension/src/flowExtractor.ts
if (!isFlowSupportedLanguage(doc.languageId)) {
if (symbols && symbols.length > 0) {
return buildIRFromDocumentSymbols(doc, symbols, selection);
return buildIRFromTreeSitter(extensionUri, doc, selection);
```

| 段 | 条件 | 何をするか |
|---|---|---|
| ① | 対応言語で、シンボルが取れた | シンボルの**範囲**で関数を決め、そのテキストを**括弧の走査**で読む |
| ② | シンボルが取れず、tree-sitter の文法がある言語 | ファイル**全体**を構文解析し、カーソルの関数を**構文木**から読む |
| ③ | ②が失敗、または文法が無い | 選択範囲(無ければファイル全体)を**括弧の走査**で読む |

- **対応言語**は、波括弧でブロックを書く言語(`csharp`・`typescript`・`javascript`・`java`・`kotlin`・`c`・`cpp`・`go`・`rust` など)。**言語 ID と拡張子**の 2 つの表がある。拡張子の表は、全体の階層(`analysis.json` のファイル)で、「フローを描けないファイル」(`unsupportedReason`: 言語未対応)を決めるのに使う。
- 括弧が**対応していない**テキストは、`checkBraceBalance` で見つけて、**図を作らずに理由を知らせる**(「入力中の場合は、書き終えてからもう一度」)。
- ②の構文木版は、**ファイル全体**を解析する(以前は選択範囲だけを切り出していて、範囲が関数の途中だと木が崩れた)。
- **`FlowchartUserError`**: 想定内の失敗。メッセージをそのまま利用者に見せてよい。それ以外の例外は、前置きつきで帯に出す。

## 関数の特定

- ①: `findTargetSymbol` が、カーソルを**含む**関数・メソッド・コンストラクタのうち、**範囲が最も小さいもの**(最も内側)を選ぶ。無ければ、**最初の関数**。
- ②: `findTargetFunction` が、カーソル位置から**親をたどって**、最初の関数ノードを取る。無ければ、ソース順で最初の関数。**関数が 1 つも無ければ、トップレベルの文(スクリプト)**を対象にする。

## 差分の実行(`diffAgainstHead`)

1. `getHeadText`: `git rev-parse --show-toplevel` → `git show HEAD:<相対パス>`。結果は `ok`・`untracked`(HEAD に無い新規ファイル)・`error`(git が無い・リポジトリの外・保存されていないファイル)の 3 種。**CRLF は LF にそろえる**。
2. **言語サーバーの関数の一覧**(`getCallableSymbols`)を、出現順に回る。
3. 関数ごとに、**同じ名前の定義を HEAD の全文から切り出す**(`sliceFunctionByName`)。**同名のオーバーロードは、出現順 `nth` で対応づける**。
4. 切り出せれば `diffIR`、切り出せなければ(HEAD に無い)`allAdded`。**変更のある関数だけ**を集める。
5. 変更のある関数が複数なら、**QuickPick で選ばせる**。図の上の帯に、件数と色の意味を出す。

注意:

- **括弧が対応していない関数は、比較から外す**(「比較できなかった関数」として帯に出す)。
- **両方の側で、括弧の走査**を使う(構文木版ではない)。
- 関数を**改名**すると、HEAD に同じ名前が無いので、**新規(すべて追加)**扱いになる。

## パネル(`webviewPanel.ts`)

- パネルは**1 つだけ**(`currentPanel`)。あれば出す、無ければ作る。`retainContextWhenHidden: true`(隠しても状態を保つ)。
- **読み込みが済むまで、メッセージをためる**(`panelReady`・`pendingMessages`)。Webview が `ready` を返したら送る。
- `localResourceRoots` を、**バンドルと media だけ**に絞る。バンドルは、拡張ルートの複製(`webview-bundle/`)を優先し、無ければ `core/` を見る。
- `requestFromWebview`: Webview へ要求を送り、結果のメッセージを**タイムアウトつき**(既定 8 秒)で待つ。書き出し・Mermaid のコピーが使う。

## 書き出し

| 操作 | しくみ |
|---|---|
| Mermaid をコピー | Webview に `getMermaid` を送り、**表示中のビュー**のテキストを優先。パネルが無ければ、直近のフロー(`lastMermaidText`) |
| SVG | Webview に `exportSvg` を送る → `exportSvgResult`(SVG の文字列)→ 保存ダイアログ |
| PNG | `exportPng` → `exportPngResult`(`data:image/png;base64,…`)→ デコードして保存 |
| 魔方陣 | `core/render/magic-circle-emitter.ts` が、IR を**レシピ JSON** にする(別リポジトリが読む。**決定論的**で、ラベルは描画しない) |

## 自動更新とカーソル追従

- **保存時**(`autoRefresh`): パネルが開いていて、保存したのが**表示中のファイル**のときだけ。500 ms のデバウンス。
- **カーソル追従**(`followCursor`): 既定オフ。選択が変わるたび 400 ms のデバウンスで解析し、**同じ関数・同じ版**(`keyOf`)なら何もしない(ジャンプの直後の再描画も防ぐ)。**差分を表示中は追従しない**。
- 解析は**常に最新の 1 つだけ**(`pendingAnalysis` を取り消す)。

## 魔方陣(エンタメ)の約束

- **既存の `Ring` スキーマを変えない**(出力型は、別リポジトリの型のミラー)。
- **決定論的**: 同じ構造の IR から、同じ配色・配置。乱数のシードは、IR の構造から導く(タイムスタンプは使わない)。
- **ラベルは描かない**(`<title>` に残すだけ)。
- 仕様の正本は `core/render/MAGIC_CIRCLE_MAPPING_SPEC.md`。
