package com.flowchartvisualizer.rider

/**
 * FlowchartIr を core/flowchart-ir/schema.ts と同じ形のJSONにする(共有Webviewバンドルへ渡す形式)。
 * 依存を増やさない手書き実装(C# 側 vs-extension/FlowchartExtractor/IrJson.cs と同じ出力)。
 * 種別は schema.ts の NodeKind と同じ文字列("start" "ioOperation" 等)、空のラベルは出力しない。
 */
object IrJson {
    fun kindName(kind: NodeKind): String = when (kind) {
        NodeKind.START -> "start"
        NodeKind.END -> "end"
        NodeKind.PROCESS -> "process"
        NodeKind.DECISION -> "decision"
        NodeKind.LOOP -> "loop"
        NodeKind.IO_OPERATION -> "ioOperation"
    }

    fun serialize(ir: FlowchartIr): String {
        val sb = StringBuilder()
        sb.append("{\"nodes\":[")
        ir.nodes.forEachIndexed { i, n ->
            if (i > 0) sb.append(',')
            sb.append("{\"id\":").append(str(n.id))
                .append(",\"kind\":").append(str(kindName(n.kind)))
                .append(",\"label\":").append(str(n.label))
                .append(",\"sourceRange\":{\"startLine\":").append(n.sourceRange.startLine)
                .append(",\"endLine\":").append(n.sourceRange.endLine).append("}}")
        }
        sb.append("],\"edges\":[")
        ir.edges.forEachIndexed { i, e ->
            if (i > 0) sb.append(',')
            sb.append("{\"from\":").append(str(e.from)).append(",\"to\":").append(str(e.to))
            if (!e.label.isNullOrEmpty()) sb.append(",\"label\":").append(str(e.label))
            sb.append('}')
        }
        sb.append("],\"sourceFile\":").append(str(ir.sourceFile))
            .append(",\"generatedAt\":").append(str(ir.generatedAt)).append('}')
        return sb.toString()
    }

    /** JSON文字列リテラル(ホストがメッセージを組み立てるときにも使う)。 */
    fun str(s: String): String {
        val sb = StringBuilder(s.length + 2)
        sb.append('"')
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c < ' ') sb.append("\\u").append(String.format("%04x", c.code)) else sb.append(c)
            }
        }
        sb.append('"')
        return sb.toString()
    }
}
