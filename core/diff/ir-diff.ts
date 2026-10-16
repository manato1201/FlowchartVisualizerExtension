import type {
  DiffStatus,
  FlowchartEdge,
  FlowchartIR,
  FlowchartNode,
} from "../flowchart-ir/schema";

/**
 * 同じ関数の「変更前IR」と「変更後IR」を比べ、追加 / 削除 / 変更のノード・エッジに色付け用の
 * `diff` を付けた1つのIR(マージ済み)を返す(X3: PR レビュー用のフロー差分)。
 *
 * 誤検出を避けるための方針(検証項目「変更のない関数が『変更あり』と誤表示されない」):
 *   - 比較キーは `kind` と空白を畳んだ `label` だけ。**行番号(sourceRange)は比較に使わない**
 *     (上に1行足されて全体がずれただけの関数を「変更あり」にしないため)。
 *   - ノード列は LCS(最長共通部分列)で対応づける。順序が保たれた同一ノードは unchanged。
 *   - LCS で対応しなかった区間の中で、同じ kind のものは「削除+追加」ではなく「変更」と見なす。
 *   - ノードIDは両版で別採番のため比較に使わない。エッジは「対応づけ後のID」で比較する。
 */

export interface IRDiffSummary {
  nodesAdded: number;
  nodesRemoved: number;
  nodesChanged: number;
  nodesUnchanged: number;
  edgesAdded: number;
  edgesRemoved: number;
}

export interface IRDiffResult {
  /** 差分状態付きのIR。削除ノードは id に `rm_` を付けて共存させる */
  ir: FlowchartIR;
  summary: IRDiffSummary;
  hasChanges: boolean;
}

const REMOVED_PREFIX = "rm_";

function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim();
}

function nodeKey(n: FlowchartNode): string {
  return `${n.kind}|${normalizeLabel(n.label)}`;
}

/** LCS で対応するインデックス対 [beforeIdx, afterIdx] を昇順で返す。 */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

export function diffIR(before: FlowchartIR, after: FlowchartIR): IRDiffResult {
  const pairs = lcsPairs(before.nodes.map(nodeKey), after.nodes.map(nodeKey));

  // before.id -> マージ後のID(対応するafterのID、または rm_<id>)
  const mergedIdOfBefore = new Map<string, string>();
  const mergedNodes: FlowchartNode[] = [];

  const pushRemoved = (n: FlowchartNode) => {
    const id = REMOVED_PREFIX + n.id;
    mergedIdOfBefore.set(n.id, id);
    mergedNodes.push({ ...n, id, diff: "removed" });
  };
  const pushAfter = (
    n: FlowchartNode,
    diff: DiffStatus,
    previousLabel?: string,
  ) => {
    const node: FlowchartNode = { ...n, diff };
    if (previousLabel !== undefined) node.previousLabel = previousLabel;
    mergedNodes.push(node);
  };

  // アンカー(LCSで対応した対)の間にある「未対応区間」を順に処理する
  const anchors: Array<[number, number]> = [
    ...pairs,
    [before.nodes.length, after.nodes.length],
  ];
  let bi = 0;
  let ai = 0;
  for (const [pb, pa] of anchors) {
    const gapBefore = before.nodes.slice(bi, pb);
    const gapAfter = after.nodes.slice(ai, pa);

    const consumed = new Set<number>();
    const afterStatus = new Map<
      number,
      { diff: DiffStatus; prev?: FlowchartNode }
    >();
    gapAfter.forEach((an, idx) => {
      const hit = gapBefore.findIndex(
        (bn, k) => !consumed.has(k) && bn.kind === an.kind,
      );
      if (hit >= 0) {
        consumed.add(hit);
        mergedIdOfBefore.set(gapBefore[hit].id, an.id);
        afterStatus.set(idx, { diff: "changed", prev: gapBefore[hit] });
      } else {
        afterStatus.set(idx, { diff: "added" });
      }
    });
    gapBefore.forEach((bn, k) => {
      if (!consumed.has(k)) pushRemoved(bn);
    });
    gapAfter.forEach((an, idx) => {
      const st = afterStatus.get(idx)!;
      pushAfter(an, st.diff, st.prev ? st.prev.label : undefined);
    });

    if (pb < before.nodes.length) {
      mergedIdOfBefore.set(before.nodes[pb].id, after.nodes[pa].id);
      pushAfter(after.nodes[pa], "unchanged");
    }
    bi = pb + 1;
    ai = pa + 1;
  }

  // ---- エッジ: 対応づけ後のIDで比較する ----
  const edgeKey = (from: string, to: string, label?: string) =>
    `${from}>${to}>${label ?? ""}`;
  const afterEdgeKeys = new Set(
    after.edges.map((e) => edgeKey(e.from, e.to, e.label)),
  );
  const beforeMapped: FlowchartEdge[] = before.edges.map((e) => ({
    ...e,
    from: mergedIdOfBefore.get(e.from) ?? REMOVED_PREFIX + e.from,
    to: mergedIdOfBefore.get(e.to) ?? REMOVED_PREFIX + e.to,
  }));
  const beforeEdgeKeys = new Set(
    beforeMapped.map((e) => edgeKey(e.from, e.to, e.label)),
  );

  const mergedEdges: FlowchartEdge[] = [];
  for (const e of after.edges) {
    const inBefore = beforeEdgeKeys.has(edgeKey(e.from, e.to, e.label));
    mergedEdges.push({ ...e, diff: inBefore ? "unchanged" : "added" });
  }
  for (const e of beforeMapped) {
    if (!afterEdgeKeys.has(edgeKey(e.from, e.to, e.label))) {
      mergedEdges.push({ ...e, diff: "removed" });
    }
  }

  const count = (d: DiffStatus) =>
    mergedNodes.filter((n) => n.diff === d).length;
  const countE = (d: DiffStatus) =>
    mergedEdges.filter((e) => e.diff === d).length;
  const summary: IRDiffSummary = {
    nodesAdded: count("added"),
    nodesRemoved: count("removed"),
    nodesChanged: count("changed"),
    nodesUnchanged: count("unchanged"),
    edgesAdded: countE("added"),
    edgesRemoved: countE("removed"),
  };
  const hasChanges =
    summary.nodesAdded +
      summary.nodesRemoved +
      summary.nodesChanged +
      summary.edgesAdded +
      summary.edgesRemoved >
    0;

  return {
    ir: {
      nodes: mergedNodes,
      edges: mergedEdges,
      sourceFile: after.sourceFile,
      generatedAt: after.generatedAt,
    },
    summary,
    hasChanges,
  };
}

/** 関数が変更前に存在しなかった場合(新規関数): すべて追加として扱う。 */
export function allAdded(after: FlowchartIR): IRDiffResult {
  const nodes = after.nodes.map((n) => ({ ...n, diff: "added" as DiffStatus }));
  const edges = after.edges.map((e) => ({ ...e, diff: "added" as DiffStatus }));
  return {
    ir: { ...after, nodes, edges },
    summary: {
      nodesAdded: nodes.length,
      nodesRemoved: 0,
      nodesChanged: 0,
      nodesUnchanged: 0,
      edgesAdded: edges.length,
      edgesRemoved: 0,
    },
    hasChanges: nodes.length > 0,
  };
}
