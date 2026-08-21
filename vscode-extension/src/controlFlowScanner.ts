import { FlowchartEdge, FlowchartNode, NodeIdAllocator } from "../../core/flowchart-ir/schema";

/**
 * DocumentSymbolはシンボルの外形(名前・範囲)しか提供しないため、if/for/while/switch
 * といった文レベルの構造はVSCode APIから直接取得できない。このモジュールは対象範囲の
 * テキストを走査し、制御構文キーワードと対応する波括弧ブロックをヒューリスティックに
 * 検出してFlowchartNode/Edgeを組み立てる。
 *
 * 制約: 文字列リテラル・コメント内の "{"/"}" は簡易的にスキップするが、
 * 複雑な式(ラムダ内の波括弧等)まで厳密には解釈しない。v1として十分な精度を狙う。
 */

interface BlockResult {
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
  /** ブロックへの入口ノードID(空ブロックの場合はundefined) */
  entryId?: string;
  /** ブロックを抜けた後、後続に接続すべき「宙ぶらりん」の終端ノードID群 */
  exitIds: string[];
}

const CONTROL_KEYWORD_RE = /^(if|for|foreach|while|do|switch)\b/;
const ELSE_RE = /^else\b/;

/**
 * 対象範囲のテキストからFlowchartNode/Edgeを組み立てる。
 * @param text 対象範囲のソーステキスト(関数本体を含む)
 * @param startLine textの1行目に対応する元ファイル上の行番号(0-based)
 * @param functionLabel start/endノードに表示する関数名相当のラベル
 */
export function scanControlFlowHeuristic(
  text: string,
  startLine: number,
  functionLabel: string
): { nodes: FlowchartNode[]; edges: FlowchartEdge[] } {
  const allocator = new NodeIdAllocator();
  const nodes: FlowchartNode[] = [];
  const edges: FlowchartEdge[] = [];

  const startId = allocator.next();
  nodes.push({
    id: startId,
    kind: "start",
    label: functionLabel,
    sourceRange: { startLine: startLine + 1, endLine: startLine + 1 },
  });

  const body = extractOuterBlockBody(text) ?? text;
  const bodyStartLine = startLine + countNewlinesBefore(text, body);

  const block = parseBlock(body, bodyStartLine, allocator);
  nodes.push(...block.nodes);
  edges.push(...block.edges);

  const endId = allocator.next();
  const endLine = startLine + text.split("\n").length - 1;
  nodes.push({
    id: endId,
    kind: "end",
    label: "End",
    sourceRange: { startLine: endLine + 1, endLine: endLine + 1 },
  });

  if (block.entryId) {
    edges.push({ from: startId, to: block.entryId });
  } else {
    edges.push({ from: startId, to: endId });
  }
  for (const exitId of block.exitIds) {
    edges.push({ from: exitId, to: endId });
  }

  return { nodes, edges };
}

/** メソッド宣言行を除いた `{ ... }` の中身だけを取り出す(見つからなければnull)。 */
function extractOuterBlockBody(text: string): string | null {
  const openIdx = text.indexOf("{");
  if (openIdx === -1) return null;
  const closeIdx = findMatchingBrace(text, openIdx);
  if (closeIdx === -1) return null;
  return text.slice(openIdx + 1, closeIdx);
}

function countNewlinesBefore(fullText: string, sub: string): number {
  const idx = fullText.indexOf(sub);
  if (idx === -1) return 0;
  return fullText.slice(0, idx).split("\n").length - 1;
}

/** 文字列/コメントを考慮しつつ、openIdxにある"{"と対応する"}"のインデックスを返す。 */
function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === "\\") {
        i++;
      } else if (c === inString) {
        inString = null;
      }
      continue;
    }

    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 括弧 `( ... )` の中身をおおまかに抽出する(条件式表示用)。 */
function extractParenExpr(text: string, fromIdx: number): { expr: string; endIdx: number } {
  const openIdx = text.indexOf("(", fromIdx);
  if (openIdx === -1) return { expr: "", endIdx: fromIdx };
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")") {
      depth--;
      if (depth === 0) return { expr: text.slice(openIdx + 1, i), endIdx: i + 1 };
    }
  }
  return { expr: text.slice(openIdx + 1), endIdx: text.length };
}

