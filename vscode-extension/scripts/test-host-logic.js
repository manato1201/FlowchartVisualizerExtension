// VS Code ホスト側の「vscode に依存しない」ロジックの検証(`npm run compile` 後に実行)。
//   - ノードの行番号が、実際のソースの行と一致する(クリックで正しい行へジャンプできる前提)
//   - 変更前(HEAD)のテキストから関数を名前で切り出せる / 呼び出しを定義と取り違えない
//   - 変更のない関数は、行がずれても差分に出ない(X3 の誤検出防止)
//   - 波括弧の対応チェック(編集中の構文エラーを帯で知らせるための判定)
const assert = require("node:assert/strict");
const { irFromFunctionText, sliceFunctionByName, plainFunctionName, checkBraceBalance } = require("../dist/vscode-extension/src/functionSlicer");
const { diffIR } = require("../dist/core/diff/ir-diff");

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

const SOURCE = `using UnityEngine;

public class Player : MonoBehaviour
{
    private bool isGrounded;
    private int state;

    void Start()
    {
        Init();
    }

    void Update()
    {
        if (isGrounded)
        {
            Jump();
        }
        else if (isFalling)
        {
            ApplyGravity();
        }

        for (int i = 0; i < enemies.Length; i++)
        {
            if (enemies[i].IsDead)
            {
                Destroy(enemies[i]);
            }
        }

        switch (state)
        {
            case 0:
                PlayIdleAnim();
                break;
            default:
                PlayDefaultAnim();
                break;
        }
    }

    int Compute(int a)
    {
        return a * 2;
    }

    int Compute(string s)
    {
        if (s == null) { return 0; }
        return s.Length;
    }

    public abstract void Bar();
    int Expr(int a) => a + 1;

    void Caller()
    {
        if (Update(1)) { Other(); }
        Update(2);
        var x = new Update(3);
    }
}
`;

const lines = SOURCE.split("\n");
const lineOf = (needle) => lines.findIndex((l) => l.includes(needle)) + 1; // 1始まり

test("ノードの行番号が、実際のソースの行と一致する(ジャンプのずれがない)", () => {
  const sliced = sliceFunctionByName(SOURCE, "Update", 0);
  assert.ok(sliced, "Update を切り出せる");
  const ir = irFromFunctionText(sliced.text, sliced.startLine, "Update()", "Player.cs");
  const checks = [
    ["decision", "if (isGrounded)"],
    ["process", "Jump();"],
    ["decision", "else if (isFalling)"],
    ["process", "ApplyGravity();"],
    ["loop", "for (int i = 0"],
    ["decision", "if (enemies[i].IsDead)"],
    ["process", "Destroy(enemies[i]);"],
    ["decision", "switch (state)"],
  ];
  for (const [kind, key] of checks) {
    const node = ir.nodes.find((n) => n.kind === kind && n.label.includes(key.split("(")[0] === "if " ? key : key));
    assert.ok(node, `${kind}: ${key}`);
    const actualLine = node.sourceRange.startLine;
    assert.ok(
      lines[actualLine - 1].includes(key.replace(/\s+$/, "")),
      `${key} は ${lineOf(key)} 行目だが、ノードは ${actualLine} 行目(「${lines[actualLine - 1].trim()}」)`,
    );
    assert.equal(actualLine, lineOf(key), key);
  }
  const start = ir.nodes.find((n) => n.kind === "start");
  assert.equal(start.sourceRange.startLine, lineOf("void Update()"), "開始ノードは宣言の行");
});

test("名前で関数を切り出す: 呼び出し・宣言のみ・式形式を定義と取り違えない", () => {
  const upd = sliceFunctionByName(SOURCE, "Update", 0);
  assert.equal(upd.startLine + 1, lineOf("void Update()"));
  assert.ok(upd.text.trimEnd().endsWith("}"));
  assert.ok(upd.text.includes("PlayDefaultAnim();") && !upd.text.includes("int Compute"));
  assert.equal(sliceFunctionByName(SOURCE, "Update", 1), null, "Caller 内の Update(1) / Update(2) / new Update(3) は定義ではない");
  assert.equal(sliceFunctionByName(SOURCE, "Bar", 0), null, "宣言のみ(;)は対象外");
  assert.equal(sliceFunctionByName(SOURCE, "Expr", 0), null, "式形式(=>)は対象外");
  assert.equal(sliceFunctionByName(SOURCE, "Nope", 0), null);
});

