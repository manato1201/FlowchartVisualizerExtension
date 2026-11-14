# 5. テストの書き方と実行

## 実行

```bash
# 共有コア(IR・ビュー・差分・全体階層)
cd core
npm install && npm run fetch-mermaid
npm test                 # tsc + test-views(12)・test-diff(9)・test-architecture(9)
npm run test:webview     # 実ブラウザ(Chrome/Edge)。29 件。ブラウザが無ければスキップ

# VS Code 拡張
cd ../vscode-extension
npm install
npm test                 # compile + test-host-logic(8)・test-scanner(23)・smoke-test-scanner
npm run test:integration # 実際の VS Code(Extension Host)。VS Code が無ければスキップ

# C#(Visual Studio 側の抽出)
cd ../vs-extension/FlowchartExtractor.Tests
dotnet test              # 8 件

# 文書の検査(リポジトリのルートで)
python tools/check_docs.py
```

## どのテストが、何を確かめるか

| ファイル | 確かめるもの |
|---|---|
| `core/scripts/test-views.js` | ビューの繋ぎ直し・**フローの Mermaid が `emitMermaid` と一致**・1,000 ノード級でも 300 ms 未満・未知のビューは例外 |
| `core/scripts/test-diff.js` | LCS の差分・行がずれただけなら変更なし・分岐先の付け替えをエッジで検出・新規関数は全部追加・空の IR・**入力を壊さない** |
| `core/scripts/test-architecture.js` | **実物の `analysis.json`** の抜粋・入れ子・CLASS は出さない・欠落は警告・ルートが非オブジェクトなら例外・パスの正規化・**外を指すパスは通さない** |
| `core/scripts/test-webview.js` | 実ブラウザ: 描画・テーマ(`theme` メッセージ)・ズーム・**330 ノードでも操作が固まらない**(フレーム時間を測る) |
| `vscode-extension/scripts/test-scanner.js` | 走査の構造・**テキスト版と構文木版が同じ構造を返す**・到達不能・switch・try・閉じていない括弧 |
| `vscode-extension/scripts/test-host-logic.js` | `plainFunctionName`・`sliceFunctionByName`・`checkBraceBalance` など、`vscode` に依存しないホストの論理 |
| `vscode-extension/test/` | 実際の VS Code での結合(一時フォルダに Git リポジトリを作って、差分や全体階層を動かす) |
| `vs-extension/FlowchartExtractor.Tests/` | Roslyn `ControlFlowGraph` の採用可否(スパイク)・IR の JSON |
| `core/scripts/smoke-test*.js` | 魔方陣のレシピを書き出す・動作の確認(出力は `dist/output/`) |
| `tests/test_docs.py` | 文書の検査(下) |

## よく使う型

1. **構造で比べる**: ノードの種別の並びと、辺の数。**2 つの実装(走査と構文木)が同じ構造を返す**ことを守る。
2. **性質で守る**: 「行がずれただけなら変更なし」「入力を壊さない」「空でも落ちない」。
3. **速さを守る**: 大きな入力(1,000 ノード・330 ノード)で、時間の上限を決める。
4. **実物で確かめる**: 外部ツールの出力は、**実物の抜粋**をテストの入力にする。
5. **確かめていないことは、スキップとして見える形にする**(ブラウザ・VS Code が無ければスキップ)。

## 新しい構文のテストを書く手順

1. その構文を含む**小さなコード**を、テストの中に書く。
2. 期待する**ノード列**(種別・ラベル)と**エッジ**(`from>to:label`)を、先に書く。
3. 落ちることを確かめてから、実装を直す。
4. **走査と構文木の両方**で、同じ構造になることを確かめる。

```javascript
// 実行できる
const { irFromFunctionText } = require("./dist/vscode-extension/src/functionSlicer");

// テストの型: 小さなコード → 期待するノード列とエッジ
const ir = irFromFunctionText("void F()\n{\n  while (busy) { Wait(); }\n}", 0, "F()", "t.cs");
const nodes = ir.nodes.map((n) => `${n.kind}:${n.label}`);
const edges = ir.edges.map((e) => `${e.from}>${e.to}${e.label ? ":" + e.label : ""}`);

const expectNodes = ["start:F()", "loop:while (busy)", "process:Wait();", "end:End"];
console.log("ノード列が期待どおり:", JSON.stringify(nodes) === JSON.stringify(expectNodes));
console.log("ループへ戻る線がある:", edges.includes("n3>n2"));
console.log("false で End へ出る:", edges.includes("n2>n4:false"));
```

```text
# 出力
ノード列が期待どおり: true
ループへ戻る線がある: true
false で End へ出る: true
```

## 文書の検査

```bash
python tools/check_docs.py             # 検査(標準ライブラリだけ。node が要る)
python tools/check_docs.py --update    # 引用の更新・実行例の出力の作り直し
python tools/check_mermaid.py          # Mermaid が描画できるか(mmdc が要る)
python tools/make_diagrams.py          # 構成図(SVG)を作り直す
```

`# 実行できる` の例は、**`vscode-extension/` で `node -e`**(JavaScript)か、Python で動き、**2 回動かして出力が一致する**ことを確かめる。`dist/` を使うので、**先に `npm test`(ビルド)**を済ませておく。`tests/test_docs.py` が、同じ検査を pytest で行う(`dist/` が無いときは、例の実行をスキップする)。

## 確かめていないこと(正直に)

- **Visual Studio 本体での起動**: `dotnet build` で型の整合を確かめただけ。`.vsix` の生成は、VS 本体の MSBuild が要り、未確認。
- **Rider のビルド**: JDK / Gradle が無い環境で、`./gradlew buildPlugin` を実行していない。C# は未対応。
- **VS Code の結合テストと、実ブラウザのテスト**は、その環境(VS Code・Chrome / Edge)が必要。文書の検査では、回していない。
- **C# と TypeScript 以外の言語**は、同じ構文規則に沿う範囲での対応で、検証していない。
- **大きなファイル・巨大な関数**での、実際の IDE 上の体感は、測っていない(Webview の操作だけ、330 ノードで測っている)。
