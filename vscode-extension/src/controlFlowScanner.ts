import { EMPTY_FLOW, type Flow, FlowBuilder } from "../../core/flowchart-ir/flow-builder";
import type { FlowchartEdge, FlowchartNode, SourceRange } from "../../core/flowchart-ir/schema";
import { maskCode, matchBracket } from "./codeMask";

/**
 * DocumentSymbolはシンボルの外形(名前・範囲)しか提供しないため、if/for/while/switch
 * といった文レベルの構造はVSCode APIから直接取得できない。このモジュールは対象範囲の
 * テキストを読み、制御構文を検出して、共通部品(FlowBuilder)でFlowchartIRを組み立てる。
 *
 * 作りの方針:
 *   1. コメント・文字列の中身を空白にした「マスク」(codeMask.ts)に対してだけ、キーワードと括弧を探す。
 *      ラベルは同じ位置の元のテキストから取る。
 *   2. 文を1つずつ読む再帰下降。`{ }` のブロックも、ブロックなしの単文(`if (a) foo();`)も同じ扱い。
 *   3. 意味づけ(true/false・return の終端・到達不能コードの除去)は FlowBuilder に任せる。
 *   4. 1回の読み取りで進む回数に上限を置き、どんな入力でも必ず終わる(以前は、ブレースなしの if で
 *      無限ループしてメモリを使い切った)。
 *
 * 制約(ヒューリスティックであることの限界):
 *   - break / continue は流れを変えず、ふつうの文として並べる(ループの外へ出る線は描かない)。
 *   - try / catch は、本文の先頭から catch へ線を1本引くだけ(例外が起きうる位置までは見ない)。
 *   - ラムダ・ローカル関数の中身は、外側の1文として扱い、中の if/for は図にしない。
 */

const MAX_LABEL = 60;
const MAX_CONDITION = 40;

const FLOW_KEYWORDS = new Set(["if", "for", "foreach", "while", "do", "switch", "try"]);
/** `(` が続くときだけ、本体を持つ構文として扱う語(C# の using / lock、Java の synchronized など)。 */
const PAREN_BLOCK_KEYWORDS = new Set(["using", "lock", "fixed", "synchronized"]);
const BARE_BLOCK_KEYWORDS = new Set(["checked", "unchecked", "unsafe"]);

/** 行末がこれで終わる文は、次の行へ続く(セミコロンを省く言語での文の切れ目の判定)。 */
const CONTINUE_AFTER = ",.+-*/%&|^?:=([{!~";
/** 次の行がこれで始まるなら、前の行から続く。 */
const CONTINUE_BEFORE = ".,?:+-*/%&|^={;";

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max = MAX_LABEL): string {
  const one = collapse(s);
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}

/** 文字列/コメントを考慮しつつ、openIdx にある "{" と対応する "}" の位置を返す(なければ -1)。 */
export function findMatchingBrace(text: string, openIdx: number): number {
  return matchBracket(maskCode(text), openIdx, "{", "}");
}

type Peek =
  | { kind: "end"; pos: number }
  | { kind: "stop"; pos: number }
  | { kind: "block" | "control" | "terminal" | "simple"; pos: number; word: string };

class Scanner {
  private readonly m: string;
  private readonly lineStarts: number[] = [0];
  private readonly b = new FlowBuilder();
  private steps = 0;
  private readonly maxSteps: number;

  constructor(
    private readonly src: string,
    private readonly baseLine: number,
  ) {
    this.m = maskCode(src);
    for (let i = 0; i < src.length; i++) if (src[i] === "\n") this.lineStarts.push(i + 1);
    this.maxSteps = src.length * 8 + 1000;
  }

  run(functionLabel: string): { nodes: FlowchartNode[]; edges: FlowchartEdge[] } {
    const startLine = this.baseLine + 1;
    const startId = this.b.start(functionLabel, { startLine, endLine: startLine });
    const [bodyStart, bodyEnd] = this.findBody();
    const body = this.parseSequence(bodyStart, bodyEnd, false);
    const endLine = this.baseLine + this.lineStarts.length;
    return this.b.finish(startId, body.flow, "End", { startLine: endLine, endLine });
  }