function truncate(s: string, max = 60): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/**
 * ブロック本体を先頭から走査し、制御構文と素通りの処理文を交互にノード化する。
 * 戻り値のexitIdsは「このブロックを抜けた後に後続へ繋ぐべきノードID群」を表す
 * (if/elseの各分岐末尾、あるいは単純な直列末尾など複数になりうる)。
 */
function parseBlock(text: string, blockStartLine: number, allocator: NodeIdAllocator): BlockResult {
  const nodes: FlowchartNode[] = [];
  const edges: FlowchartEdge[] = [];

  let entryId: string | undefined;
  let tailIds: string[] = [];
  let cursor = 0;
  let plainBuffer: { text: string; line: number } | null = null;

  const flushPlain = () => {
    if (!plainBuffer) return;
    const id = allocator.next();
    const line = blockStartLine + plainBuffer.line;
    nodes.push({
      id,
      kind: "process",
      label: truncate(plainBuffer.text) || "(処理)",
      sourceRange: { startLine: line + 1, endLine: line + 1 },
    });
    connect(id);
    plainBuffer = null;
  };

  const connect = (nodeId: string) => {
    if (!entryId) entryId = nodeId;
    for (const t of tailIds) edges.push({ from: t, to: nodeId });
    tailIds = [nodeId];
  };

  const lineOf = (idx: number) => text.slice(0, idx).split("\n").length - 1;

  while (cursor < text.length) {
    // 現在位置から次の非空行/トークンまで読み進める
    const restFromCursor = text.slice(cursor);
    const lineStartMatch = /^[ \t]*/.exec(restFromCursor);
    const indent = lineStartMatch ? lineStartMatch[0].length : 0;
    const trimmedRest = restFromCursor.slice(indent);

    if (trimmedRest.length === 0) break;

    const keywordMatch = CONTROL_KEYWORD_RE.exec(trimmedRest) || ELSE_RE.exec(trimmedRest);
    const atLineStart = cursor === 0 || text[cursor - 1] === "\n" || /^[ \t]*$/.test(text.slice(Math.max(0, cursor - indent), cursor));

    if (keywordMatch && atLineStart) {
      flushPlain();
      const keyword = keywordMatch[0];
      const line = lineOf(cursor + indent);

      if (keyword === "if") {
        const chainResult = parseIfChain(text, cursor + indent, blockStartLine, allocator);
        nodes.push(...chainResult.nodes);
        edges.push(...chainResult.edges);
        if (chainResult.entryId) connectCompound(chainResult.entryId);
        tailIds = mergeTails(tailIds, entryId, chainResult, connectCompound);
        cursor = chainResult.nextIdx;
        continue;
      }

      if (keyword === "for" || keyword === "foreach" || keyword === "while") {
        const { expr, endIdx } = extractParenExpr(text, cursor + indent);
        const loopId = allocator.next();
        nodes.push({
          id: loopId,
          kind: "loop",
          label: `${keyword} (${truncate(expr, 40)})`,
          sourceRange: { startLine: blockStartLine + line + 1, endLine: blockStartLine + line + 1 },
        });
        connect(loopId);

        const braceIdx = text.indexOf("{", endIdx);
        if (braceIdx !== -1) {
          const closeIdx = findMatchingBrace(text, braceIdx);
          const inner = text.slice(braceIdx + 1, closeIdx);
          const innerStartLine = blockStartLine + lineOf(braceIdx + 1);
          const bodyResult = parseBlock(inner, innerStartLine, allocator);
          nodes.push(...bodyResult.nodes);
          edges.push(...bodyResult.edges);
          if (bodyResult.entryId) {
            edges.push({ from: loopId, to: bodyResult.entryId, label: "true" });
            for (const exitId of bodyResult.exitIds) {
              edges.push({ from: exitId, to: loopId });
            }
          } else {
            edges.push({ from: loopId, to: loopId, label: "true" });
          }
          cursor = closeIdx + 1;
        } else {
          cursor = endIdx;
        }
        tailIds = [loopId];
        continue;
      }

      if (keyword === "switch") {
        const { expr, endIdx } = extractParenExpr(text, cursor + indent);
        const switchId = allocator.next();
        nodes.push({
          id: switchId,
          kind: "decision",
          label: `switch (${truncate(expr, 40)})`,
          sourceRange: { startLine: blockStartLine + line + 1, endLine: blockStartLine + line + 1 },
        });
        connect(switchId);

        const braceIdx = text.indexOf("{", endIdx);
        if (braceIdx !== -1) {
          const closeIdx = findMatchingBrace(text, braceIdx);
          const inner = text.slice(braceIdx + 1, closeIdx);
          const caseExits = parseSwitchCases(inner, blockStartLine + lineOf(braceIdx + 1), allocator, switchId);
          nodes.push(...caseExits.nodes);
          edges.push(...caseExits.edges);
          tailIds = caseExits.exitIds.length ? caseExits.exitIds : [switchId];
          cursor = closeIdx + 1;
        } else {
          cursor = endIdx;
          tailIds = [switchId];
        }
        continue;
      }

      if (keyword === "do") {
        // do { ... } while (...);  簡易的にループとして扱う
        const braceIdx = text.indexOf("{", cursor + indent);
        const doLine = blockStartLine + line;
        const loopId = allocator.next();
        if (braceIdx !== -1) {
          const closeIdx = findMatchingBrace(text, braceIdx);
          const inner = text.slice(braceIdx + 1, closeIdx);
          const whileMatch = /while\s*\(/.exec(text.slice(closeIdx));
          let expr = "";
          let afterWhileIdx = closeIdx + 1;
          if (whileMatch) {
            const whileIdx = closeIdx + whileMatch.index;
            const parsed = extractParenExpr(text, whileIdx);
            expr = parsed.expr;
            afterWhileIdx = parsed.endIdx;
          }
          nodes.push({
            id: loopId,
            kind: "loop",
            label: `do/while (${truncate(expr, 40)})`,
            sourceRange: { startLine: doLine + 1, endLine: doLine + 1 },
          });
          const innerStartLine = blockStartLine + lineOf(braceIdx + 1);
          const bodyResult = parseBlock(inner, innerStartLine, allocator);
          nodes.push(...bodyResult.nodes);
          edges.push(...bodyResult.edges);
          if (bodyResult.entryId) {
            connect(bodyResult.entryId);
            for (const exitId of bodyResult.exitIds) {
              edges.push({ from: exitId, to: loopId });
            }
          } else {
            connect(loopId);
          }
          tailIds = [loopId];
          cursor = afterWhileIdx;
        } else {
          cursor = cursor + indent + keyword.length;
        }
        continue;
      }
    }

    // 制御構文でなければ次の改行までを素通り処理として蓄積する
    const nl = restFromCursor.indexOf("\n");
    const lineText = nl === -1 ? trimmedRest : restFromCursor.slice(indent, nl);
    const advanceBy = (nl === -1 ? restFromCursor.length : nl + 1);
    const trimmedLine = lineText.trim();
    if (trimmedLine.length > 0 && trimmedLine !== "}" && trimmedLine !== "{") {
      if (!plainBuffer) {
        plainBuffer = { text: trimmedLine, line: lineOf(cursor + indent) };
      } else {
        plainBuffer.text += " " + trimmedLine;
      }
    }
    cursor += advanceBy;
  }

  flushPlain();

  return { nodes, edges, entryId, exitIds: tailIds };

  function connectCompound(nodeId: string) {
    if (!entryId) entryId = nodeId;
    for (const t of tailIds) edges.push({ from: t, to: nodeId });
  }
}

function mergeTails(
  _prevTails: string[],
  _entryId: string | undefined,
  chainResult: { exitIds: string[] },
  _connectCompound: (id: string) => void
): string[] {
  return chainResult.exitIds;
}

interface IfChainResult {
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
  entryId?: string;
  exitIds: string[];
  nextIdx: number;
}

/** if / else if / else の連鎖をまとめて解析する。 */
function parseIfChain(
  text: string,
  ifKeywordIdx: number,
  blockStartLine: number,
  allocator: NodeIdAllocator
): IfChainResult {
  const nodes: FlowchartNode[] = [];
  const edges: FlowchartEdge[] = [];
  const exitIds: string[] = [];
  let entryId: string | undefined;

  let cursor = ifKeywordIdx;
  let isFirst = true;
  let prevDecisionId: string | undefined;

  const lineOf = (idx: number) => text.slice(0, idx).split("\n").length - 1;

  while (true) {
    const isElseOnly = !isFirst && !/^else\s+if\b/.test(text.slice(cursor));
    if (isElseOnly && /^else\b/.test(text.slice(cursor))) {
      // else { ... } (条件なし)
      const braceIdx = text.indexOf("{", cursor);
      const closeIdx = findMatchingBrace(text, braceIdx);
      const inner = text.slice(braceIdx + 1, closeIdx);
      const innerStartLine = blockStartLine + lineOf(braceIdx + 1);
      const bodyResult = parseBlock(inner, innerStartLine, allocator);
      nodes.push(...bodyResult.nodes);
      edges.push(...bodyResult.edges);
      if (prevDecisionId) {
        if (bodyResult.entryId) {
          edges.push({ from: prevDecisionId, to: bodyResult.entryId, label: "false" });
          exitIds.push(...bodyResult.exitIds);
        } else {
          exitIds.push(prevDecisionId);
        }
      }
      return { nodes, edges, entryId, exitIds, nextIdx: closeIdx + 1 };
    }

    // if (...) または else if (...)
    const keywordRe = isFirst ? /^if\s*/ : /^else\s+if\s*/;
    const m = keywordRe.exec(text.slice(cursor));
    const afterKeywordIdx = cursor + (m ? m[0].length : 0);
    const { expr, endIdx } = extractParenExpr(text, afterKeywordIdx);
    const line = lineOf(cursor);
    const decisionId = allocator.next();
    nodes.push({
      id: decisionId,
      kind: "decision",
      label: `${isFirst ? "if" : "else if"} (${truncate(expr, 40)})`,
      sourceRange: { startLine: blockStartLine + line + 1, endLine: blockStartLine + line + 1 },
    });
    if (!entryId) entryId = decisionId;
    if (prevDecisionId) {
      edges.push({ from: prevDecisionId, to: decisionId, label: "false" });
    }

    const braceIdx = text.indexOf("{", endIdx);
    const closeIdx = findMatchingBrace(text, braceIdx);
    const inner = text.slice(braceIdx + 1, closeIdx);
    const innerStartLine = blockStartLine + lineOf(braceIdx + 1);
    const bodyResult = parseBlock(inner, innerStartLine, allocator);
    nodes.push(...bodyResult.nodes);
    edges.push(...bodyResult.edges);
    if (bodyResult.entryId) {
      edges.push({ from: decisionId, to: bodyResult.entryId, label: "true" });
      exitIds.push(...bodyResult.exitIds);
    } else {
      exitIds.push(decisionId);
    }

    cursor = closeIdx + 1;
    const restTrimStart = /^[ \t\n]*/.exec(text.slice(cursor));
    const afterWs = cursor + (restTrimStart ? restTrimStart[0].length : 0);

    if (/^else\b/.test(text.slice(afterWs))) {
      cursor = afterWs;
      isFirst = false;
      prevDecisionId = decisionId;
      continue;
    }

    // else節なし: 条件がfalseの場合の宙ぶらりん分岐を終端として登録
    exitIds.push(decisionId);
    return { nodes, edges, entryId, exitIds, nextIdx: cursor };
  }
}

/** switch文のcaseブロックを走査し、それぞれをswitchノードから分岐させる。 */
function parseSwitchCases(
  text: string,
  startLine: number,
  allocator: NodeIdAllocator,
  switchId: string
): { nodes: FlowchartNode[]; edges: FlowchartEdge[]; exitIds: string[] } {
  const nodes: FlowchartNode[] = [];
  const edges: FlowchartEdge[] = [];
  const exitIds: string[] = [];

  const caseRe = /(case\s+[^:]+:|default\s*:)/g;
  const matches = [...text.matchAll(caseRe)];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const bodyStart = m.index! + m[0].length;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    const caseLabel = m[0].replace(/:$/, "").trim();
    const body = text.slice(bodyStart, bodyEnd);
    const lineOffset = text.slice(0, bodyStart).split("\n").length - 1;

    const bodyResult = parseBlock(body, startLine + lineOffset, allocator);
    nodes.push(...bodyResult.nodes);
    edges.push(...bodyResult.edges);

    if (bodyResult.entryId) {
      edges.push({ from: switchId, to: bodyResult.entryId, label: "" });
      exitIds.push(...bodyResult.exitIds);
    }
  }

  return { nodes, edges, exitIds };
}
