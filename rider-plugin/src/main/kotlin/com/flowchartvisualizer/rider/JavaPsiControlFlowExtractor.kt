package com.flowchartvisualizer.rider

import com.intellij.psi.*

/**
 * IntelliJ Platformの標準Java PSI(`com.intellij.psi.*`)をウォークしてFlowchartIRを
 * 組み立てる。JavaはIntelliJ Platform本体が直接PsiMethod/PsiIfStatement等の型付き
 * PSIを提供するため、`PsiTreeUtil`ベースの構造ウォークが素直に機能する言語である。
 *
 * 注意(Phase4スパイクで判明した既知の制約): Riderの**C#**サポートはIntelliJの汎用PSIではなく
 * ReSharperバックエンド(.NETプロセス)経由のモデルで提供されており、`PsiMethod`/`PsiIfStatement`
 * 等の型はC#コードに対しては存在しない。C#対応には`com.jetbrains.rider.*`のRDプロトコル越しの
 * ブリッジAPIが別途必要であり、これは本Phaseのスコープ外として次のスパイク課題に切り出す
 * (詳細は rider-plugin/RIDER_NOTES.md を参照)。
 */
object JavaPsiControlFlowExtractor {

    fun extract(method: PsiMethod, sourceFile: String): FlowchartIr {
        val allocator = NodeIdAllocator()
        val nodes = mutableListOf<FlowchartNode>()
        val edges = mutableListOf<FlowchartEdge>()

        val startId = allocator.next()
        nodes.add(FlowchartNode(startId, NodeKind.START, (method.name) + "()", lineRangeOf(method)))
        val endId = allocator.next()
        nodes.add(FlowchartNode(endId, NodeKind.END, "End", lineRangeOf(method)))

        val body = method.body
        val result = if (body != null) {
            walkStatements(body.statements.toList(), allocator, nodes, edges)
        } else {
            WalkResult(null, mutableListOf())
        }

        if (result.entryId != null) {
            edges.add(FlowchartEdge(startId, result.entryId))
        } else {
            edges.add(FlowchartEdge(startId, endId))
        }
        for (exitId in result.exitIds) {
            edges.add(FlowchartEdge(exitId, endId))
        }

        return FlowchartIr(nodes, edges, sourceFile, java.time.Instant.now().toString())
    }

    private data class WalkResult(val entryId: String?, val exitIds: MutableList<String>)

    private fun walkStatements(
        statements: List<PsiStatement>,
        allocator: NodeIdAllocator,
        nodes: MutableList<FlowchartNode>,
        edges: MutableList<FlowchartEdge>,
    ): WalkResult {
        var entryId: String? = null
        var tailIds = mutableListOf<String>()

        fun connect(nodeId: String) {
            if (entryId == null) entryId = nodeId
            for (t in tailIds) edges.add(FlowchartEdge(t, nodeId))
            tailIds = mutableListOf(nodeId)
        }

        for (statement in statements) {
            when (statement) {
                is PsiIfStatement -> {
                    val chain = walkIfChain(statement, allocator, nodes, edges)
                    chain.entryId?.let { connect(it) }
                    tailIds = chain.exitIds
                }
                is PsiForStatement -> {
                    val loopId = allocator.next()
                    nodes.add(
                        FlowchartNode(
                            loopId, NodeKind.LOOP,
                            truncate("for (${statement.condition?.text ?: ""})"), lineRangeOf(statement)
                        )
                    )
                    connect(loopId)
                    wireLoopBody(statement.body, loopId, allocator, nodes, edges)
                    tailIds = mutableListOf(loopId)
                }
                is PsiForeachStatement -> {
                    val loopId = allocator.next()
                    nodes.add(
                        FlowchartNode(
                            loopId, NodeKind.LOOP,
                            truncate("for (${statement.iterationParameter.name} in ${statement.iteratedValue?.text ?: ""})"),
                            lineRangeOf(statement)
                        )
                    )
                    connect(loopId)
                    wireLoopBody(statement.body, loopId, allocator, nodes, edges)
                    tailIds = mutableListOf(loopId)
                }
                is PsiWhileStatement -> {
                    val loopId = allocator.next()
                    nodes.add(
                        FlowchartNode(
                            loopId, NodeKind.LOOP,
                            truncate("while (${statement.condition?.text ?: ""})"), lineRangeOf(statement)
                        )
                    )
                    connect(loopId)
                    wireLoopBody(statement.body, loopId, allocator, nodes, edges)
                    tailIds = mutableListOf(loopId)
                }
                is PsiDoWhileStatement -> {
                    val loopId = allocator.next()
                    nodes.add(
                        FlowchartNode(
                            loopId, NodeKind.LOOP,
                            truncate("do/while (${statement.condition?.text ?: ""})"), lineRangeOf(statement)
                        )
                    )
                    val bodyResult = walkStatement(statement.body, allocator, nodes, edges)
                    if (bodyResult.entryId != null) {
                        connect(bodyResult.entryId)
                        for (exitId in bodyResult.exitIds) edges.add(FlowchartEdge(exitId, loopId))
                    } else {
                        connect(loopId)
                    }
                    tailIds = mutableListOf(loopId)
                }
                is PsiSwitchStatement -> {
                    val switchId = allocator.next()
                    nodes.add(
                        FlowchartNode(
                            switchId, NodeKind.DECISION,
                            truncate("switch (${statement.expression?.text ?: ""})"), lineRangeOf(statement)
                        )
                    )
                    connect(switchId)

                    val body = statement.body
                    val caseExits = mutableListOf<String>()
                    if (body != null) {
                        val caseStatements = body.statements.toList()
                        val result = walkStatements(caseStatements, allocator, nodes, edges)
                        result.entryId?.let {
                            edges.add(FlowchartEdge(switchId, it))
                            caseExits.addAll(result.exitIds)
                        }
                    }
                    tailIds = if (caseExits.isNotEmpty()) caseExits else mutableListOf(switchId)
                }
                is PsiBlockStatement -> {
                    val inner = walkStatements(statement.codeBlock.statements.toList(), allocator, nodes, edges)
                    inner.entryId?.let { connect(it) }
                    if (inner.exitIds.isNotEmpty()) tailIds = inner.exitIds
                }
                else -> {
                    val text = statement.text.trim()
                    if (text.isNotEmpty()) {
                        val id = allocator.next()
                        nodes.add(FlowchartNode(id, NodeKind.PROCESS, truncate(text), lineRangeOf(statement)))
                        connect(id)
                    }
                }
            }
        }

        return WalkResult(entryId, tailIds)
    }

