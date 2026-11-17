import type {
  EdgeLabel,
  FlowchartEdge,
  FlowchartIR,
  FlowchartNode,
  NodeKind,
} from "./schema";
import { emitMermaid } from "../render/mermaid-emitter";

/**
 * 外部(VLMAutoReplayTool・ローカル LLM など)から渡された「フローの JSON」を、検証して FlowchartIR にする入口。
 *
 * **入力は信用しない**(LLM の出力は、間違いも、悪意のある文字列も含みうる)。次を守る:
 *   - 未知のキー・型の違い・ID の重複・存在しないノードを指す線を、**どこが悪いかが分かる文面**で拒否する
 *   - ID は英数字と `_` だけ(Mermaid の構文に生で入るため。`end` などの予約語・`constructor` などの組み込み名も拒否)
 *   - ラベルは長さを制限し、制御文字・向きを変える文字を除く。Mermaid の特殊文字(& " < >)は
 *     emitMermaid がエンティティにし、HTML としては解釈されない(Webview は securityLevel: strict・htmlLabels: false)
 *   - 件数・入力の大きさに上限を付ける
 * JSON Schema は docs/reference/flowchart-ir.schema.json。実際の LLM 呼び出しはここにはない(JSON を受け取るだけ)。
 */

export const IR_INPUT_LIMITS = {
  /** 入力文字列の最大長(JSON のテキスト)。 */
  maxInputChars: 2_000_000,
  maxNodes: 2000,
  maxEdges: 6000,
  maxLabel: 200,
  maxIdLength: 40,
  maxSourceFile: 200,
  /** 返すエラーの最大件数(残りは「ほか N 件」にまとめる)。 */
  maxErrors: 20,
} as const;

const NODE_KINDS: readonly NodeKind[] = [
  "start",
  "end",
  "process",
  "decision",
  "loop",
  "ioOperation",
];
const EDGE_LABELS: readonly string[] = ["true", "false", ""];
const TOP_KEYS = ["nodes", "edges", "sourceFile", "generatedAt"];
const NODE_KEYS = ["id", "kind", "label", "sourceRange"];
const EDGE_KEYS = ["from", "to", "label"];
const RANGE_KEYS = ["startLine", "endLine"];

const ID_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
/** Mermaid の構文語。ノード ID にすると図が壊れる(`end` は特に有名)。小文字で比べる。 */
const RESERVED_IDS = new Set([
  "end",
  "graph",
  "flowchart",
  "subgraph",
  "style",
  "class",
  "classdef",
  "click",
  "linkstyle",
  "default",
  "direction",
  "call",
  "href",
  "interpolate",
]);

export type IrInputResult =
  | { ok: true; ir: FlowchartIR; warnings: string[] }
  | { ok: false; errors: string[] };

/** 検証に失敗した入力。`errors` に、直す手がかりになる文が並ぶ。 */
export class IrInputError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join("\n"));
    this.name = "IrInputError";
  }
}

class Errors {
  private readonly list: string[] = [];
  private extra = 0;
  add(msg: string): void {
    if (this.list.length < IR_INPUT_LIMITS.maxErrors) this.list.push(msg);
    else this.extra++;
  }
  get count(): number {
    return this.list.length + this.extra;
  }
  toArray(): string[] {
    return this.extra > 0
      ? [...this.list, `…ほか ${this.extra} 件のエラーがあります(先に上のものを直してください)`]
      : this.list.slice();
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function show(v: unknown): string {
  const t = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return t.length > 40 ? t.slice(0, 39) + "…" : t;
}

/** 許可されたキー以外を拒否する(タイプミスや、スキーマにない項目を黙って捨てない)。 */
function checkKeys(obj: Record<string, unknown>, allowed: string[], where: string, errors: Errors): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      errors.add(`${where}: 未知のキー ${JSON.stringify(k.slice(0, 40))} です(使えるのは ${allowed.join(" / ")})`);
    }
  }
}

/** 見た目をだます・図を崩す文字(ゼロ幅・向きを変える文字・行/段落区切り・BOM)のコードポイントの範囲。 */
const INVISIBLE_RANGES: Array<[number, number]> = [
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function isControlOrInvisible(cp: number): boolean {
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true; // 制御文字
  return INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/**
 * 表示用の文字列にそろえる: 制御文字・向きを変える文字・不可視文字を取り除き、空白を1つにして、長さを制限する。
 * 改行・タブは空白として扱う。返り値の `truncated` は、長さの制限で切ったか。
 */
export function sanitizeText(raw: string, max: number): { text: string; truncated: boolean } {
  let out = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) out += " ";
    else if (!isControlOrInvisible(cp)) out += ch;
  }
  const cleaned = out.replace(/\s+/g, " ").trim();
  const chars = Array.from(cleaned); // サロゲートペアの途中で切らない
  if (chars.length <= max) return { text: cleaned, truncated: false };
  return { text: chars.slice(0, max - 1).join("") + "…", truncated: true };
}

