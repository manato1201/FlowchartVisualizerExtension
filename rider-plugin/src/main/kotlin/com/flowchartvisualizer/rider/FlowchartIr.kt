package com.flowchartvisualizer.rider

// core/flowchart-ir/schema.ts のKotlin側ミラー。
// アンチパターン注記の通り、IntelliJの型(PsiElement等)はこの層より上
// (Mermaid変換・Webview側)へ一切漏らさない。

enum class NodeKind {
    START, END, PROCESS, DECISION, LOOP, IO_OPERATION,
}

data class SourceRange(val startLine: Int, val endLine: Int)

data class FlowchartNode(
    val id: String,
    val kind: NodeKind,
    val label: String,
    val sourceRange: SourceRange,
)

data class FlowchartEdge(
    val from: String,
    val to: String,
    val label: String? = null,
)

data class FlowchartIr(
    val nodes: List<FlowchartNode>,
    val edges: List<FlowchartEdge>,
    val sourceFile: String,
    val generatedAt: String,
)

/** FlowchartIRビルダー用の採番ヘルパー。schema.tsのNodeIdAllocatorに対応する。 */
class NodeIdAllocator {
    private var counter = 0
    fun next(): String {
        counter += 1
        return "n$counter"
    }
}
