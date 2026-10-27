import type Parser from "web-tree-sitter";
import {
  EMPTY_FLOW,
  type Flow,
  FlowBuilder,
} from "../../core/flowchart-ir/flow-builder";
import type {
  FlowchartEdge,
  FlowchartNode,
  SourceRange,
} from "../../core/flowchart-ir/schema";

/**
 * tree-sitter の構文木(C# / TypeScript / TSX / JavaScript)から FlowchartIR を組み立てる。
 * `vscode` に依存しない純粋なウォーカー(Node 単体でテストできる)。ファイルの読み込みと
 * WASM の初期化は treeSitterExtractor.ts が担う。
 *
 * テキストを読むヒューリスティック(controlFlowScanner.ts)と同じ共通部品(FlowBuilder)を使うので、
 * true/false のラベル・return/throw の終端・到達不能コードの除去が、どちらの経路でも同じ規則になる。
 */

type SyntaxNode = Parser.SyntaxNode;
type Point = { row: number; column: number };

const MAX_LABEL = 60;
const MAX_CONDITION = 40;

const FUNCTION_TYPES = new Set([
  "method_declaration",
  "constructor_declaration",
  "local_function_statement",
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "function",
  "arrow_function",
  "method_definition",
]);

const BLOCK_TYPES = new Set(["block", "statement_block"]);
const IF_TYPES = new Set(["if_statement"]);
const FOR_TYPES = new Set([
  "for_statement",
  "for_in_statement",
  "for_of_statement",
]);
const FOREACH_TYPES = new Set(["foreach_statement", "for_each_statement"]);
const WHILE_TYPES = new Set(["while_statement"]);
const DO_TYPES = new Set(["do_statement"]);
const SWITCH_TYPES = new Set(["switch_statement"]);
const TRY_TYPES = new Set(["try_statement"]);
const TERMINAL_TYPES = new Set(["return_statement", "throw_statement"]);
const WRAPPER_TYPES = new Set([
  "using_statement",
  "lock_statement",
  "fixed_statement",
  "checked_statement",
  "unsafe_statement",
]);
const SKIPPED_TYPES = new Set(["comment", "empty_statement"]);

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max = MAX_LABEL): string {
  const one = collapse(s);
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function stripOuterParens(s: string): string {
  const t = s.trim();
  return t.startsWith("(") && t.endsWith(")") ? t.slice(1, -1) : t;
}

type Kind = "simple" | "terminal" | "control";

/**
 * ループ本体。TypeScript の文法は `body` フィールドを持つが、C# の while / foreach などは持たないため、
 * その場合は「最後の名前つきの子」を本体とみなす(`while (cond) stmt` の並び)。do 文だけは先頭が本体。
 */
function bodyOf(n: SyntaxNode): SyntaxNode | null {
  const named = n.childForFieldName("body");
  if (named) return named;
  const kids = n.namedChildren.filter((c) => !SKIPPED_TYPES.has(c.type));
  if (kids.length === 0) return null;
  return DO_TYPES.has(n.type) ? kids[0] : kids[kids.length - 1];
}

/** ループ・do の条件式。`condition` フィールドが無ければ、本体とは反対側の名前つきの子。 */
function conditionOf(n: SyntaxNode): SyntaxNode | null {
  const named = n.childForFieldName("condition");
  if (named) return named;
  const body = bodyOf(n);
  const kids = n.namedChildren.filter((c) => c !== body && !SKIPPED_TYPES.has(c.type));
  return kids.length ? (DO_TYPES.has(n.type) ? kids[kids.length - 1] : kids[0]) : null;
}

class TreeWalker {
  readonly b = new FlowBuilder();

  constructor(private readonly baseLine: number) {}

  private range(first: SyntaxNode, last: SyntaxNode = first): SourceRange {
    return {
      startLine: this.baseLine + first.startPosition.row + 1,
      endLine: this.baseLine + last.endPosition.row + 1,
    };
  }

  private classify(n: SyntaxNode): Kind {
    if (TERMINAL_TYPES.has(n.type)) return "terminal";
    if (
      BLOCK_TYPES.has(n.type) ||
      IF_TYPES.has(n.type) ||
      FOR_TYPES.has(n.type) ||
      FOREACH_TYPES.has(n.type) ||
      WHILE_TYPES.has(n.type) ||
      DO_TYPES.has(n.type) ||
      SWITCH_TYPES.has(n.type) ||
      TRY_TYPES.has(n.type) ||
      WRAPPER_TYPES.has(n.type)
    ) {
      return "control";
    }
    return "simple";
  }

  /** 文の並び。連続する単純な文は1つのノードにまとめる(テキスト版と同じ)。 */
  walkSequence(stmts: SyntaxNode[]): Flow {
    const seq = this.b.sequence();
    let group: { parts: string[]; first: SyntaxNode; last: SyntaxNode } | null =
      null;

    const flush = () => {
      if (!group) return;
      seq.add(
        this.b.process(
          truncate(group.parts.join(" ")),
          this.range(group.first, group.last),
        ),
      );
      group = null;
    };

    for (const s of stmts) {
      if (!s.isNamed || SKIPPED_TYPES.has(s.type)) continue;
      const kind = this.classify(s);

      if (kind === "simple") {
        if (seq.dead) continue; // return / throw のあとは到達不能
        group ??= { parts: [], first: s, last: s };
        group.parts.push(s.text);
        group.last = s;
        continue;
      }

      flush();
      const mark = this.b.mark();
      const flow =
        kind === "terminal"
          ? this.b.terminal(truncate(s.text), this.range(s))
          : this.walkControl(s);
      if (seq.dead) this.b.rollback(mark);
      else seq.add(flow);
    }
    flush();
    return seq.done();
  }

  /** 単文またはブロック(`if (a) foo();` の foo();、`{ ... }`)を1つの Flow として読む。 */
  private walkBody(n: SyntaxNode | null): Flow {
    if (!n) return EMPTY_FLOW;
    if (BLOCK_TYPES.has(n.type)) return this.walkSequence(n.namedChildren);
    return this.walkSequence([n]);
  }

  private walkControl(n: SyntaxNode): Flow {
    if (BLOCK_TYPES.has(n.type)) return this.walkSequence(n.namedChildren);
    if (IF_TYPES.has(n.type)) return this.walkIf(n, "if");
    if (FOR_TYPES.has(n.type)) return this.walkLoop(n, "for");
    if (FOREACH_TYPES.has(n.type)) return this.walkLoop(n, "foreach");
    if (WHILE_TYPES.has(n.type)) return this.walkLoop(n, "while");
    if (DO_TYPES.has(n.type)) return this.walkDo(n);
    if (SWITCH_TYPES.has(n.type)) return this.walkSwitch(n);
    if (TRY_TYPES.has(n.type)) return this.walkTry(n);
    // using / lock など: 本体をそのまま流れに溶かす
    return this.walkBody(
      n.childForFieldName("body") ??
        n.namedChildren[n.namedChildren.length - 1] ??
        null,
    );
  }

  private walkIf(n: SyntaxNode, label: "if" | "else if"): Flow {
    const cond = n.childForFieldName("condition");
    const id = this.b.decision(
      `${label} (${truncate(stripOuterParens(cond?.text ?? ""), MAX_CONDITION)})`,
      this.range(n.firstChild ?? n, cond ?? n),
    );
    const thenFlow = this.walkBody(n.childForFieldName("consequence"));

    let alt = n.childForFieldName("alternative");
    if (alt?.type === "else_clause") alt = alt.namedChildren[0] ?? null; // TypeScript は else_clause で包む
    let elseFlow: Flow | undefined;
    if (alt) {
      elseFlow = IF_TYPES.has(alt.type)
        ? this.walkIf(alt, "else if")
        : this.walkBody(alt);
    }
    return this.b.completeBranch(id, thenFlow, elseFlow);
  }

  /** ループの見出し(括弧の中身)。本体の手前までの文字列から、キーワードと外側の括弧を除いて作る。 */
  private loopHeader(n: SyntaxNode, keyword: string): string {
    const body = bodyOf(n);
    const head = body
      ? n.text.slice(0, body.startIndex - n.startIndex)
      : (conditionOf(n)?.text ?? "");
    const rest = head.replace(
      new RegExp(`^\\s*(await\\s+)?${keyword}\\s*(await\\s*)?`),
      "",
    );
    return truncate(stripOuterParens(rest), MAX_CONDITION);
  }

  private walkLoop(n: SyntaxNode, keyword: string): Flow {
    const body = bodyOf(n);
    const id = this.b.loopNode(
      `${keyword} (${this.loopHeader(n, keyword)})`,
      this.range(n.firstChild ?? n),
    );
    return this.b.completeLoop(id, this.walkBody(body));
  }

  private walkDo(n: SyntaxNode): Flow {
    const cond = conditionOf(n);
    const body = this.walkBody(bodyOf(n));
    return this.b.doWhile(
      body,
      `do/while (${truncate(stripOuterParens(cond?.text ?? ""), MAX_CONDITION)})`,
      this.range(cond ?? n),
    );
  }

  private walkSwitch(n: SyntaxNode): Flow {
    const value =
      n.childForFieldName("value") ?? n.childForFieldName("condition");
    const id = this.b.switchNode(
      `switch (${truncate(stripOuterParens(value?.text ?? ""), MAX_CONDITION)})`,
      this.range(n.firstChild ?? n, value ?? n),
    );
    const body =
      n.childForFieldName("body") ??
      n.namedChildren.find((c) => c.type === "switch_body") ??
      null;
    const sections = body ? body.namedChildren : [];

    const cases: Flow[] = [];
    let hasDefault = false;
    let emptyTail = false;
    sections.forEach((sec, i) => {
      if (SKIPPED_TYPES.has(sec.type)) return;
      let stmts: SyntaxNode[];
      if (sec.type === "switch_default") {
        hasDefault = true;
        stmts = sec.namedChildren;
      } else if (sec.type === "switch_case") {
        stmts = sec.namedChildren.slice(1); // 先頭は case の値
      } else {
        // C#: switch_section — ラベル(case/default)を除いた残りが本文
        if (sec.namedChildren.some((c) => c.type === "default_switch_label"))
          hasDefault = true;
        stmts = sec.namedChildren.filter(
          (c) => !/_label$/.test(c.type) && c.type !== "when_clause",
        );
      }
      const flow = this.walkSequence(stmts);
      if (flow.entryId) {
        cases.push(flow);
      } else {
        // 本体のない case は、直後の case とまとめる。最後の1つなら、そこで switch を抜ける
        const hasNext = sections
          .slice(i + 1)
          .some((s) => !SKIPPED_TYPES.has(s.type));
        if (!hasNext) emptyTail = true;
      }
    });
    return this.b.completeSwitch(id, cases, !hasDefault || emptyTail);
  }

  private walkTry(n: SyntaxNode): Flow {
    const body = this.walkBody(
      n.childForFieldName("body") ??
        n.namedChildren.find((c) => BLOCK_TYPES.has(c.type)) ??
        null,
    );
    const handlers: Flow[] = [];
    let finallyNode: SyntaxNode | null = null;
    for (const c of n.namedChildren) {
      if (c.type === "catch_clause") {
        const seq = this.b.sequence();
        const head = c.text.slice(
          0,
          (c.childForFieldName("body")?.startIndex ?? c.endIndex) -
            c.startIndex,
        );
        seq.add(this.b.process(truncate(head), this.range(c)));
        seq.add(
          this.walkBody(
            c.childForFieldName("body") ??
              c.namedChildren.find((x) => BLOCK_TYPES.has(x.type)) ??
              null,
          ),
        );
        handlers.push(seq.done());
      } else if (c.type === "finally_clause") {
        finallyNode = c;
      }
    }

    let flow = this.b.tryCatch(body, handlers);
    if (finallyNode) {
      const mark = this.b.mark();
      const fin = this.walkBody(
        finallyNode.childForFieldName("body") ??
          finallyNode.namedChildren.find((x) => BLOCK_TYPES.has(x.type)) ??
          null,
      );
      if (fin.entryId && flow.exits.length === 0) {
        this.b.rollback(mark); // すべての経路が return/throw で終わるなら、finally へ繋ぐ先がない
      } else if (fin.entryId) {
        const seq = this.b.sequence();
        seq.add(flow);
        seq.add(fin);
        flow = seq.done();
      }
    }
    return flow;
  }
}

/** 位置を含む、いちばん内側の関数。なければ、ソース順で最初の関数。それも無ければ null。 */
export function findTargetFunction(
  root: SyntaxNode,
  at?: Point,
): SyntaxNode | null {
  if (at) {
    for (
      let n: SyntaxNode | null = root.descendantForPosition(at);
      n;
      n = n.parent
    ) {
      if (FUNCTION_TYPES.has(n.type)) return n;
    }
  }
  const stack: SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (FUNCTION_TYPES.has(n.type)) return n;
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return null;
}

export function functionName(fn: SyntaxNode): string | null {
  const name = fn.childForFieldName("name");
  return name ? name.text : null;
}

/**
 * 構文木から、対象の関数(カーソル位置の関数、無ければ最初の関数)のフローを組み立てる。
 * 関数が1つも無ければ、トップレベルの文(スクリプト)を対象にする。
 */
export function buildFlowFromTree(
  root: SyntaxNode,
  at: Point | undefined,
  fallbackLabel: string,
): { nodes: FlowchartNode[]; edges: FlowchartEdge[]; functionLabel: string } {
  const walker = new TreeWalker(0);
  const target = findTargetFunction(root, at);

  const name = target ? functionName(target) : null;
  const label = name ? `${name}()` : fallbackLabel;
  const top = target ?? root;
  const startRow = top.startPosition.row + 1;
  const startId = walker.b.start(label, {
    startLine: startRow,
    endLine: startRow,
  });

  let stmts: SyntaxNode[];
  const body = target?.childForFieldName("body") ?? null;
  if (target) {
    stmts = body
      ? BLOCK_TYPES.has(body.type)
        ? body.namedChildren
        : [body]
      : [];
  } else {
    stmts = root.namedChildren;
  }

  const flow = walker.walkSequence(stmts);
  const endRow = top.endPosition.row + 1;
  const result = walker.b.finish(startId, flow, "End", {
    startLine: endRow,
    endLine: endRow,
  });
  return { ...result, functionLabel: label };
}
