package com.flowchartvisualizer.rider

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefBrowser
import java.io.File

/**
 * Phase1の共有Webviewバンドル(core/webview-bundle/、ビルド時にplugin resourcesへ複製)を
 * JBCefBrowser(JCEFラッパー)にロードするツールウィンドウ。
 * バンドル自体には手を加えず、`executeJavaScript`で`window.postMessage`相当のスクリプトを
 * 注入してMermaidテキストを渡すだけ。
 */
class FlowchartToolWindowFactory : ToolWindowFactory {
    override fun createToolWindow(project: Project, toolWindow: ToolWindow) {
        val browser = JBCefBrowser()
        browsersByProject[project] = browser

        val bundleDir = File(javaClass.classLoader.getResource("webview-bundle")?.toURI()
            ?: throw IllegalStateException("webview-bundleが見つかりません(copyWebviewBundleタスクを実行してください)"))
        val indexHtml = File(bundleDir, "index.html")
        browser.loadURL(indexHtml.toURI().toString())

        val content = ContentFactory.getInstance().createContent(browser.component, "", false)
        toolWindow.contentManager.addContent(content)
    }

    companion object {
        private val browsersByProject = mutableMapOf<Project, JBCefBrowser>()

        fun render(project: Project, mermaidText: String) {
            val browser = browsersByProject[project] ?: return
            val escaped = mermaidText
                .replace("\\", "\\\\")
                .replace("`", "\\`")
                .replace("$", "\\$")
            val script = """
                window.postMessage({ type: "render", mermaidText: `$escaped` }, "*");
            """.trimIndent()
            browser.cefBrowser.executeJavaScript(script, browser.cefBrowser.url, 0)
        }
    }
}
