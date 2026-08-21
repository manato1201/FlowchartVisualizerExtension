# rider-plugin (Rider拡張 / PSI)

## 構成

- `build.gradle.kts` / `settings.gradle.kts` / `gradle.properties` — IntelliJ Platform Gradle
  Plugin(2.x)を用いたビルド定義。Rider 2023.3+をターゲットにする。
- `src/main/kotlin/com/flowchartvisualizer/rider/`
  - `FlowchartIr.kt` / `MermaidEmitter.kt` — `core/`のホスト非依存スキーマ・変換ロジックのKotlin移植。
  - `JavaPsiControlFlowExtractor.kt` — Java PSI(`com.intellij.psi.*`)ベースの制御フロー抽出。
  - `FlowchartAction.kt` — エディタ右クリックからのエントリポイント。バックグラウンドスレッドで
    PSI解析する(`ApplicationManager.executeOnPooledThread` + `ReadAction` + `invokeLater`)。
  - `FlowchartToolWindowFactory.kt` — 共有Webviewバンドルを`JBCefBrowser`にロードするツールウィンドウ。
- `src/main/resources/META-INF/plugin.xml` — アクション・ツールウィンドウ・通知グループの登録。

## 既知の制約

**C#は現時点で未対応。** 詳細と今後の方針は [`RIDER_NOTES.md`](RIDER_NOTES.md) を参照。
要約: RiderのC#サポートはIntelliJ汎用PSIではなくReSharperバックエンド経由のモデルであり、
`PsiMethod`等のJava/Kotlin向けAPIでは扱えない。v1はJavaのPSI解析のみ実装し、C#対応は
別スパイクとして切り出した。

**この開発環境ではビルド未検証。** JDK/Gradleがインストールされていないため、
`./gradlew buildPlugin`は実行できていない。ソースはIntelliJ Platform SDK 2023.3+の標準APIに
沿って記述しているが、実機での型検証・起動確認が必要(手順は`RIDER_NOTES.md`参照)。

## ビルド前の準備

```bash
cd core
npm install
npm run fetch-mermaid   # webview-bundle/mermaid.min.js を生成
```

その後 `rider-plugin/` で `./gradlew buildPlugin`(Gradle Wrapperは未生成のため、
実機でJDK 17 + Gradleを用意して `gradle wrapper` を実行するか、ローカルのGradleで直接ビルドする)。
