/**
 * CodeBoarding(https://github.com/CodeBoarding/CodeBoarding)の `analysis.json` を、
 * 本拡張の上位階層(全体 → ファイル → 関数)用の中立なモデルへ変換するアダプタ(X2)。
 *
 * 対応しているスキーマは、CodeBoarding リポジトリが公開している実物の
 * `.codeboarding/analysis.json`(2026-10-15 生成分)で確認したもの:
 *
 *   {
 *     metadata:  { generated_at, repo_name, depth_level, ... },
 *     components: [{
 *       name, description, component_id?,
 *       key_entities:  [{ qualified_name, reference_file, reference_start_line, reference_end_line }],
 *       file_methods:  [{ file_path, methods: [qualified_name, ...] }],
 *       components?:   [ ...入れ子の子コンポーネント... ],
 *       components_relations?: [ ... ]
 *     }],
 *     components_relations: [{ relation, src_name, dst_name, src_id?, dst_id? }],
 *     methods_index: { "<file_path>|<qualified_name>": { file_path, qualified_name, start_line, end_line, type } }
 *   }
 *
 * スキーマは CodeBoarding 側で変わりうるため、**寛容に読む**: 項目単位の欠落・型違いは
 * 例外にせず読み飛ばして `warnings` に積む。例外を投げるのは「JSONのルートがオブジェクトでない」場合だけ。
 * ファイルが実在するかはこのアダプタでは判断しない(ホストが `markMissingFiles` で付ける)。
 */

export type ArchFunctionKind = "function" | "method";

export interface ArchFunction {
  name: string;
  qualifiedName: string;
  /** 1始まり */
  startLine: number;
  endLine: number;
  kind: ArchFunctionKind;
}

export interface ArchFile {
  /** `/` 区切りの相対パス */
  path: string;
  functions: ArchFunction[];
  /** ホストが実在確認した結果。存在しないファイルを指す項目でもエラーにはしない */
  missing?: boolean;
  /** ホストが付ける。この拡張でフローを描けない言語のファイルは、理由を持つ(関数の「フローを開く」を押せなくする) */
  unsupportedReason?: string;
}

export interface ArchComponent {
  id: string;
  name: string;
  description: string;
  files: ArchFile[];
  children: ArchComponent[];
}

export interface ArchRelation {
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  label: string;
}

export interface ArchitectureModel {
  repoName?: string;
  generatedAt?: string;
  components: ArchComponent[];
  relations: ArchRelation[];
  warnings: string[];
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * リポジトリルートの中を指す相対パスか。絶対パス・ドライブ指定・`..` を含むものは false。
 * analysis.json は外部ツールの出力なので、ルートの外のファイルを開かせない(openFunction と存在確認の両方で使う)。
 */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.includes("\0")) return false;
  const n = normalizePath(p);
  if (n.startsWith("/") || /^[A-Za-z]:/.test(n)) return false;
  return !n.split("/").some((seg) => seg === "..");
}

function lastSegment(qualifiedName: string): string {
  const i = qualifiedName.lastIndexOf(".");
  return i >= 0 ? qualifiedName.slice(i + 1) : qualifiedName;
}

