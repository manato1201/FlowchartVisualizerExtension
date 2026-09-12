import type {
  FlowchartIR,
  FlowchartNode,
  NodeKind,
} from "../flowchart-ir/schema";

/**
 * FlowchartIR → 魔方陣(MagicCircleComposition)へのエンタメ用エミッター。
 * 仕様の正本は同ディレクトリの `MAGIC_CIRCLE_MAPPING_SPEC.md`。
 *
 * 出力型は `MagicCircleGenerator/src/core/schema.ts` の `MagicCircleComposition`/`Ring` の
 * ミラーである(vs-extension/FlowchartExtractor/FlowchartIR.cs や
 * rider-plugin/.../FlowchartIr.kt が core/flowchart-ir/schema.ts をミラーしているのと同じ方針)。
 * MagicCircleGenerator側の実スキーマが正であり、変更した場合はここも追従させること。
 */

// ---- MagicCircleGenerator/src/core/schema.ts のミラー ----
type ElementType =
  | "text_band"
  | "glyph_repeat"
  | "geometric_pattern"
  | "core_symbol"
  | "satellite_circle";

interface Ring {
  ringId: string;
  radius: number;
  elementType: ElementType;
  symmetryOrder: number;
  rotation: number;
  sourceAssetRef?: string;
  proceduralParams?: Record<string, unknown>;
  color?: string;
}

interface MagicCircleComposition {
  compositionId: string;
  seed: number;
  stylePreset?: string;
  rings: Ring[];
  effectStack: unknown[];
  formatVersion: string;
}

const MAGIC_CIRCLE_FORMAT_VERSION = "1.0.0";

// ---- 仕様3節: ノード種別 → グリフ資産 ----
const GLYPH_BY_KIND: Record<NodeKind, string> = {
  start: "core_star_pentagram",
  end: "core_star_pentagram",
  process: "rune_alchemy_01",
  decision: "gem_hatched_04",
  loop: "gem_mandala_03",
  ioOperation: "gear_symbol",
};

// 仕様4節: generateHuePalette(6, seed) を割り当てる固定順
const KIND_ORDER: NodeKind[] = [
  "start",
  "end",
  "process",
  "decision",
  "loop",
  "ioOperation",
];

// 仕様1.3節
const BASE_RADIUS = 26;
const RING_GAP = 34;
const BOUNDARY_GAP = 40;

export type ThreadStyle = "trueEdge" | "falseEdge" | "plainEdge" | "loopBack";

export interface ThreadSpec {
  r1: number;
  a1: number;
  r2: number;
  a2: number;
  style: ThreadStyle;
}

interface FlowchartEdgeLike {
  from: string;
  to: string;
  label?: string;
}

/** 仕様1.1節: DFS白/灰/黒法による戻りエッジ(逆辺)検出。 */
function detectBackEdges(
  nodeIds: string[],
  edges: FlowchartEdgeLike[],
  startId: string,
): Set<FlowchartEdgeLike> {
  const adjacency = new Map<string, FlowchartEdgeLike[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const e of edges) adjacency.get(e.from)?.push(e);

  const color = new Map<string, "white" | "gray" | "black">();
  for (const id of nodeIds) color.set(id, "white");
  const backEdges = new Set<FlowchartEdgeLike>();

  const dfs = (u: string) => {
    color.set(u, "gray");
    for (const edge of adjacency.get(u) ?? []) {
      const v = edge.to;
      const c = color.get(v);
      if (c === "white") dfs(v);
      else if (c === "gray") backEdges.add(edge);
    }
    color.set(u, "black");
  };

  dfs(startId);
  // start から到達しない孤立ノードへの防御的処理
  for (const id of nodeIds) {
    if (color.get(id) === "white") dfs(id);
  }

  return backEdges;
}

/** 仕様1.2節: 逆辺を除いたDAG上でのKahn法トポロジカルソート + 最長路レイヤリング。 */
function computeLayers(
  nodeIds: string[],
  forwardEdges: FlowchartEdgeLike[],
  startId: string,
): Map<string, number> {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }
  for (const e of forwardEdges) {
    adjacency.get(e.from)?.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  const queue: string[] = nodeIds.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const topoOrder: string[] = [];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const u = queue.shift()!;
    if (visited.has(u)) continue;
    visited.add(u);
    topoOrder.push(u);
    for (const v of adjacency.get(u) ?? []) {
      inDegree.set(v, (inDegree.get(v) ?? 0) - 1);
      if ((inDegree.get(v) ?? 0) <= 0 && !visited.has(v)) queue.push(v);
    }
  }
  // Kahn法で処理しきれなかったノード(理論上は逆辺除去済みなので無いはずだが、防御的に追加)
  for (const id of nodeIds) {
    if (!visited.has(id)) topoOrder.push(id);
  }

  const layer = new Map<string, number>();
  layer.set(startId, 0);
  for (const u of topoOrder) {
    const uLayer = layer.get(u) ?? 0;
    for (const v of adjacency.get(u) ?? []) {
      layer.set(v, Math.max(layer.get(v) ?? 0, uLayer + 1));
    }
  }
  for (const id of nodeIds) {
    if (!layer.has(id)) layer.set(id, 0);
  }
  return layer;
}

