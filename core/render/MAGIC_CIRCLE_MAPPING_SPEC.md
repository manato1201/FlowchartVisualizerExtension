# FlowchartIR → 魔方陣(MagicCircleComposition) マッピング仕様

**位置づけ**: `core/render/mermaid-emitter.ts`(FlowchartIR→Mermaidテキスト)と並ぶ、もう1つの
エミッター `core/render/magic-circle-emitter.ts` の仕様。**エンタメ用途**であり、Mermaid版が持つ
「制御フローを正確に読める」という実用目的とは異なる。可読性より視覚的な意味づけの一貫性を優先する。

参照した実装(この仕様はこれらの実コードを踏まえて書いている。憶測を含まない):

- `FlowchartVisualizerExtension/core/flowchart-ir/schema.ts`(入力: `FlowchartIR`)
- `MagicCircleGenerator/src/core/schema.ts`(出力: `MagicCircleComposition`/`Ring`)
- `MagicCircleGenerator/src/core/ringCompositor.ts`(`renderRing`のディスパッチ規約)
- `MagicCircleGenerator/src/core/proceduralGenerators.ts`(既存7ジェネレーターファミリー)
- `MagicCircleGenerator/src/core/palette.ts`(`generateHuePalette`)
- `MagicCircleGenerator/src/assets/**`(実在するアセットIDの一覧)

## 0. 設計原則

1. **既存の`Ring`スキーマは一切変更しない**(README記載の既存規律を踏襲)。新規ジェネレーター
   関数2つと、`ringCompositor.ts`への新規ディスパッチケース2つのみを追加する。
2. **決定論的**: 同じ`FlowchartIR`(ノード種別・ラベル・エッジ構造が同じ)からは常に同じ
   `MagicCircleComposition`(同じ配色・配置)が生成される。乱数は`generateHuePalette`が使う
   シードのみで、シードは`FlowchartIR`の構造から導出する(タイムスタンプは使わない)。
3. **ラベル文字列は描画しない**。魔方陣は記号体系であり、テキスト帯として関数名やコード片を
   埋め込むと本来の意匠から外れる。ラベルは`<title>`要素(非視覚・アクセシビリティ用途)にのみ残す。
4. **既存の静的アセットのみを再利用する**。新規SVGは追加しない(6種のNodeKindに対して
   `src/assets/glyphs/`+`cores/`の既存6アセットが過不足なく割り当てられるため)。

## 1. リング層(radius)の決定: レイヤリングアルゴリズム

FlowchartIRはループ由来の閉路を含みうる有向グラフである。これを「同心円の層」に変換するため、
以下を**厳密に**この順で行う。

### 1.1 逆辺(ループの戻りエッジ)の検出 — DFS白/灰/黒法

```
color[node] = WHITE for all nodes
backEdges = {}

dfs(u):
  color[u] = GRAY
  for edge (u -> v) in ir.edges (ir.edges に現れる順):
    if color[v] == WHITE: dfs(v)
    else if color[v] == GRAY: backEdges.add(edge)   // 閉路を作る「戻りエッジ」
    // color[v] == BLACK の場合(前方/交差エッジ)は何もしない(forward扱い)
  color[u] = BLACK

dfs(start_node)  // kind === "start" のノード
```

これは閉路検出の標準的なDFS法。`start`から到達しない孤立ノードがある場合は、
`start`を根とする森として全ノードに対しdfsを追加実行する(念のための防御的処理)。

### 1.2 層(layer)の決定 — 逆辺を除いたDAG上でのKahn法+最長路

```
forwardEdges = ir.edges - backEdges
layer[start_node] = 0
forwardEdges からKahnのトポロジカルソートで順序 topoOrder を得る
for u in topoOrder:
  for edge (u -> v) in forwardEdges:
    layer[v] = max(layer[v] ?? 0, layer[u] + 1)
```

`start`から到達不能なノードは `layer = maxLayer + 1`(最後に追加する「未接続」リング)に置く。

### 1.3 半径への変換

```
baseRadius = 26
ringGap   = 34
maxLayer  = max(layer[*])
radius(layer) = baseRadius + (maxLayer - layer) * ringGap
```

