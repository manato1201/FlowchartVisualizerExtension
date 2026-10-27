import type {
  EdgeLabel,
  FlowchartEdge,
  FlowchartNode,
  NodeKind,
  SourceRange,
} from "./schema";

/**
 * 構文木(またはソーステキスト)の読み取り側から、FlowchartIR を組み立てるための共通部品。
 *
 * 読み取り側(vscode-extension の controlFlowScanner / tree-sitter ウォーカー)は
 * 「どの構文か」を判断して、ここのメソッドを呼ぶだけにする。エッジのラベル(true/false)・
 * 戻りエッジ・`return`/`throw` の終端・到達不能コードの除去といった**意味づけは、ここ1か所だけ**にある
 * (以前は2つの実装がそれぞれ別の規則で組み立てていて、結果が食い違っていた)。
 *
 * ホスト固有の型は一切参照しない(アンチパターン: IR層より上へホスト固有型を漏らさない)。
 */

/** ある流れから次へ繋ぐ口。`label` は分岐から出る線の true/false。 */
export interface Exit {
  id: string;
  label?: EdgeLabel;
}

/**
 * 文(またはその並び)を、グラフの部品として見たもの。
 *   entryId   : 入口のノード。空の文(何も出さない)は undefined
 *   exits     : 次の文へ繋ぐ口。空なら「ここから先へは進まない」(return/throw で終わる)
 *   terminals : return/throw のノード。関数の End へ繋ぐ
 */
export interface Flow {
  entryId?: string;
  exits: Exit[];
  terminals: string[];
}

export const EMPTY_FLOW: Flow = { exits: [], terminals: [] };

/** builder の状態の巻き戻し位置(到達不能コードを読んだあとで、作ったノードを取り消すために使う)。 */
export interface Mark {
  nodes: number;
  counter: number;
}

export class FlowBuilder {
  readonly nodes: FlowchartNode[] = [];
  readonly edges: FlowchartEdge[] = [];
  private counter = 0;

  private newNode(kind: NodeKind, label: string, range: SourceRange): string {
    const id = `n${++this.counter}`;
    this.nodes.push({ id, kind, label, sourceRange: range });
    return id;
  }

  private connect(from: string, to: string, label?: EdgeLabel): void {
    const e: FlowchartEdge = { from, to };
    if (label) e.label = label;
    this.edges.push(e);
  }

  mark(): Mark {
    return { nodes: this.nodes.length, counter: this.counter };
  }

  /**
   * mark() 以降に作ったノードを取り消す。ID は連番のまま保たれる。
   * 取り消したノードに触れる線だけを消す(取り消し後に、残るノード同士へ引いた線は残す)。
   * 以前は「エッジ数で切り詰める」方式で、finally を取り消すときに、その後で足した
   * try→catch の線まで消えて、catch のノードが孤立していた。
   */
  rollback(m: Mark): void {
    const removed = new Set(this.nodes.slice(m.nodes).map((n) => n.id));
    this.nodes.length = m.nodes;
    this.counter = m.counter;
    if (removed.size === 0) return;
    let w = 0;
    for (const e of this.edges) {
      if (!removed.has(e.from) && !removed.has(e.to)) this.edges[w++] = e;
    }
    this.edges.length = w;
  }

  start(label: string, range: SourceRange): string {
    return this.newNode("start", label, range);
  }

  // ---- 単純な文 ----

  process(label: string, range: SourceRange): Flow {
    const id = this.newNode("process", label, range);
    return { entryId: id, exits: [{ id }], terminals: [] };
  }

  /** return / throw: ここから先へは進まず、関数の終わりへ向かう。 */
  terminal(label: string, range: SourceRange): Flow {
    const id = this.newNode("process", label, range);
    return { entryId: id, exits: [], terminals: [id] };
  }

  // ---- 分岐(if / else if / else)。ノードを先に作り(ID を出現順にするため)、本体を読んでから完成させる ----

  decision(label: string, range: SourceRange): string {
    return this.newNode("decision", label, range);
  }

  completeBranch(id: string, thenFlow: Flow, elseFlow?: Flow): Flow {
    const exits: Exit[] = [];
    const terminals: string[] = [];
    const arm = (flow: Flow | undefined, label: "true" | "false") => {
      if (flow?.entryId) {
        this.connect(id, flow.entryId, label);
        exits.push(...flow.exits);
        terminals.push(...flow.terminals);
      } else {
        // 空の本体 / else なし: 条件のノードから、そのラベルのまま次へ進む
        exits.push({ id, label });
      }
    };
    arm(thenFlow, "true");
    arm(elseFlow, "false");
    return { entryId: id, exits, terminals };
  }