  // ------------------------------------------------------------------ 位置・文字列の補助

  /** オフセット → 元ファイル上の行番号(1始まり)。二分探索。 */
  private lineOf(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return this.baseLine + lo + 1;
  }

  private range(a: number, b: number): SourceRange {
    let last = Math.min(b, this.m.length) - 1;
    while (last > a && isSpace(this.m[last])) last--;
    return { startLine: this.lineOf(a), endLine: this.lineOf(Math.max(a, last)) };
  }

  private text(a: number, b: number, max = MAX_LABEL): string {
    return truncate(this.src.slice(a, b), max);
  }

  private skip(pos: number, end: number): number {
    while (pos < end && isSpace(this.m[pos])) pos++;
    return pos;
  }

  private skipEmpty(pos: number, end: number): number {
    while (pos < end && (isSpace(this.m[pos]) || this.m[pos] === ";")) pos++;
    return pos;
  }

  private word(pos: number): string {
    const re = /[A-Za-z_$][\w$]*/y;
    re.lastIndex = pos;
    const hit = re.exec(this.m);
    return hit ? hit[0] : "";
  }

  /** 進みが止まる入力でも必ず終わらせる安全装置。 */
  private tick(): void {
    if (++this.steps > this.maxSteps) {
      throw new Error("構文を解析しきれませんでした(読み取りが収束しませんでした)");
    }
  }

  // ------------------------------------------------------------------ 関数本体の位置

  /** 関数宣言を除いた、本体 `{ ... }` の中身の範囲。見つからなければ全体。 */
  private findBody(): [number, number] {
    const m = this.m;
    const n = m.length;
    let from = 0;
    const paren = m.indexOf("(");
    if (paren >= 0) {
      const close = matchBracket(m, paren, "(", ")");
      if (close >= 0) from = close + 1; // 引数の後ろから本体を探す(引数の型リテラルの { } を拾わない)
    }

    let lastSig = "";
    for (let i = from; i < n; i++) {
      const c = m[i];
      if (c === "=" && m[i + 1] === ">") {
        // 式形式の本体(=> expr)
        const after = this.skip(i + 2, n);
        if (m[after] !== "{") return [after, n];
      }
      if (c === "{") {
        const close = matchBracket(m, i, "{", "}");
        // `): { a: number } {` の戻り値の型リテラルは本体ではない
        if (lastSig === ":" && close >= 0) {
          i = close;
          lastSig = "}";
          continue;
        }
        return [i + 1, close < 0 ? n : close];
      }
      if (!isSpace(c)) lastSig = c;
    }
    return [0, n];
  }

  // ------------------------------------------------------------------ 文の種類の判定

  private peek(pos: number, end: number, inSwitch: boolean): Peek {
    pos = this.skipEmpty(pos, end);
    if (pos >= end) return { kind: "end", pos: end };
    if (this.m[pos] === "{") return { kind: "block", pos, word: "" };

    let word = this.word(pos);
    if (word === "await") {
      // await foreach / await using / for await
      const p2 = this.skip(pos + 5, end);
      const w2 = this.word(p2);
      if (w2 === "foreach" || w2 === "using" || w2 === "for") {
        pos = p2;
        word = w2;
      }
    }

    if (inSwitch && (word === "case" || (word === "default" && this.isDefaultLabel(pos + 7, end)))) {
      return { kind: "stop", pos };
    }
    if (word === "return" || word === "throw") return { kind: "terminal", pos, word };
    if (FLOW_KEYWORDS.has(word) || word === "else") return { kind: "control", pos, word };

    if (PAREN_BLOCK_KEYWORDS.has(word) && this.m[this.skip(pos + word.length, end)] === "(") {
      return { kind: "control", pos, word };
    }
    if (BARE_BLOCK_KEYWORDS.has(word) && this.m[this.skip(pos + word.length, end)] === "{") {
      return { kind: "control", pos, word };
    }
    return { kind: "simple", pos, word };
  }