function parseNode(raw: unknown, i: number, ids: Set<string>, errors: Errors, warnings: string[]): FlowchartNode | null {
  const where = `nodes[${i}]`;
  if (!isPlainObject(raw)) {
    errors.add(`${where}: オブジェクトではありません(${show(raw)})`);
    return null;
  }
  checkKeys(raw, NODE_KEYS, where, errors);
  let ok = true;

  const id = raw.id;
  if (typeof id !== "string") {
    errors.add(`${where}.id: 文字列で指定してください(${show(id)})`);
    ok = false;
  } else if (id.length > IR_INPUT_LIMITS.maxIdLength || !ID_RE.test(id)) {
    errors.add(
      `${where}.id: ${show(id)} は使えません(英字で始まる英数字と _ だけ、${IR_INPUT_LIMITS.maxIdLength} 文字まで。例: "n1")`,
    );
    ok = false;
  } else if (RESERVED_IDS.has(id.toLowerCase()) || id in Object.prototype) {
    errors.add(`${where}.id: ${show(id)} は予約語のため使えません(Mermaid の構文語・組み込み名。例: "n1" のように)`);
    ok = false;
  } else if (ids.has(id)) {
    errors.add(`${where}.id: ID ${show(id)} が重複しています(ノードの ID は一意にしてください)`);
    ok = false;
  } else {
    ids.add(id);
  }

  const kind = raw.kind;
  if (typeof kind !== "string" || !NODE_KINDS.includes(kind as NodeKind)) {
    errors.add(`${where}.kind: ${show(kind)} は使えません(使えるのは ${NODE_KINDS.join(" / ")})`);
    ok = false;
  }

  let label = "";
  if (typeof raw.label !== "string") {
    errors.add(`${where}.label: 文字列で指定してください(${show(raw.label)})`);
    ok = false;
  } else {
    const s = sanitizeText(raw.label, IR_INPUT_LIMITS.maxLabel);
    label = s.text;
    if (label === "") {
      errors.add(`${where}.label: 空です(表示できる文字を入れてください)`);
      ok = false;
    }
    if (s.truncated) {
      warnings.push(`${where}.label: ${IR_INPUT_LIMITS.maxLabel} 文字を超えたため、切り詰めました`);
    }
  }

  let range = { startLine: 0, endLine: 0 };
  if (raw.sourceRange !== undefined) {
    const r = raw.sourceRange;
    const num = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000_000;
    if (!isPlainObject(r)) {
      errors.add(`${where}.sourceRange: {startLine, endLine} のオブジェクトで指定してください`);
      ok = false;
    } else {
      checkKeys(r, RANGE_KEYS, `${where}.sourceRange`, errors);
      if (!num(r.startLine) || !num(r.endLine) || r.endLine < r.startLine) {
        errors.add(`${where}.sourceRange: startLine / endLine は 0 以上の整数で、endLine ≥ startLine にしてください`);
        ok = false;
      } else {
        range = { startLine: r.startLine, endLine: r.endLine };
      }
    }
  }

  return ok ? { id: id as string, kind: kind as NodeKind, label, sourceRange: range } : null;
}

function parseEdge(raw: unknown, i: number, ids: Set<string>, errors: Errors): FlowchartEdge | null {
  const where = `edges[${i}]`;
  if (!isPlainObject(raw)) {
    errors.add(`${where}: オブジェクトではありません(${show(raw)})`);
    return null;
  }
  checkKeys(raw, EDGE_KEYS, where, errors);
  let ok = true;
  for (const end of ["from", "to"] as const) {
    const v = raw[end];
    if (typeof v !== "string") {
      errors.add(`${where}.${end}: ノードの ID(文字列)で指定してください(${show(v)})`);
      ok = false;
    } else if (!ids.has(v)) {
      errors.add(`${where}.${end}: ノード ${show(v)} は nodes にありません(存在しない端を指す線は描けません)`);
      ok = false;
    }
  }
  const label = raw.label;
  if (label !== undefined && (typeof label !== "string" || !EDGE_LABELS.includes(label))) {
    errors.add(`${where}.label: ${show(label)} は使えません(使えるのは "true" / "false" / 空。分岐の出口にだけ付けてください)`);
    ok = false;
  }
  if (!ok) return null;
  const e: FlowchartEdge = { from: raw.from as string, to: raw.to as string };
  if (label) e.label = label as EdgeLabel;
  return e;
}

