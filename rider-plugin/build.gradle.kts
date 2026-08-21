import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.24"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        rider(providers.gradleProperty("riderSdkVersion").get())
        instrumentationTools()
    }
}

intellijPlatform {
    pluginConfiguration {
        name = providers.gradleProperty("pluginName")
        version = providers.gradleProperty("pluginVersion")
    }
}

tasks.withType<KotlinCompile> {
    kotlinOptions {
        jvmTarget = "17"
    }
}

tasks {
    // Phase1の共有Webviewバンドル(core/webview-bundle/)を無修正のままリソースへ複製する。
    // 目的: core/scripts/fetch-mermaid.js で mermaid.min.js を生成した後に実行すること。
    register<Copy>("copyWebviewBundle") {
        from("../core/webview-bundle")
        into("src/main/resources/webview-bundle")
    }
    named("processResources") {
        dependsOn("copyWebviewBundle")
    }
}