  private isDefaultLabel(pos: number, end: number): boolean {
    const c = this.m[this.skip(pos, end)];
    return c === ":" || c === "-";
  }

  // ------------------------------------------------------------------ 単純な文の終わり

  /**
   * 単純な文の終わりを探す。終わりは次のいずれか:
   *   - 深さ 0 の `;`
   *   - 深さ 0 の改行(セミコロンを省く言語のため。次の行へ続く書き方は続ける)
   *   - 引数リストの直後に `{` が来る形(ローカル関数)では、対応する `}`
   *   - 外側のブロックを閉じる `}`
   */
  private scanSimple(pos: number, end: number): { stmtEnd: number; next: number } {
    const m = this.m;
    let depth = 0;
    let lastSig = "";
    let prevSig = "";
    for (let i = pos; i < end; i++) {
      const c = m[i];
      if (c === "(" || c === "[") {
        depth++;
      } else if (c === ")" || c === "]") {
        depth = Math.max(0, depth - 1);
      } else if (c === "{") {
        if (depth === 0 && lastSig === ")") {
          const close = matchBracket(m, i, "{", "}");
          const stop = close < 0 || close >= end ? end : close + 1;
          return { stmtEnd: stop, next: stop };
        }
        depth++;
      } else if (c === "}") {
        if (depth === 0) return { stmtEnd: i, next: i };
        depth--;
      } else if (c === ";" && depth === 0) {
        return { stmtEnd: i + 1, next: i + 1 };
      } else if (c === "\n" && depth === 0 && lastSig !== "" && this.endsStatementAtNewline(i, end, lastSig, prevSig)) {
        return { stmtEnd: i, next: i + 1 };
      }
      if (!isSpace(c)) {
        prevSig = lastSig;
        lastSig = c;
      }
    }
    return { stmtEnd: end, next: end };
  }

  private endsStatementAtNewline(nl: number, end: number, last: string, prev: string): boolean {
    if (CONTINUE_AFTER.includes(last)) return false;
    if (last === ">" && prev === "=") return false; // =>
    const m = this.m;
    let j = nl + 1;
    while (j < end && isSpace(m[j])) j++;
    const next = m[j];
    if (next === undefined) return true;
    if ((next === "+" || next === "-") && m[j + 1] === next) return true; // ++i / --i は新しい文
    if (CONTINUE_BEFORE.includes(next)) return false;
    return true;
  }

  // ------------------------------------------------------------------ 並び・単文

  private parseSequence(pos: number, end: number, inSwitch: boolean): { flow: Flow; next: number } {
    const seq = this.b.sequence();
    let group: { parts: string[]; start: number; end: number } | null = null;

    const flush = () => {
      if (!group) return;
      seq.add(this.b.process(truncate(group.parts.join(" ")), this.range(group.start, group.end)));
      group = null;
    };

    while (pos < end) {
      this.tick();
      if (this.m[pos] === "}") {
        pos++; // 対応のない閉じ括弧
        continue;
      }
      const p = this.peek(pos, end, inSwitch);
      if (p.kind === "end") {
        pos = end;
        break;
      }
      if (p.kind === "stop") {
        pos = p.pos;
        break;
      }

      if (p.kind === "simple") {
        const s = this.scanSimple(p.pos, end);
        pos = Math.max(s.next, p.pos + 1);
        if (seq.dead) continue; // return / throw のあとは到達不能
        group ??= { parts: [], start: p.pos, end: s.stmtEnd };
        group.parts.push(this.text(p.pos, s.stmtEnd));
        group.end = s.stmtEnd;
        continue;
      }

      // 制御構文・ブロック・return/throw: ノードを作る前に、溜めた単純な文を先に1つのノードにする(出現順の ID にするため)
      flush();
      const mark = this.b.mark();
      if (p.kind === "terminal") {
        const s = this.scanSimple(p.pos, end);
        pos = Math.max(s.next, p.pos + 1);
        if (!seq.dead) seq.add(this.b.terminal(this.text(p.pos, s.stmtEnd), this.range(p.pos, s.stmtEnd)));
        continue;
      }
      const r = this.parseControl(p, end);
      pos = Math.max(r.next, p.pos + 1);
      if (seq.dead) this.b.rollback(mark); // 到達不能なコードのノードは作らなかったことにする
      else seq.add(r.flow);
    }
    flush();
    return { flow: seq.done(), next: pos };
  }