  // ---- 繰り返し(for / foreach / while) ----

  loopNode(label: string, range: SourceRange): string {
    return this.newNode("loop", label, range);
  }

  completeLoop(id: string, body: Flow): Flow {
    if (body.entryId) {
      this.connect(id, body.entryId, "true");
      for (const e of body.exits) this.connect(e.id, id, e.label); // 本体の終わり → 条件へ戻る
    }
    return {
      entryId: id,
      exits: [{ id, label: "false" }],
      terminals: body.terminals,
    };
  }

  /** do { body } while (cond): 本体が先。条件が true なら本体の先頭へ戻る。 */
  doWhile(body: Flow, label: string, range: SourceRange): Flow {
    // 本体のすべての経路が return/throw で終わるなら、条件には到達しない(誰からも繋がらないノードを作らない)
    if (body.entryId && body.exits.length === 0) return body;
    const id = this.newNode("loop", label, range);
    if (body.entryId) {
      for (const e of body.exits) this.connect(e.id, id, e.label);
      this.connect(id, body.entryId, "true");
    }
    return {
      entryId: body.entryId ?? id,
      exits: [{ id, label: "false" }],
      terminals: body.terminals,
    };
  }

  // ---- 多分岐(switch) ----

  switchNode(label: string, range: SourceRange): string {
    return this.newNode("decision", label, range);
  }

  /**
   * @param cases      本体のある case(空の case は呼び出し側でまとめる)
   * @param falls      どの case にも入らない / 空の case で抜ける経路があるか(default がなければ true)
   */
  completeSwitch(id: string, cases: Flow[], falls: boolean): Flow {
    const exits: Exit[] = [];
    const terminals: string[] = [];
    for (const c of cases) {
      if (!c.entryId) continue;
      this.connect(id, c.entryId, ""); // 辺のラベルは true/false/空 のみ(スキーマ)。case の値は出さない
      exits.push(...c.exits);
      terminals.push(...c.terminals);
    }
    if (falls) exits.push({ id });
    return { entryId: id, exits, terminals };
  }

  // ---- 例外(try / catch) ----

  /**
   * try の本文と catch の並びをまとめる。catch へは本文の先頭から線を1本引き(例外が起きうる経路)、
   * 出口は本文と各 catch の和集合にする。finally は呼び出し側が、この Flow の後ろへ並べる。
   */
  tryCatch(body: Flow, handlers: Flow[]): Flow {
    const exits = [...body.exits];
    const terminals = [...body.terminals];
    let entry = body.entryId;
    for (const h of handlers) {
      if (!h.entryId) continue;
      if (entry) this.connect(entry, h.entryId);
      else entry = h.entryId;
      exits.push(...h.exits);
      terminals.push(...h.terminals);
    }
    return { entryId: entry, exits, terminals };
  }

  // ---- 並び ----

  sequence(): Seq {
    return new Seq(this);
  }

  /** 関数全体を組み立てて、{nodes, edges} を完成させる。`body` の出口と return/throw を End へ繋ぐ。 */
  finish(
    startId: string,
    body: Flow,
    endLabel: string,
    endRange: SourceRange,
  ): { nodes: FlowchartNode[]; edges: FlowchartEdge[] } {
    const endId = this.newNode("end", endLabel, endRange);
    this.connect(startId, body.entryId ?? endId);
    for (const e of body.exits) this.connect(e.id, endId, e.label);
    for (const t of body.terminals) this.connect(t, endId);
    return { nodes: this.nodes, edges: this.edges };
  }

  /** (内部用)Seq から使う。 */
  link(from: Exit, to: string): void {
    this.connect(from.id, to, from.label);
  }
}

/**
 * 文を順に足していく並び。`dead` になったら(直前までが return/throw で終わっていたら)、
 * それ以降の文は到達不能なので、読み取り側は読み飛ばして構わない。
 */
export class Seq {
  private entryId?: string;
  private tails: Exit[] = [];
  private readonly terminals: string[] = [];
  private started = false;

  constructor(private readonly b: FlowBuilder) {}

  /** 到達不能か(何かを足したうえで、先へ進む口が1つも無い)。 */
  get dead(): boolean {
    return this.started && this.tails.length === 0;
  }

  add(flow: Flow): void {
    if (this.dead || !flow.entryId) return;
    if (!this.started) {
      this.entryId = flow.entryId;
      this.started = true;
    } else {
      for (const t of this.tails) this.b.link(t, flow.entryId);
    }
    this.tails = flow.exits;
    this.terminals.push(...flow.terminals);
  }

  done(): Flow {
    return {
      entryId: this.entryId,
      exits: this.tails,
      terminals: this.terminals,
    };
  }
}
