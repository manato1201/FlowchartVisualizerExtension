package com.flowchartvisualizer.rider

import com.google.gson.JsonParser
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.JBColor
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.ui.UIUtil
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import java.awt.Color
import java.awt.datatransfer.StringSelection
import java.io.File
import java.util.Base64

/**
 * Phase1の共有Webviewバンドル(core/webview-bundle/、ビルド時にplugin resourcesへ複製)を
 * JBCefBrowser(JCEFラッパー)にロードするツールウィンドウ。
 *
 * バンドル自体には手を加えない。ホスト固有の部分はこのクラスに閉じる:
 *   - WebView → ホストの送信口 `window.flowchartHostPost` を JBCefJSQuery に繋ぐ
 *   - FlowchartIr をそのまま渡し、ビュー切替・ジャンプ・差分はバンドル側に任せる
 *   - IDE のテーマ色を `--vscode-*` 相当の値としてメッセージで送る(JCEF はこれらのCSS変数を持たない)
 *
 * 注意: この環境には JDK / Gradle が無く、ビルド・実機での動作は未検証(rider-plugin/RIDER_NOTES.md)。
 */
class FlowchartToolWindowFactory : ToolWindowFactory {
    override fun createToolWindow(project: Project, toolWindow: ToolWindow) {
        val browser = JBCefBrowser()
        val state = PanelState(project, browser)
        panels[project] = state

        // 送信口(WebView → ホスト)。ページの読み込みが終わるたびに定義し直す。
        val query = JBCefJSQuery.create(browser as JBCefBrowserBase)
        query.addHandler { message ->
            state.onMessage(message)
            null
        }
        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadEnd(cefBrowser: CefBrowser?, frame: CefFrame?, httpStatusCode: Int) {
                cefBrowser?.executeJavaScript(
                    "window.flowchartHostPost = function (m) { ${query.inject("JSON.stringify(m)")} };",
                    cefBrowser.url,
                    0,
                )
            }
        }, browser.cefBrowser)

        val bundleDir = File(
            javaClass.classLoader.getResource("webview-bundle")?.toURI()
                ?: throw IllegalStateException("webview-bundleが見つかりません(copyWebviewBundleタスクを実行してください)")
        )
        browser.loadURL(File(bundleDir, "index.html").toURI().toString())

        val content = ContentFactory.getInstance().createContent(browser.component, "", false)
        toolWindow.contentManager.addContent(content)
    }

    /** プロジェクトごとの表示状態。バンドルの読み込み(3MBのMermaid含む)が終わるまでメッセージを溜める。 */
    private class PanelState(val project: Project, val browser: JBCefBrowser) {
        @Volatile var ready = false
        @Volatile var pendingJson: String? = null
        @Volatile var sourcePath: String? = null

        fun post(json: String) {
            if (!ready) {
                pendingJson = json
                return
            }
            // 注: window.postMessage に渡すのはJSONそのもの(JSONはJSの式としてそのまま有効)
            browser.cefBrowser.executeJavaScript("window.postMessage($json, '*');", browser.cefBrowser.url, 0)
        }

        fun onMessage(raw: String) {
            val obj = try {
                JsonParser.parseString(raw).asJsonObject
            } catch (e: Exception) {
                return // 想定外のメッセージは無視する(図の表示を止めない)
            }
            when (obj.get("type")?.asString) {
                "ready" -> {
                    ready = true
                    post(themeMessage())
                    pendingJson?.let {
                        pendingJson = null
                        post(it)
                    }
                }
                "jump" -> {
                    val path = sourcePath ?: return
                    val line = obj.get("line")?.asInt ?: return
                    val vFile = LocalFileSystem.getInstance().findFileByPath(path) ?: return
                    com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                        OpenFileDescriptor(project, vFile, maxOf(0, line - 1), 0).navigate(true)
                    }
                }
                "copyText" -> {
                    val text = obj.get("text")?.asString ?: return
                    CopyPasteManager.getInstance().setContents(StringSelection(text))
                }
                "saveImage" -> {
                    val format = obj.get("format")?.asString ?: return
                    val data = obj.get("data")?.asString ?: return
                    com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                        saveImage(format, data)
                    }
                }
            }
        }

        private fun saveImage(format: String, data: String) {
            if (format != "svg" && format != "png") return
            val dialog = FileChooserFactory.getInstance()
                .createSaveFileDialog(FileSaverDescriptor("画像で保存", "フローチャートを保存します", format), project)
            val wrapper = dialog.save(null as com.intellij.openapi.vfs.VirtualFile?, "flowchart.$format") ?: return
            val bytes = if (format == "svg") data.toByteArray(Charsets.UTF_8)
            else Base64.getDecoder().decode(data.substring(data.indexOf(',') + 1))
            wrapper.file.writeBytes(bytes)
        }

        /** IDEのテーマ色を、バンドルが読む --vscode-* 相当の名前で送る(U1)。 */
        fun themeMessage(): String {
            fun hex(c: Color) = String.format("#%02x%02x%02x", c.red, c.green, c.blue)
            val bg = UIUtil.getPanelBackground()
            val fg = UIUtil.getLabelForeground()
            val border = JBColor.border()
            val gray = UIUtil.getInactiveTextColor()
            val dark = (0.299 * bg.red + 0.587 * bg.green + 0.114 * bg.blue) < 128
            val widget = if (dark) bg.brighter() else bg.darker()
            val vars = linkedMapOf(
                "vscode-editor-background" to hex(bg),
                "vscode-editor-foreground" to hex(fg),
                "vscode-descriptionForeground" to hex(gray),
                "vscode-panel-border" to hex(border),
                "vscode-editorWidget-background" to hex(widget),
                "vscode-editorWidget-border" to hex(border),
                "vscode-button-secondaryBackground" to hex(widget),
                "vscode-button-secondaryForeground" to hex(fg),
            )
            val body = vars.entries.joinToString(",") { "${IrJson.str(it.key)}:${IrJson.str(it.value)}" }
            return "{\"type\":\"theme\",\"kind\":\"${if (dark) "dark" else "light"}\",\"variables\":{$body}}"
        }
    }

    companion object {
        private val panels = mutableMapOf<Project, PanelState>()

        /** 図を描く。IR をそのまま渡し、ビュー切替・ジャンプ・差分はバンドル側が行う。 */
        fun renderIr(project: Project, ir: FlowchartIr, functionName: String?, sourcePath: String?) {
            val state = panels[project] ?: return
            state.sourcePath = sourcePath
            val meta = "{\"file\":${IrJson.str(File(ir.sourceFile).name)}," +
                "\"functionName\":${functionName?.let { IrJson.str(it) } ?: "null"}," +
                "\"canJump\":${sourcePath != null}}"
            state.post("{\"type\":\"render\",\"ir\":${IrJson.serialize(ir)},\"meta\":$meta}")
        }
    }
}