test("同名のオーバーロードは出現順(nth)で取り分ける", () => {
  const a = sliceFunctionByName(SOURCE, "Compute", 0);
  const b = sliceFunctionByName(SOURCE, "Compute", 1);
  assert.ok(a.text.includes("return a * 2;"));
  assert.ok(b.text.includes("s.Length"));
  assert.equal(sliceFunctionByName(SOURCE, "Compute", 2), null);
});

test("TypeScript / JavaScript の定義(function・メソッド・戻り値型つき)も切り出せる", () => {
  const ts = `export class A {
  async load(id: number): Promise<void> {
    if (id > 0) { await this.fetch(id); }
  }
  update(): void {
    for (const x of this.items) { x.tick(); }
  }
}
function helper<T>(a: T): T {
  return a;
}
const r = helper(1);
`;
  assert.ok(sliceFunctionByName(ts, "load").text.includes("await this.fetch"));
  assert.ok(sliceFunctionByName(ts, "update").text.includes("x.tick()"));
  assert.ok(sliceFunctionByName(ts, "helper").text.includes("return a;"));
});

test("変更のない関数は、上に行が追加されて全体がずれても、差分に出ない(誤表示なし)", () => {
  const head = SOURCE;
  const current = "// 追加したコメント\n// もう一行\n" + SOURCE;
  const h = sliceFunctionByName(head, "Update", 0);
  const c = sliceFunctionByName(current, "Update", 0);
  assert.equal(c.startLine, h.startLine + 2);
  const r = diffIR(
    irFromFunctionText(h.text, h.startLine, "Update()", "Player.cs"),
    irFromFunctionText(c.text, c.startLine, "Update()", "Player.cs"),
  );
  assert.equal(r.hasChanges, false);
  assert.equal(r.summary.nodesUnchanged, r.ir.nodes.length);
});

test("関数の中を変えると、その関数だけが差分に出る(CRLF と LF の混在でも誤検出しない)", () => {
  const head = SOURCE;
  const edited = SOURCE.replace("Jump();", "Jump();\n            Log();").replace(/\n/g, "\r\n").replace(/\r\n/g, "\n");
  const h = sliceFunctionByName(head, "Update", 0);
  const c = sliceFunctionByName(edited, "Update", 0);
  const r = diffIR(
    irFromFunctionText(h.text, h.startLine, "Update()", "Player.cs"),
    irFromFunctionText(c.text, c.startLine, "Update()", "Player.cs"),
  );
  assert.equal(r.hasChanges, true);
  // スキャナは連続する文を1つの処理ノードにまとめるため、隣に文を足すとそのノードの「変更」になる
  assert.equal(r.summary.nodesChanged, 1);
  assert.equal(r.summary.nodesAdded + r.summary.nodesRemoved, 0);
  const ch = r.ir.nodes.find((n) => n.diff === "changed");
  assert.ok(ch.label.includes("Log();") && ch.previousLabel === "Jump();", ch.label + " / " + ch.previousLabel);
  // 同じファイルの別関数は変わっていない
  const h2 = sliceFunctionByName(head, "Compute", 1);
  const c2 = sliceFunctionByName(edited, "Compute", 1);
  assert.equal(
    diffIR(
      irFromFunctionText(h2.text, h2.startLine, "Compute()", "P.cs"),
      irFromFunctionText(c2.text, c2.startLine, "Compute()", "P.cs"),
    ).hasChanges,
    false,
  );
});

test("波括弧の整合: 文字列・コメント内の波括弧は数えず、足りない/余りは理由つきで検出する", () => {
  assert.deepEqual(checkBraceBalance("void F() { if (a) { b(); } }"), { ok: true });
  assert.deepEqual(checkBraceBalance('void F() { var s = "}{"; var t = $"{x}"; /* } */ // }\n }'), { ok: true });
  const open = checkBraceBalance("void F() { if (a) { b(); }");
  assert.equal(open.ok, false);
  assert.match(open.reason, /閉じられていません/);
  const extra = checkBraceBalance("void F() { } }");
  assert.equal(extra.ok, false);
  assert.match(extra.reason, /余っています/);
  assert.equal(checkBraceBalance("/* 閉じ忘れ").ok, false);
});

test("plainFunctionName: 括弧・修飾・名前空間を外して素の名前にする", () => {
  assert.equal(plainFunctionName("Update()"), "Update");
  assert.equal(plainFunctionName("Player.Update"), "Update");
  assert.equal(plainFunctionName("void Update(int x)"), "Update");
  assert.equal(plainFunctionName("Foo<T>(T a)"), "Foo");
  assert.equal(plainFunctionName("update"), "update");
});

console.log(`host-logic: ${passed} passed`);
