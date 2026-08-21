# Rider拡張 実装メモ(Phase4)

## PSIベース抽出の対応範囲について(重要な設計修正)

設計書は「IntelliJ PlatformのPSI(Program Structure Interface)から全JetBrains対応言語のASTを
直接取得できる」とし、C#への適用を主要ユースケースとして挙げていたが、実装にあたり以下の点を
確認した:

- **Java/Kotlin等、IntelliJ Platform本体がネイティブに解析する言語**は、`com.intellij.psi.*`
  (`PsiMethod`, `PsiIfStatement`, `PsiForStatement`等)を通じて型付きのASTに直接アクセスできる。
  `JavaPsiControlFlowExtractor.kt`はこの経路で実装・動作する(標準的なIntelliJ Platform SDKの
  使い方であり、Java向けとしては正しい)。
- **RiderのC#/VB.NETサポートは、IntelliJの汎用PSIではなく ReSharperバックエンド(別プロセスで
  動く.NETコンポーネント)が提供するモデル**であり、`PsiMethod`/`PsiIfStatement`のような型は
  C#コードに対しては存在しない。C#の構造をKotlin側から取得するには、Rider SDKが提供する
  `com.jetbrains.rider.*` のRD(Rider Protocol)ブリッジAPIで.NETバックエンドと通信する必要があり、
  これは素のIntelliJ Platform PSI APIとは別物である。

## 実装方針の修正

- v1では **Java(`PsiMethod`ベース)を実際に動作する対象言語として実装**した
  (`FlowchartAction.kt` → `JavaPsiControlFlowExtractor.kt`)。
- **C#対応は本Phaseのスコープから切り出し、別スパイクが必要な課題として記録する**。
  設計書のPhase3(Visual Studio/Roslyn)で確立した`ControlFlowGraph`ベースの抽出ロジックは
  RiderのC#解析には転用できない(Roslynではなく独自のReSharperエンジンが動いているため)。
  次のスパイクでは、Rider SDKの `com.jetbrains.rider.model` / RDプロトコル経由でReSharperの
  C# PSIモデル(`CSharpLanguage`関連のRdモデル)にアクセスする方法を検証する必要がある。
- Kotlinコード自体のPSI解析(`org.jetbrains.kotlin.psi.*`)は本v1では未実装
  (`JavaPsiControlFlowExtractor`はJavaの`PsiMethod`のみを対象とする)。追加するには
  Kotlin PSI依存(`kotlin-compiler`のプラグイン依存)が必要になる。

## この環境での検証状況

この開発環境にはJDK/Gradleがインストールされておらず、IntelliJ Platform Gradle Pluginによる
実ビルド(`./gradlew buildPlugin`)は未検証。`build.gradle.kts`/`plugin.xml`/Kotlinソースは
IntelliJ Platform SDK 2023.3+ / Rider 2023.3+ の標準的なAPI規約に沿って記述しているが、
実機(JDK 17 + Gradle + Rider SDK)でのコンパイル・起動確認は次のステップとして残っている。

検証手順(実機):
```bash
cd rider-plugin
# 事前に core/ で `npm install && npm run fetch-mermaid` を実行しておく
./gradlew buildPlugin   # ビルド
./gradlew runIde        # Riderのサンドボックスインスタンスを起動して動作確認
```