export function parseCodeBoardingAnalysis(input: unknown): ArchitectureModel {
  if (!isObject(input)) {
    throw new Error(
      "analysis.json の形式が不正です(ルートがオブジェクトではありません)",
    );
  }

  const warnings: string[] = [];
  const methodsIndex = isObject(input.methods_index) ? input.methods_index : {};
  if (!isObject(input.methods_index)) {
    warnings.push("methods_index がないため、関数の行範囲を取得できません");
  }

  const relations: ArchRelation[] = [];
  const addRelations = (raw: unknown) => {
    if (!Array.isArray(raw)) return;
    for (const r of raw) {
      if (!isObject(r)) {
        warnings.push(
          "components_relations に不正な項目があり、読み飛ばしました",
        );
        continue;
      }
      const fromName = str(r.src_name);
      const toName = str(r.dst_name);
      if (!fromName || !toName) {
        warnings.push("src_name / dst_name のない関係を読み飛ばしました");
        continue;
      }
      relations.push({
        fromId: str(r.src_id) ?? fromName,
        toId: str(r.dst_id) ?? toName,
        fromName,
        toName,
        label: str(r.relation) ?? "",
      });
    }
  };

  const parseComponent = (
    raw: unknown,
    path: string,
  ): ArchComponent | undefined => {
    if (!isObject(raw)) {
      warnings.push(
        `コンポーネント ${path} が不正な項目のため読み飛ばしました`,
      );
      return undefined;
    }
    const name = str(raw.name) ?? `component ${path}`;
    const id = str(raw.component_id) ?? path;

    // ファイル -> 関数。file_methods を主とし、key_entities を補う
    const filesByPath = new Map<string, ArchFile>();
    const fileOf = (p: string): ArchFile | undefined => {
      if (!isSafeRelativePath(p)) {
        const msg = `リポジトリの外を指すパス「${p}」を読み飛ばしました`;
        if (!warnings.includes(msg)) warnings.push(msg);
        return undefined;
      }
      const key = normalizePath(p);
      let f = filesByPath.get(key);
      if (!f) {
        f = { path: key, functions: [] };
        filesByPath.set(key, f);
      }
      return f;
    };
    const seen = new Set<string>();
    const addFunction = (file: ArchFile, fn: ArchFunction) => {
      const k = `${file.path}|${fn.qualifiedName}`;
      if (seen.has(k)) return;
      seen.add(k);
      file.functions.push(fn);
    };

    if (Array.isArray(raw.file_methods)) {
      for (const fm of raw.file_methods) {
        if (!isObject(fm) || !str(fm.file_path) || !Array.isArray(fm.methods)) {
          warnings.push(
            `コンポーネント「${name}」の file_methods に不正な項目があり、読み飛ばしました`,
          );
          continue;
        }
        const filePath = fm.file_path as string;
        const file = fileOf(filePath);
        if (!file) continue;
        for (const qn of fm.methods) {
          if (typeof qn !== "string") continue;
          const entry = methodsIndex[`${filePath}|${qn}`];
          if (!isObject(entry)) continue; // 索引にない(行範囲が不明な)ものは関数として出さない
          const type = str(entry.type);
          if (type !== "FUNCTION" && type !== "METHOD") continue; // CLASS 等は関数として出さない
          const start = num(entry.start_line);
          const end = num(entry.end_line);
          if (start === undefined || end === undefined) continue;
          addFunction(file, {
            name: lastSegment(qn),
            qualifiedName: qn,
            startLine: start,
            endLine: end,
            kind: type === "METHOD" ? "method" : "function",
          });
        }
      }
    }
    if (Array.isArray(raw.key_entities)) {
      for (const ke of raw.key_entities) {
        if (!isObject(ke) || !str(ke.reference_file) || !str(ke.qualified_name))
          continue;
        const file = fileOf(ke.reference_file as string);
        if (!file) continue;
        const start = num(ke.reference_start_line);
        const end = num(ke.reference_end_line);
        const entry =
          methodsIndex[
            `${ke.reference_file as string}|${ke.qualified_name as string}`
          ];
        const type = isObject(entry) ? str(entry.type) : undefined;
        if (start === undefined || end === undefined) continue;
        if (type === "CLASS") continue;
        addFunction(file, {
          name: lastSegment(ke.qualified_name as string),
          qualifiedName: ke.qualified_name as string,
          startLine: start,
          endLine: end,
          kind: type === "METHOD" ? "method" : "function",
        });
      }
    }

    const children: ArchComponent[] = [];
    if (Array.isArray(raw.components)) {
      raw.components.forEach((c, i) => {
        const child = parseComponent(c, `${path}.${i + 1}`);
        if (child) children.push(child);
      });
    }
    addRelations(raw.components_relations);

    return {
      id,
      name,
      description: str(raw.description) ?? "",
      files: Array.from(filesByPath.values()).sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
      children,
    };
  };

  const components: ArchComponent[] = [];
  if (Array.isArray(input.components)) {
    input.components.forEach((c, i) => {
      const comp = parseComponent(c, String(i + 1));
      if (comp) components.push(comp);
    });
  } else {
    warnings.push("components がないため、コンポーネントを取得できません");
  }
  addRelations(input.components_relations);

  const metadata = isObject(input.metadata) ? input.metadata : {};
  return {
    repoName: str(metadata.repo_name),
    generatedAt: str(metadata.generated_at),
    components,
    relations,
    warnings,
  };
}

/**
 * 実在しないファイルに `missing: true` を付ける(例外にはしない)。
 * `exists` はホストが渡す判定関数(VSCode なら workspace.fs.stat を事前に解決した集合など)。
 */
export function markMissingFiles(
  model: ArchitectureModel,
  exists: (path: string) => boolean,
): number {
  const missing = new Set<string>(); // 同じファイルが複数コンポーネントに現れても1件と数える
  const visit = (c: ArchComponent) => {
    for (const f of c.files) {
      f.missing = !exists(f.path);
      if (f.missing) missing.add(f.path);
    }
    c.children.forEach(visit);
  };
  model.components.forEach(visit);
  return missing.size;
}

/** すべてのファイルパス(重複なし)。ホストの実在確認に使う。 */
export function collectFilePaths(model: ArchitectureModel): string[] {
  const set = new Set<string>();
  const visit = (c: ArchComponent) => {
    c.files.forEach((f) => set.add(f.path));
    c.children.forEach(visit);
  };
  model.components.forEach(visit);
  return Array.from(set);
}
