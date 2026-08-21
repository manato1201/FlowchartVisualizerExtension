package com.flowchartvisualizer.rider

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.psi.PsiMethod
import com.intellij.psi.util.PsiTreeUtil

/**
 * エディタ右クリックメニューから「カーソル位置を含むメソッド」のPSIを取得し、
 * バックグラウンドスレッド(ReadAction)で解析してツールウィンドウへ描画する。
 * 非機能要件どおり、PSI解析はUIスレッドをブロックしない
 * (`ApplicationManager.executeOnPooledThread` + `invokeLater`)。
 */
class FlowchartAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val psiFile = e.getData(CommonDataKeys.PSI_FILE) ?: return
        val offset = e.getData(CommonDataKeys.EDITOR)?.caretModel?.offset ?: return

        ApplicationManager.getApplication().executeOnPooledThread {
            val mermaidText = ReadAction.compute<String?, Throwable> {
                val method = PsiTreeUtil.getParentOfType(psiFile.findElementAt(offset), PsiMethod::class.java)
                    ?: return@compute null
                val ir = JavaPsiControlFlowExtractor.extract(method, psiFile.virtualFile?.path ?: psiFile.name)
                MermaidEmitter.emit(ir)
            }

            ApplicationManager.getApplication().invokeLater {
                if (mermaidText == null) {
                    // 現時点でPSIベース解析が効くのはJava(PsiMethod)のみ。
                    // C#(Riderの場合はReSharperバックエンド経由)等の未対応言語では
                    // 通知のみ行い、例外で落とさない(rider-plugin/RIDER_NOTES.md参照)。
                    NotificationGroupManager.getInstance()
                        .getNotificationGroup("FlowchartVisualizer")
                        .createNotification(
                            "Flowchart Visualizer",
                            "カーソル位置を含むメソッドを解決できませんでした(現在PSIベース解析はJavaのみ対応)",
                            NotificationType.WARNING
                        )
                        .notify(project)
                    return@invokeLater
                }
                FlowchartToolWindowFactory.render(project, mermaidText)
            }
        }
    }
}