/** FNV-1a 32bit。generatedAt(実行時刻)を含めず、構造のみからシードを決定論的に導出する。 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function deriveSeed(ir: FlowchartIR): number {
  const nodesPart = ir.nodes.map((n) => `${n.kind}:${n.label}`).join(",");
  const edgesPart = ir.edges
    .map((e) => `${e.from}>${e.to}:${e.label ?? ""}`)
    .join(",");
  return fnv1a32(`${ir.sourceFile}|${nodesPart}|${edgesPart}`);
}

interface PlacedNode {
  node: FlowchartNode;
  layer: number;
  radius: number;
  angle: number;
}

/**
 * FlowchartIR を MagicCircleComposition(魔方陣レシピ)へ変換する。
 * `MAGIC_CIRCLE_MAPPING_SPEC.md` の1〜7節を実装したもの。決定論的(同じIRからは常に同じ出力)。
 */
export function emitMagicCircle(ir: FlowchartIR): MagicCircleComposition {
  const startNode = ir.nodes.find((n) => n.kind === "start");
  if (!startNode) {
    throw new Error(
      "FlowchartIR に start ノードがありません(魔方陣化には開始点が必須です)",
    );
  }

  const nodeIds = ir.nodes.map((n) => n.id);
  const backEdges = detectBackEdges(nodeIds, ir.edges, startNode.id);
  const forwardEdges = ir.edges.filter((e) => !backEdges.has(e));
  const layerById = computeLayers(nodeIds, forwardEdges, startNode.id);

  const maxLayer = Math.max(...Array.from(layerById.values()));
  const radiusOf = (layer: number) =>
    BASE_RADIUS + (maxLayer - layer) * RING_GAP;

  // 仕様2節: 層ごとにノードを id の数値順で安定ソートして角度を割り当てる
  const byLayer = new Map<number, FlowchartNode[]>();
  for (const node of ir.nodes) {
    const layer = layerById.get(node.id) ?? 0;
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer)!.push(node);
  }
  for (const nodes of byLayer.values()) {
    nodes.sort((a, b) => numericIdOf(a.id) - numericIdOf(b.id));
  }

  const placedById = new Map<string, PlacedNode>();
  for (const [layer, nodes] of byLayer) {
    const rotationOffset = layer * (Math.PI / 12);
    const count = nodes.length;
    const radius = radiusOf(layer);
    nodes.forEach((node, index) => {
      const angle = rotationOffset + (2 * Math.PI * index) / count;
      placedById.set(node.id, { node, layer, radius, angle });
    });
  }

  const seed = deriveSeed(ir);

  // 仕様4節: 配色は emitter 側で計算しない。MagicCircleGenerator/src/core/palette.ts の
  // generateHuePalette(seedrandomベース)を描画側(flowchart_nodesディスパッチケース)が
  // ring.proceduralParams.seed から都度呼び出すことで、色決定ロジックを単一実装(palette.ts)に
  // 一元化する(このファイルにPRNGを二重実装しない)。KIND_ORDER がその際のインデックス対応表。

  // 仕様6節: ノードリング(層の浅い順=外側から)
  const nodeRings: Ring[] = Array.from(byLayer.keys())
    .sort((a, b) => a - b)
    .map((layer) => {
      const nodes = byLayer.get(layer)!;
      const rotationOffset = layer * (Math.PI / 12);
      return {
        ringId: `flowchart_layer_${layer}`,
        radius: radiusOf(layer),
        elementType: "glyph_repeat",
        symmetryOrder: Math.max(1, nodes.length),
        rotation: rotationOffset,
        sourceAssetRef: "flowchart_nodes",
        proceduralParams: {
          seed,
          kindOrder: KIND_ORDER,
          nodes: nodes.map((n) => {
            const placed = placedById.get(n.id)!;
            return {
              nodeId: n.id,
              kind: n.kind,
              assetId: GLYPH_BY_KIND[n.kind],
              angle: placed.angle,
              title: n.label,
            };
          }),
        },
      };
    });

  // 仕様5節: スレッドリング(全エッジをまとめた1つ)
  const threads: ThreadSpec[] = ir.edges.map((edge) => {
    const from = placedById.get(edge.from)!;
    const to = placedById.get(edge.to)!;
    const isBack = backEdges.has(edge);
    const style: ThreadStyle = isBack
      ? "loopBack"
      : edge.label === "true"
        ? "trueEdge"
        : edge.label === "false"
          ? "falseEdge"
          : "plainEdge";
    return {
      r1: from.radius,
      a1: from.angle,
      r2: to.radius,
      a2: to.angle,
      style,
    };
  });

  const threadRing: Ring = {
    ringId: "flowchart_threads",
    radius: 0, // 仕様6節: このケースに限り未使用のプレースホルダ(実座標はproceduralParams.threadsが個別に持つ)
    elementType: "geometric_pattern",
    symmetryOrder: 1,
    rotation: 0,
    sourceAssetRef: "flowchart_threads",
    proceduralParams: { threads },
  };

  // 仕様6節: 装飾用の外周リング
  const maxRadius = Math.max(
    ...Array.from(placedById.values()).map((p) => p.radius),
  );
  const boundaryRing: Ring = {
    ringId: "flowchart_boundary",
    radius: maxRadius + BOUNDARY_GAP,
    elementType: "satellite_circle",
    symmetryOrder: 8,
    rotation: 0,
    sourceAssetRef: "ring_ornate_01",
  };

  return {
    compositionId: `mc_flowchart_${seed.toString(36)}`,
    seed,
    stylePreset: "flowchart_sigil",
    rings: [threadRing, ...nodeRings, boundaryRing],
    effectStack: [],
    formatVersion: MAGIC_CIRCLE_FORMAT_VERSION,
  };
}

function numericIdOf(id: string): number {
  const match = /\d+/.exec(id);
  return match ? Number(match[0]) : 0;
}