**`start`が最外周、`end`が中心に最も近い**(layerが浅いほど半径が大きい)。これは
[Mystical](https://github.com/denismm/mystical_ps)の「外側のリングから開始し反時計回りに
処理が流れる」という構成美学へのオマージュであり、Mermaid版(上から下に流れる)とは向きの
比喩を変えている。

## 2. 同一層内の角度(angle)配置

同じ`layer`に属するノード(if/elseの分岐先、switchの各case等)は同じリング上に共存する。

```
同一layer内のノードを node.id の文字列比較(n1 < n2 < ... の数値順)で安定ソートする
count = そのlayerのノード数
rotationOffset(layer) = layer * (π / 12)     // リングごとに少しずつ回転をずらす
angle(index, count, layer) = rotationOffset(layer) + (2π / count) * index
```

`rotationOffset`は`Ring.rotation`フィールドにそのまま渡す(スキーマの既存フィールドの意味通り)。
親子関係にもとづく角度の引き継ぎは行わない(全周均等配置のみ)。理由: エンタメ用途において
「見た目の複雑さ・美しさ」を優先し、subtree保存のための追加ロジックはコストに見合わない。

## 3. ノード種別 → グリフ資産マッピング

| NodeKind      | assetId               | カテゴリ | 意匠上の理由                          |
| ------------- | --------------------- | -------- | ------------------------------------- |
| `start`       | `core_star_pentagram` | cores    | 儀式の開始=境界紋                     |
| `end`         | `core_star_pentagram` | cores    | 同じ境界紋(色で開始と区別。詳細は4節) |
| `process`     | `rune_alchemy_01`     | glyphs   | 汎用処理=汎用ルーン                   |
| `decision`    | `gem_hatched_04`      | glyphs   | 多面カットの宝石=分岐・選択           |
| `loop`        | `gem_mandala_03`      | glyphs   | マンダラ=円環・反復                   |
| `ioOperation` | `gear_symbol`         | glyphs   | 歯車=外部インターフェース             |

`rune_alchemy_02`・`ring_plain_02`は本マッピングでは未使用。`ring_ornate_01`は6節の
外周装飾リングで使用する。

## 4. 配色

`generateHuePalette(6, seed)`(既存の`palette.ts`、内部で`seedrandom`パッケージを使用)を呼び、
返る6色を**固定順**でNodeKindに割り当てる: `[start, end, process, decision, loop, ioOperation]`
(`KIND_ORDER`)。

**色の計算は`core/render/magic-circle-emitter.ts`側では行わない。** `seedrandom`ベースの
`palette.ts`の実装をTypeScript側で再実装すると、アルゴリズムの版ズレにより同じseedから
違う色が出るリスクがある(実際、初期実装でこの不整合が発生したため方針を修正した)。
そこで**色決定ロジックは`palette.ts`に一元化**し、emitterは`seed`と`kind`を
`Ring.proceduralParams`に埋め込むだけに留める。実際の色解決は6節の`flowchart_nodes`
ディスパッチケース(`ringCompositor.ts`、描画側)が`generateHuePalette(6, params.seed)`を
呼んで行う。

`seed`は`FlowchartIR`の構造から決定論的に導出する(FNV-1aハッシュ、emitter側で計算):

```
seedSource = ir.sourceFile + "|" + ir.nodes.map(n => `${n.kind}:${n.label}`).join(",")
           + "|" + ir.edges.map(e => `${e.from}>${e.to}:${e.label ?? ""}`).join(",")
seed = fnv1a32(seedSource)
```

`generatedAt`(実行時刻)は意図的にシードへ含めない。同じコードを何度解析しても同じ魔方陣に
なることを保証するため。

## 5. エッジ → 接続線(新規ジェネレーター`flowchart_threads`)

既存7ジェネレーターに「2点間を結ぶ線」を汎用的に描くものは無い
(`hatch_connector`は全周均等密度のクロスハッチであり、特定2ノード間の接続には使えない)。
そのため新規ジェネレーター`generateThreadPaths`を1つ追加する(`proceduralGenerators.ts`)。

### 5.1 エッジの分類

`ir.edges`の各エッジについて:

- **逆辺**(1.1節の`backEdges`に含まれる) → `loopBack`スタイル
- それ以外(forward edge) → `label`の値で分岐: `"true"` / `"false"` / それ以外(`""`・`switch`のcase等)

### 5.2 スタイル表

| 分類                | 色                           | 線幅 | 線種         | 経路                             |
| ------------------- | ---------------------------- | ---- | ------------ | -------------------------------- |
| forward, `true`     | `#ffcf6b`(金)                | 1.2  | 実線         | 直線                             |
| forward, `false`    | `#8fa8ff`(青白)              | 1.2  | 破線 `"3 2"` | 直線                             |
| forward, ラベルなし | `currentColor` (opacity 0.5) | 0.8  | 実線         | 直線                             |
| `loopBack`(逆辺)    | `#c98bff`(紫)                | 1.8  | 実線         | 外側に膨らむ二次ベジェ曲線(下記) |

`loopBack`の経路: 始点半径`r1`・終点半径`r2`の大きい方を`rMax`として、制御点を
`(rMax + 24)`の半径・始点と終点の中間角度に置いた二次ベジェ曲線
(`Q`コマンド)。「輪から輪へ、外へ戻る糸」を表現する。

### 5.3 `generateThreadPaths`のシグネチャ

```typescript
export interface ThreadSpec {
  r1: number;
  a1: number; // 始点(半径, ラジアン)
  r2: number;
  a2: number; // 終点(半径, ラジアン)
  style: "trueEdge" | "falseEdge" | "plainEdge" | "loopBack";
}

/** 2点間(極座標)を結ぶSVGパス群を生成する。ノード配置(2節)の座標をそのまま渡せる。 */
export function generateThreadPaths(
  threads: ThreadSpec[],
): { d: string; style: ThreadSpec["style"] }[];
```

## 6. `Ring[]`の組み立て

1つの`layer`につき1つの`Ring`(`elementType: "glyph_repeat"`, `sourceAssetRef: "flowchart_nodes"`)。
すべてのエッジをまとめた**1つだけ**の`Ring`(`elementType: "geometric_pattern"`,
`sourceAssetRef: "flowchart_threads"`)。最後に装飾用の外周リング1つ。

```typescript
interface FlowchartNodesParams {
  seed: number; // 4節: generateHuePalette(6, seed) を描画側で呼ぶための種
  kindOrder: NodeKind[]; // 4節のKIND_ORDER(パレット色→NodeKindのインデックス対応)
  nodes: { assetId: string; angle: number; kind: NodeKind; nodeId: string; title: string }[];
}
interface FlowchartThreadsParams {
  threads: ThreadSpec[];
}
```

- ノードリングの`Ring.radius` = 1.3節の`radius(layer)`。`Ring.rotation` = 2節の`rotationOffset(layer)`。
  `Ring.color`(スキーマ上のフォールバック表示用フィールド)は**設定しない**
  (4節の通り色は`flowchart_nodes`ディスパッチ側が`params.seed`から都度導出するため、
  emitter側で計算した色をここに埋め込むことはしない)。
- スレッドリングの`Ring.radius`は**このケースに限り未使用のプレースホルダとして`0`を設定する**
  (実座標は`proceduralParams.threads[]`が個別に持つため)。これは既存7ジェネレーターの中で
  唯一`ring.radius`を使わない例外であり、意図的である旨をコード中にコメントで明記する。
- 描画順(＝SVGの重なり順)は **スレッドリングを先頭、ノードリングを層の浅い順(=外側から)、
  最後に装飾リング**。線がノードグリフの下に隠れるようにするため。
- 装飾リング: `elementType: "satellite_circle"`, `sourceAssetRef: "ring_ornate_01"`,
  `radius = maxRadius + 40`, `symmetryOrder = 8`, `rotation = 0`
  (`elemental.yaml`プリセットの既存の使い方をそのまま踏襲)。

## 7. `MagicCircleComposition`全体

```typescript
{
  compositionId: `mc_flowchart_${seed.toString(36)}`,
  seed,
  stylePreset: "flowchart_sigil",
  rings: [threadRing, ...nodeRingsByLayerAsc, boundaryRing],
  effectStack: [],   // v1はエフェクトなし(過剰装飾を避ける)
  formatVersion: FORMAT_VERSION,  // MagicCircleGenerator側の定数をそのまま使う
}
```

`effectStack`を空にする理由: グロー/ノイズ/ディストーションはこのマッピングの正しさを
目視検証しづらくするため、プロトタイプ段階では意図的に外す(将来ユーザーがアプリ上で
手動追加することは妨げない)。

## 8. 検証チェックリスト

- [ ] `start`が最外周リング・`end`が最内周リングに配置されること(1.3節)
- [ ] ループの戻りエッジ(`n9→n7`等)がDFS法で正しく`backEdges`として検出され、
      レイヤリング計算から除外されること(1.1/1.2節)
- [ ] 同じ`FlowchartIR`を2回変換して**バイト同一**の`MagicCircleComposition`が得られること(決定論性)
- [ ] `true`/`false`/ラベルなし/`loopBack`の4種のスレッドスタイルが仕様通りの色・線種で
      出力されること(5.2節)
- [ ] 出力JSONが`MagicCircleGenerator`の`importRecipe()`でエラーなく読み込めること
- [ ] `flowchart_nodes`/`flowchart_threads`の2つの新規ディスパッチケースが、
      既存の`Ring`型定義を変更せずに追加されていること