/**
 * 外部から来た「フローの JSON」(文字列、またはパース済みのオブジェクト)を検証して FlowchartIR にする。
 * 失敗したら、直す手がかりになるエラーの一覧を返す(例外にはしない)。成功しても、気づいてほしい点は warnings に出す。
 */
export function parseFlowchartIRInput(input: unknown): IrInputResult {
  const errors = new Errors();
  const warnings: string[] = [];

  let value: unknown = input;
  if (typeof input === "string") {
    if (input.length > IR_INPUT_LIMITS.maxInputChars) {
      return { ok: false, errors: [`入力が大きすぎます(${IR_INPUT_LIMITS.maxInputChars} 文字まで)`] };
    }
    // LLM は JSON を ```json ... ``` で囲むことが多い。囲みだけ外す(中身の検証は同じ)
    const text = input.trim().replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "");
    try {
      value = JSON.parse(text);
    } catch (e) {
      return { ok: false, errors: [`JSON として読めません: ${(e as Error).message}`] };
    }
  }

  if (!isPlainObject(value)) {
    return { ok: false, errors: ["トップレベルは {nodes, edges} のオブジェクトにしてください"] };
  }
  checkKeys(value, TOP_KEYS, "(トップレベル)", errors);

  const rawNodes = value.nodes;
  const rawEdges = value.edges === undefined ? [] : value.edges;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    errors.add("nodes: 1 個以上のノードの配列が必要です");
  } else if (rawNodes.length > IR_INPUT_LIMITS.maxNodes) {
    errors.add(`nodes: ${rawNodes.length} 個は多すぎます(${IR_INPUT_LIMITS.maxNodes} 個まで)`);
  }
  if (!Array.isArray(rawEdges)) {
    errors.add("edges: 配列で指定してください");
  } else if (rawEdges.length > IR_INPUT_LIMITS.maxEdges) {
    errors.add(`edges: ${rawEdges.length} 本は多すぎます(${IR_INPUT_LIMITS.maxEdges} 本まで)`);
  }

  let sourceFile = "(IR)";
  if (value.sourceFile !== undefined) {
    if (typeof value.sourceFile !== "string") {
      errors.add("sourceFile: 文字列で指定してください");
    } else {
      const s = sanitizeText(value.sourceFile, IR_INPUT_LIMITS.maxSourceFile);
      if (s.text) sourceFile = s.text;
    }
  }
  let generatedAt = new Date().toISOString();
  if (value.generatedAt !== undefined) {
    if (typeof value.generatedAt !== "string" || value.generatedAt.length > 40 || Number.isNaN(Date.parse(value.generatedAt))) {
      errors.add("generatedAt: ISO 8601 の日時文字列で指定してください(省略可)");
    } else {
      generatedAt = value.generatedAt;
    }
  }

  // ここまでで、配列の大きさが不正なら、中身は読まない(巨大な入力を走査しない)
  if (errors.count > 0 && (!Array.isArray(rawNodes) || !Array.isArray(rawEdges) ||
      rawNodes.length > IR_INPUT_LIMITS.maxNodes || rawEdges.length > IR_INPUT_LIMITS.maxEdges)) {
    return { ok: false, errors: errors.toArray() };
  }

  const ids = new Set<string>();
  const nodes: FlowchartNode[] = [];
  (rawNodes as unknown[]).forEach((n, i) => {
    const node = parseNode(n, i, ids, errors, warnings);
    if (node) nodes.push(node);
  });
  const edges: FlowchartEdge[] = [];
  (rawEdges as unknown[]).forEach((e, i) => {
    const edge = parseEdge(e, i, ids, errors);
    if (edge) edges.push(edge);
  });

  if (errors.count > 0) return { ok: false, errors: errors.toArray() };

  const starts = nodes.filter((n) => n.kind === "start").length;
  if (starts === 0) warnings.push('kind が "start" のノードがありません(実行順の再生はできません)');
  else if (starts > 1) warnings.push(`kind が "start" のノードが ${starts} 個あります(1 個にしてください)`);

  return { ok: true, ir: { nodes, edges, sourceFile, generatedAt }, warnings };
}

/** 検証に通らなければ IrInputError を投げる版。 */
export function parseFlowchartIRInputOrThrow(input: unknown): { ir: FlowchartIR; warnings: string[] } {
  const r = parseFlowchartIRInput(input);
  if (!r.ok) throw new IrInputError(r.errors);
  return { ir: r.ir, warnings: r.warnings };
}

/** 「フローの JSON」→ Mermaid テキスト(既存のエミッターをそのまま使う)。検証に通らなければ IrInputError。 */
export function irInputToMermaid(input: unknown): string {
  return emitMermaid(parseFlowchartIRInputOrThrow(input).ir);
}