  /** 単文またはブロック(`if (a) foo();` の foo();、`{ ... }`)を1つの Flow として読む。 */
  private parseBody(pos: number, end: number): { flow: Flow; next: number } {
    this.tick();
    const q = this.skip(pos, end);
    if (this.m[q] === ";") return { flow: EMPTY_FLOW, next: q + 1 }; // 空文
    const p = this.peek(q, end, false);
    if (p.kind === "end" || p.kind === "stop") return { flow: EMPTY_FLOW, next: end };
    if (p.kind === "block" || p.kind === "control") return this.parseControl(p, end);
    const s = this.scanSimple(p.pos, end);
    const label = this.text(p.pos, s.stmtEnd);
    const range = this.range(p.pos, s.stmtEnd);
    const flow = p.kind === "terminal" ? this.b.terminal(label, range) : this.b.process(label, range);
    return { flow, next: Math.max(s.next, p.pos + 1) };
  }

  private parseControl(p: { kind: string; pos: number; word?: string }, end: number): { flow: Flow; next: number } {
    if (p.kind === "block") {
      const close = matchBracket(this.m, p.pos, "{", "}");
      const stop = close < 0 || close > end ? end : close;
      const inner = this.parseSequence(p.pos + 1, stop, false);
      return { flow: inner.flow, next: stop >= end && close < 0 ? end : stop + 1 };
    }
    switch (p.word) {
      case "if":
        return this.parseIf(p.pos, end, "if");
      case "for":
      case "foreach":
      case "while":
        return this.parseLoop(p.pos, end, p.word);
      case "do":
        return this.parseDo(p.pos, end);
      case "switch":
        return this.parseSwitch(p.pos, end);
      case "try":
        return this.parseTry(p.pos, end);
      case "else":
        return { flow: EMPTY_FLOW, next: p.pos + 4 }; // 対応する if のない else(読み取りのずれ)。語だけ読み飛ばす
      default: {
        // using (...) { } / lock (...) { } / checked { }: 本体を、そのまま流れに溶かす
        const word = p.word ?? "";
        let q = this.skip(p.pos + word.length, end);
        if (this.m[q] === "(") {
          const close = matchBracket(this.m, q, "(", ")");
          if (close < 0 || close >= end) break;
          q = close + 1;
        }
        return this.parseBody(q, end);
      }
    }
    return this.simpleAsFlow(p.pos, end);
  }

  private simpleAsFlow(pos: number, end: number): { flow: Flow; next: number } {
    const s = this.scanSimple(pos, end);
    return { flow: this.b.process(this.text(pos, s.stmtEnd), this.range(pos, s.stmtEnd)), next: Math.max(s.next, pos + 1) };
  }

  // ------------------------------------------------------------------ 条件式