    private fun wireLoopBody(
        bodyStatement: PsiStatement?,
        loopId: String,
        allocator: NodeIdAllocator,
        nodes: MutableList<FlowchartNode>,
        edges: MutableList<FlowchartEdge>,
    ) {
        val bodyResult = walkStatement(bodyStatement, allocator, nodes, edges)
        val entry = bodyResult.entryId ?: return
        edges.add(FlowchartEdge(loopId, entry, "true"))
        for (exitId in bodyResult.exitIds) {
            edges.add(FlowchartEdge(exitId, loopId))
        }
    }

    private fun walkStatement(
        statement: PsiStatement?,
        allocator: NodeIdAllocator,
        nodes: MutableList<FlowchartNode>,
        edges: MutableList<FlowchartEdge>,
    ): WalkResult {
        if (statement == null) return WalkResult(null, mutableListOf())
        val statements = if (statement is PsiBlockStatement) {
            statement.codeBlock.statements.toList()
        } else {
            listOf(statement)
        }
        return walkStatements(statements, allocator, nodes, edges)
    }

    private fun walkIfChain(
        ifStatement: PsiIfStatement,
        allocator: NodeIdAllocator,
        nodes: MutableList<FlowchartNode>,
        edges: MutableList<FlowchartEdge>,
    ): WalkResult {
        val decisionId = allocator.next()
        nodes.add(
            FlowchartNode(
                decisionId, NodeKind.DECISION,
                truncate("if (${ifStatement.condition?.text ?: ""})"), lineRangeOf(ifStatement)
            )
        )

        val exitIds = mutableListOf<String>()

        val thenResult = walkStatement(ifStatement.thenBranch, allocator, nodes, edges)
        if (thenResult.entryId != null) {
            edges.add(FlowchartEdge(decisionId, thenResult.entryId, "true"))
            exitIds.addAll(thenResult.exitIds)
        } else {
            exitIds.add(decisionId)
        }

        val elseBranch = ifStatement.elseBranch
        if (elseBranch != null) {
            if (elseBranch is PsiIfStatement) {
                val nested = walkIfChain(elseBranch, allocator, nodes, edges)
                nested.entryId?.let { edges.add(FlowchartEdge(decisionId, it, "false")) }
                exitIds.addAll(nested.exitIds)
            } else {
                val elseResult = walkStatement(elseBranch, allocator, nodes, edges)
                if (elseResult.entryId != null) {
                    edges.add(FlowchartEdge(decisionId, elseResult.entryId, "false"))
                    exitIds.addAll(elseResult.exitIds)
                } else {
                    exitIds.add(decisionId)
                }
            }
        } else {
            exitIds.add(decisionId)
        }

        return WalkResult(decisionId, exitIds)
    }

    private fun lineRangeOf(element: PsiElement): SourceRange {
        val doc = element.containingFile?.viewProvider?.document
        val line = if (doc != null) doc.getLineNumber(element.textRange.startOffset) + 1 else 0
        return SourceRange(line, line)
    }

    private fun truncate(s: String, max: Int = 60): String {
        val oneLine = s.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        return if (oneLine.length > max) oneLine.substring(0, max - 1) + "…" else oneLine
    }
}
