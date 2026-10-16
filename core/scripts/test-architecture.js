// CodeBoarding analysis.json アダプタ(X2)の検証。実物から切り出したフィクスチャ + 壊れた入力。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseCodeBoardingAnalysis,
  markMissingFiles,
  collectFilePaths,
} = require("../dist/architecture/codeboarding-adapter");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok   " + name);
  } catch (e) {
    console.error("  FAIL " + name + "\n" + e.stack);
    process.exitCode = 1;
  }
}

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "codeboarding-analysis.sample.json"), "utf8"),
);

test("実物の analysis.json 抜粋: コンポーネント / ファイル / 関数 / 関係を読める", () => {
  const m = parseCodeBoardingAnalysis(sample);
  assert.equal(m.components.length, 2);
  assert.ok(m.repoName);
  assert.ok(m.relations.length >= 1);
  const files = collectFilePaths(m);
  assert.ok(files.length >= 2);
  const fns = [];
  const visit = (c) => {
    c.files.forEach((f) => f.functions.forEach((x) => fns.push(x)));
    c.children.forEach(visit);
  };
  m.components.forEach(visit);
  assert.ok(fns.length >= 1);
  fns.forEach((f) => {
    assert.ok(f.startLine >= 1 && f.endLine >= f.startLine, f.qualifiedName);
    assert.ok(f.name.length > 0 && !f.name.includes("."));
  });
  m.components.forEach((c) => c.files.forEach((f) => assert.ok(!f.path.includes("\\"))));
});

test("入れ子のコンポーネントを読む", () => {
  const m = parseCodeBoardingAnalysis(sample);
  assert.ok(m.components.some((c) => c.children.length > 0));
});

test("CLASS は関数として出さない", () => {
  const m = parseCodeBoardingAnalysis(sample);
  const all = [];
  const visit = (c) => {
    c.files.forEach((f) => f.functions.forEach((x) => all.push(x)));
    c.children.forEach(visit);
  };
  m.components.forEach(visit);
  const classNames = Object.values(sample.methods_index)
    .filter((x) => x.type === "CLASS")
    .map((x) => x.qualified_name);
  assert.ok(classNames.length > 0, "フィクスチャにCLASSが含まれていること");
  all.forEach((f) => assert.ok(!classNames.includes(f.qualifiedName), f.qualifiedName));
});

test("存在しないファイルを指す項目でもエラーにならず、missing が付く", () => {
  const m = parseCodeBoardingAnalysis(sample);
  const paths = collectFilePaths(m);
  const first = paths[0];
  const missing = markMissingFiles(m, (p) => p === first);
  assert.equal(missing, paths.length - 1);
  const flags = [];
  const visit = (c) => {
    c.files.forEach((f) => flags.push([f.path, f.missing]));
    c.children.forEach(visit);
  };
  m.components.forEach(visit);
  flags.forEach(([p, miss]) => assert.equal(miss, p !== first));
});

test("壊れた項目は読み飛ばして警告に積む(例外にしない)", () => {
  const broken = {
    components: [
      42,
      null,
      {
        name: "A",
        file_methods: [{ file_path: 5 }, "x", { file_path: "a.cs", methods: [1, "A.f"] }],
        key_entities: [null, { reference_file: "a.cs" }],
      },
      { description: "名前なし", components: "not-an-array" },
    ],
    methods_index: { "a.cs|A.f": { type: "FUNCTION", start_line: "x", end_line: 3 } },
    components_relations: [null, { src_name: "A" }, { src_name: "A", dst_name: "B", relation: "calls" }],
  };
  const m = parseCodeBoardingAnalysis(broken);
  assert.equal(m.components.length, 2);
  assert.equal(m.relations.length, 1);
  assert.ok(m.warnings.length >= 3);
  assert.equal(m.components[0].files.flatMap((f) => f.functions).length, 0, "行範囲が不正な関数は出さない");
});

test("空のオブジェクトでも落ちない(警告のみ)", () => {
  const m = parseCodeBoardingAnalysis({});
  assert.deepEqual(m.components, []);
  assert.ok(m.warnings.length >= 1);
});

test("ルートがオブジェクトでなければ、分かる文面で例外", () => {
  assert.throws(() => parseCodeBoardingAnalysis([]), /形式が不正/);
  assert.throws(() => parseCodeBoardingAnalysis(null), /形式が不正/);
  assert.throws(() => parseCodeBoardingAnalysis("x"), /形式が不正/);
});

test("Windows 区切りのパスを / に正規化する", () => {
  const m = parseCodeBoardingAnalysis({
    components: [{ name: "A", file_methods: [{ file_path: ".\\src\\a.cs", methods: ["A.f"] }] }],
    methods_index: { ".\\src\\a.cs|A.f": { type: "METHOD", start_line: 1, end_line: 2 } },
  });
  assert.equal(m.components[0].files[0].path, "src/a.cs");
  assert.equal(m.components[0].files[0].functions[0].kind, "method");
});

console.log(`architecture: ${passed} passed`);