  /**
   * キーワードの直後から、条件式と本体の開始位置を読む。
   *   (cond) body      … C 系
   *   cond { body }    … Go / Swift / Rust のように括弧を付けない書き方
   */
  private readCondition(pos: number, end: number): { cond: string; condEnd: number; bodyStart: number } | null {
    const m = this.m;
    const p = this.skip(pos, end);
    if (m[p] === "(") {
      const close = matchBracket(m, p, "(", ")");
      if (close < 0 || close >= end) return null;
      const q = this.skip(close + 1, end);
      const ch = m[q];
      // `if (a) && (b) {` のように、閉じ括弧の後ろが演算子なら、括弧は条件の一部(括弧なしの書き方)
      const continues = ch !== undefined && "&|=!<>+*%^?:.,".includes(ch);
      if (!continues) return { cond: this.text(p + 1, close, MAX_CONDITION), condEnd: close + 1, bodyStart: close + 1 };
    }
    let depth = 0;
    for (let i = p; i < end; i++) {
      const c = m[i];
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === "{" && depth <= 0) return { cond: this.text(p, i, MAX_CONDITION), condEnd: i, bodyStart: i };
      else if (c === "}" && depth <= 0) break; // 本体の手前で閉じ括弧が来たら、条件ではない(読み取りのずれ)
    }
    return null;
  }

  // ------------------------------------------------------------------ if / 繰り返し / switch / try

  private parseIf(pos: number, end: number, label: "if" | "else if"): { flow: Flow; next: number } {
    const c = this.readCondition(pos + 2, end);
    if (!c) return this.simpleAsFlow(pos, end);

    const id = this.b.decision(`${label} (${c.cond})`, this.range(pos, c.condEnd));
    const thenPart = this.parseBody(c.bodyStart, end);
    let next = thenPart.next;
    let elseFlow: Flow | undefined;

    const q = this.skip(next, end);
    if (q < end && this.word(q) === "else") {
      const r = this.skip(q + 4, end);
      if (this.word(r) === "if") {
        const nested = this.parseIf(r, end, "else if");
        elseFlow = nested.flow;
        next = nested.next;
      } else {
        const body = this.parseBody(q + 4, end);
        elseFlow = body.flow;
        next = body.next;
      }
    }
    return { flow: this.b.completeBranch(id, thenPart.flow, elseFlow), next };
  }

  private parseLoop(pos: number, end: number, keyword: string): { flow: Flow; next: number } {
    let from = this.skip(pos + keyword.length, end);
    if (this.word(from) === "await") from = this.skip(from + 5, end); // for await (...)
    const c = this.readCondition(from, end);
    if (!c) return this.simpleAsFlow(pos, end);

    const id = this.b.loopNode(`${keyword} (${c.cond})`, this.range(pos, c.condEnd));
    const body = this.parseBody(c.bodyStart, end);
    return { flow: this.b.completeLoop(id, body.flow), next: body.next };
  }

  private parseDo(pos: number, end: number): { flow: Flow; next: number } {
    const body = this.parseBody(pos + 2, end);
    const q = this.skip(body.next, end);
    if (this.word(q) === "while") {
      const c = this.readCondition(q + 5, end);
      if (c) {
        const after = this.skipEmpty(c.condEnd, c.condEnd + 1 > end ? end : c.condEnd + 1); // 末尾の ;
        return { flow: this.b.doWhile(body.flow, `do/while (${c.cond})`, this.range(q, c.condEnd)), next: Math.max(after, c.condEnd) };
      }
    }
    return { flow: this.b.doWhile(body.flow, "do/while ()", this.range(pos, pos + 2)), next: body.next };
  }

  private parseSwitch(pos: number, end: number): { flow: Flow; next: number } {
    const c = this.readCondition(pos + 6, end);
    const open = c ? this.skip(c.condEnd, end) : -1;
    if (!c || this.m[open] !== "{") return this.simpleAsFlow(pos, end);
    const found = matchBracket(this.m, open, "{", "}");
    const close = found < 0 || found > end ? end : found;

    const id = this.b.switchNode(`switch (${c.cond})`, this.range(pos, c.condEnd));
    const cases: Flow[] = [];
    let hasDefault = false;
    let emptyTail = false;

    let p = open + 1;
    while (p < close) {
      this.tick();
      p = this.skipEmpty(p, close);
      if (p >= close) break;
      const w = this.word(p);
      const isDefault = w === "default" && this.isDefaultLabel(p + 7, close);
      if (w !== "case" && !isDefault) {
        // case/default 以外が来た(読み取りのずれ)。1文読み飛ばして進める
        p = Math.max(this.scanSimple(p, close).next, p + 1);
        continue;
      }
      if (isDefault) hasDefault = true;
      const bodyStart = this.labelEnd(p + w.length, close);
      const r = this.parseSequence(bodyStart, close, true);
      p = Math.max(r.next, p + 1);
      if (r.flow.entryId) {
        cases.push(r.flow);
      } else {
        // 本体のない case は、直後の case とまとめる(`case 1: case 2: ...`)。最後の1つなら、そこで switch を抜ける
        const q = this.skipEmpty(p, close);
        const nw = this.word(q);
        const groupedWithNext = q < close && (nw === "case" || (nw === "default" && this.isDefaultLabel(q + 7, close)));
        if (!groupedWithNext) emptyTail = true;
      }
    }
    return { flow: this.b.completeSwitch(id, cases, !hasDefault || emptyTail), next: found < 0 ? end : found + 1 };
  }

  /** `case X:` / `default:` / `case X ->` のラベルの終わり(本体の開始位置)。 */
  private labelEnd(from: number, end: number): number {
    const m = this.m;
    let depth = 0;
    for (let i = from; i < end; i++) {
      const c = m[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (depth === 0 && c === ":" && m[i + 1] !== ":") return i + 1;
      else if (depth === 0 && c === "-" && m[i + 1] === ">") return i + 2;
    }
    return end;
  }

  private parseTry(pos: number, end: number): { flow: Flow; next: number } {
    let p = this.skip(pos + 3, end);
    if (this.m[p] === "(") {
      // try (resources) — Java
      const close = matchBracket(this.m, p, "(", ")");
      if (close >= 0 && close < end) p = close + 1;
    }
    const body = this.parseBody(p, end);
    let next = body.next;

    const handlers: Flow[] = [];
    let finallyPart: { flow: Flow; mark: ReturnType<FlowBuilder["mark"]> } | undefined;
    for (let guard = 0; guard < 64; guard++) {
      const q = this.skip(next, end);
      const w = q < end ? this.word(q) : "";
      if (w === "catch") {
        let headerEnd = q + 5;
        const open = this.skip(headerEnd, end);
        if (this.m[open] === "(") {
          const close = matchBracket(this.m, open, "(", ")");
          if (close >= 0 && close < end) headerEnd = close + 1;
        }
        const r = this.skip(headerEnd, end);
        if (this.word(r) === "when") {
          const o2 = this.skip(r + 4, end);
          if (this.m[o2] === "(") {
            const c2 = matchBracket(this.m, o2, "(", ")");
            if (c2 >= 0 && c2 < end) headerEnd = c2 + 1;
          }
        }
        const seq = this.b.sequence();
        seq.add(this.b.process(this.text(q, headerEnd), this.range(q, headerEnd)));
        const handler = this.parseBody(headerEnd, end);
        seq.add(handler.flow);
        handlers.push(seq.done());
        next = handler.next;
      } else if (w === "finally") {
        const mark = this.b.mark();
        const part = this.parseBody(q + 7, end);
        finallyPart = { flow: part.flow, mark };
        next = part.next;
        break;
      } else {
        break;
      }
    }

    let flow = this.b.tryCatch(body.flow, handlers);
    if (finallyPart?.flow.entryId) {
      if (flow.exits.length === 0) {
        this.b.rollback(finallyPart.mark); // すべての経路が return/throw で終わるなら、finally へ繋ぐ先がない
      } else {
        const seq = this.b.sequence();
        seq.add(flow);
        seq.add(finallyPart.flow);
        flow = seq.done();
      }
    }
    return { flow, next };
  }
}

/**
 * 対象範囲のテキストからFlowchartNode/Edgeを組み立てる。
 * @param text 対象範囲のソーステキスト(関数本体を含む)
 * @param startLine textの1行目に対応する元ファイル上の行番号(0-based)
 * @param functionLabel start/endノードに表示する関数名相当のラベル
 */
export function scanControlFlowHeuristic(
  text: string,
  startLine: number,
  functionLabel: string,
): { nodes: FlowchartNode[]; edges: FlowchartEdge[] } {
  return new Scanner(text, startLine).run(functionLabel);
}
