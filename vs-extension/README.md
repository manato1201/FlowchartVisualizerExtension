# vs-extension (Visual Studio拡張 / Roslyn)

## 構成

- `FlowchartExtractor/` — 抽出ロジック本体(ホスト非依存のIR + Roslyn CFG抽出器 + SyntaxWalkerフォールバック)。
  `net8.0;net472` のマルチターゲット。`dotnet build`/`dotnet test` のみで完結して検証できる。
- `FlowchartExtractor.Tests/` — xUnitテスト。`ControlFlowGraph.Create()`のスパイク検証を含む
  (結果は [`../SPIKE_RESULTS.md`](../SPIKE_RESULTS.md) 参照)。
- `FlowchartVisualizerVsix/` — 実際のVSPackage(ToolWindow + WebView2 + コマンド登録)。
  `net472`ターゲット(Visual Studio自体が.NET Frameworkプロセスのため)。

## ビルド・検証手順

```bash
# 1. 抽出ロジックのビルドとスパイク検証テスト
cd vs-extension/FlowchartExtractor.Tests
dotnet test

# 2. VSPackage本体のコンパイル確認(実機VSなしでも型検証は可能)
cd ../FlowchartVisualizerVsix
dotnet build
```

## 既知の制約(この開発環境固有)

この環境にはVisual Studio本体(devenv.exe)・VSSDKの完全なツールチェインがインストールされて
いない(`dotnet`/.NET SDKのみ)。そのため:

- `FlowchartVisualizerVsix` は **C#コードとして `dotnet build` で0エラーコンパイルを確認済み**
  (Microsoft.VisualStudio.SDK / WebView2 / Roslyn Workspaces の実パッケージに対して型検証済み)。
- 一方、`.vsix`コンテナの生成(`CreateVsixContainer`ターゲット)は、VSSDK.BuildToolsが前提とする
  Visual Studio本体のMSBuildツールセットに依存しており、`dotnet build`(クロスプラットフォーム版
  MSBuild)だけでは`.vsix`ファイルの生成まで到達しない。
- したがって設計書Final Phaseの検証項目「VSIXがVisual Studio 2022にインストール・起動できること」
  は、**実際にVisual Studio 2022(+ Visual Studio extension development workload)がインストール
  された環境でのみ検証可能**であり、この開発環境では未検証。実機での次の手順を想定している:
  1. Visual Studio 2022で `FlowchartVisualizerVsix.csproj` を開く(または`dotnet build`と同じ
     コマンドをVS Developer Command Promptで実行)。
  2. F5でExperimental Instanceを起動し、C#ファイルを開いてコンテキストメニューから
     `Flowchart: 選択メソッドを可視化` を実行する。
  3. ツールウィンドウにMermaidフローチャートが描画されることを確認する。

## Roslyn `ControlFlowGraph` スパイク結果

[`../SPIKE_RESULTS.md`](../SPIKE_RESULTS.md) を参照。結論: **採用可**。
`ControlFlowGraphExtractor`を第一候補、`SyntaxWalkerExtractor`をフォールバックとして
`FlowchartExtractor.Extract()`が優先順位を実装している。
