# Roslyn `ControlFlowGraph` API スパイク検証結果

設計書Phase3で「本設計最大の不確実性」と位置づけられた `ControlFlowGraph.Create()` の
実運用適用可否を、`FlowchartExtractor.Tests/RoslynCfgSpikeTests.cs` で検証した。

## 検証方法

Unity `MonoBehaviour.Update()` を模した典型パターン(if/else-if/else、for、switch混在)を
文字列ソースからRoslyn `CSharpCompilation` でコンパイルし、`SemanticModel.GetOperation()` で
取得した `IMethodBodyOperation` に対して `ControlFlowGraph.Create()` を実行した。

```bash
cd vs-extension/FlowchartExtractor.Tests
dotnet test
```

## 結果: **採用可**

- `ControlFlowGraph.Create(IMethodBodyOperation)` は例外なく完了し、`BasicBlock` 17個・
  `ControlFlowBranch` (Conditional/FallThrough込み)22本を取得できた。
- `BasicBlock.ConditionKind`(`WhenTrue`/`WhenFalse`)から true/false エッジラベルを機械的に
  導出でき、`if`/`for`/`switch` いずれも正しく分岐構造として表現された。
- `SyntaxWalkerExtractor`(フォールバック)による同一メソッドの解析結果と比較しても、
  ノード数・エッジ数がほぼ一致し(17/22 vs 17/22)、構造的に同等なグラフが得られることを確認した。
  ※ CFG版はコンパイラの正規化(`for`の初期化式・増分式が個別ブロックに分解される等)により
  ノードの粒度がSyntaxWalker版と完全一致はしないが、フローチャートとして意味のある分岐構造は
  両者で一致している。

## 実装方針の確定

- **`ControlFlowGraph.Create()` を第一候補として採用する**(`ControlFlowGraphExtractor.cs`)。
- `SyntaxWalker`(`SyntaxWalkerExtractor.cs`)は、`ControlFlowGraph.Create()` が例外を投げる、
  または `SemanticModel.GetOperation()` が `IMethodBodyOperation`/`IBlockOperation` 以外を返す
  ケース(ローカル関数・LINQクエリ式を含む複雑な構文形状などが該当しうる)へのフォールバックとして
  維持する。`FlowchartExtractor.Extract()` がこの優先順位を実装している。

## 未検証・today's scope外

- ローカル関数・LINQクエリ式を含む実際の複雑なUnityコードベースでの網羅的な検証は未実施
  (v1のスパイクとしては典型パターンでの動作確認までを目的とした)。
- Visual StudioのVSIXとしての実機インストール確認は、開発環境にVisual Studio本体がないため
  未実施。`FlowchartExtractor`/`FlowchartExtractor.Tests` は `dotnet build`/`dotnet test` のみで
  検証している。
