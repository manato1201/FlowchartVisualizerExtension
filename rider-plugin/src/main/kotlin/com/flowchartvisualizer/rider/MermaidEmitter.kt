package com.flowchartvisualizer.rider

/**
 * core/render/mermaid-emitter.ts の移植。アルゴリズムはTS版と完全に同一に保つこと。
 * (3ホストが同じ合成コードから構造的に同じMermaid出力を得られることが検証基準のため)
 */
object MermaidEmitter {
    private val shape: Map<NodeKind, Pair<String, String>> = mapOf(
        NodeKind.START to ("([" to "])"),
        NodeKind.END to ("([" to "])"),
        NodeKind.PROCESS to ("[" to "]"),
        NodeKind.DECISION to ("{" to "}"),
        NodeKind.LOOP to ("[[" to "]]"),
        NodeKind.IO_OPERATION to ("[/" to "/]"),
    )

    fun emit(ir: FlowchartIr): String {
        val lines = mutableListOf("flowchart TD")

        for (n in ir.nodes) {
            val (open, close) = shape.getValue(n.kind)
            lines.add("  ${n.id}$open\"${escapeLabel(n.label)}\"$close")
        }

        for (e in ir.edges) {
            val arrow = if (e.label.isNullOrEmpty()) "-->" else "-->|${e.label}|"
            lines.add("  ${e.from} $arrow ${e.to}")
        }

        return lines.joinToString("\n")
    }

    private fun escapeLabel(label: String): String =
        label.replace("\"", "&quot;").replace("\n", "<br/>")
}
