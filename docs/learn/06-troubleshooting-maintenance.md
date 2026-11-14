# 6. トラブルと保守

## 症状から探す

| 症状 | 原因の候補 | 確かめ方・直し方 |
|---|---|---|
| **図の場所が真っ白** | `core/webview-bundle/mermaid.min.js` が無い | `cd core && npm install && npm run fetch-mermaid` |
| `npm run compile` が「mermaid.min.js がありません」 | 上と同じ(複製元が無い) | 同上 |
| tree-sitter が動かない・WASM が見つからない | `vscode-extension/wasm/` が空(`postinstall` が走っていない) | `cd vscode-extension && npm run fetch-wasm` |
| **コードを直したのに、古い Webview が出る** | `vscode-extension/webview-bundle/`(複製)が古い | `npm run compile`(毎回、消して作り直す)。**複製は直接編集しない** |
| 「この言語(…)は未対応です」 | 波括弧でブロックを書かない言語、または一覧に無い | `flowExtractor.ts` の言語の一覧 |
| 「構文エラーの可能性があり、フローを作れません」 | 括弧が対応していない(入力中・`/*` が閉じていない) | 書き終えてから、もう一度。範囲を選んで作る手もある |
| 図が空・関数が違う | 関数の特定(カーソルを含む最も内側の関数)。カーソルが関数の外なら、**ファイルの先頭の関数** | カーソルを関数の中へ |
| 差分で「変更された関数はありません」 | HEAD と同じフロー(行番号の違いだけでは変更にしない) | 仕様。ラベルか構造を変えると出る |
| 差分で、改名した関数が**全部「追加」** | HEAD に同じ名前の関数が無い | 仕様(改名の追跡はしない) |
| 差分で「Git リポジトリの中にありません」 | ファイルが Git の外・保存されていない | 保存する。`git` が PATH にあるか |
| 全体(CodeBoarding)が読めない | `.codeboarding/analysis.json` が無い・形が違う | 警告の帯を読む。壊れた項目は読み飛ばされる |
| 全体の関数が「開けない」 | ファイルが実在しない(`missing`)・**リポジトリの外を指すパス**・言語未対応 | 警告・`unsupportedReason` |
| Visual Studio / Rider で動かない | **実機で未確認**(下) | 各 README の手順 |

## 既知の問題・注意(読んで見つけたもの。コードは変えていない)

1. **IR の型・Mermaid 変換が、TypeScript・C#・Kotlin と `views.js` に写してある**。変えるとき、1 か所でも漏れると、ホストごとに図が食い違う(`views.js` と TypeScript の一致だけは、テストが見張る。C#・Kotlin の写しは、同じようには見張っていない)。
2. **2 つの読み取り(括弧の走査と構文木)は、別の実装**。通常の経路(シンボルが取れる言語)は括弧の走査で、構文木版は**シンボルが取れないときだけ**使われる。**同じ構造を返すことは、テストで見張っているが、通るコードの違いで、まれに結果が違いうる**。
3. **差分は、両側とも括弧の走査**(構文木版ではない)。関数は**名前と出現順**で対応づけるので、**改名は新規扱い**。**同名のオーバーロードの順序が入れ替わる**と、別の関数どうしが比べられる。
4. **括弧の走査の限界**: `break`・`continue` はループの外へ出る線を描かない。`try/catch` は本体の先頭から `catch` へ 1 本だけ。ラムダ・ローカル関数の中は図にしない。**検証済みは C# と TypeScript だけ**。
5. **switch の `case` の値は、線に出ない**(スキーマが `true`・`false`・空だけを許す)。
6. **`generatedAt` は、IR を作るたびに変わる**(時刻)。IR を丸ごと比べるテストは書けない(差分は、ラベルと種別で比べるので影響しない)。
7. **Visual Studio**: `dotnet build` までで、**本体での起動・`.vsix` の生成は未確認**。差分・全体階層は未対応。
8. **Rider**: **ビルド未確認**(JDK / Gradle が無い環境)。**C# は未対応**(ReSharper バックエンド経由のモデルで、Java 向けの PSI では扱えない)。差分・全体階層は未対応。
9. **`mermaid.min.js`・tree-sitter の WASM・`vscode-extension/webview-bundle/` は Git に入っていない**。新しい環境では、手順(`fetch-mermaid`・`npm install`・`compile`)を踏まないと動かない。
10. **未実装(意図的)**: カバレッジ連携(X5)・graphify(X3・スキーマ未確認)。TakayuStudio 系の追補は、設計書で「提案」で、対象外。

## 定期の保守

| いつ | 何を |
|---|---|
| 月に 1 回 | `npm audit`(`core/`・`vscode-extension/`)・依存の更新(`mermaid`・`web-tree-sitter`・`tree-sitter-wasms`・`typescript`) |
| `mermaid` を上げたとき | `core && npm run fetch-mermaid` → `npm test` → **`npm run test:webview`**(描画の互換を、実ブラウザで) |
| `engines.vscode` を上げたとき | `npm run test:integration` で、新しい VS Code の Extension Host で動くか |
| CodeBoarding の出力形式が変わったとき | `core/architecture/codeboarding-adapter.ts`。**実物の抜粋**をテストの入力に足す |
| IR・Mermaid・図形を変えたとき | 3 つの言語の写しと `views.js` を**同時に**。`dotnet test` も |
| 文書を触ったとき | `python tools/check_docs.py` |

## 直す前の確認

1. **IR の層に、ホスト固有の型を入れていないか**。
2. **意味づけを、2 つの読み取りのどちらかに書いていないか**(`FlowBuilder` へ)。
3. **誤検出しない**(行がずれただけで、変更にしない)ことを、守っているか。
4. **外部の入力のパス**(`analysis.json`)を、信用していないか。
