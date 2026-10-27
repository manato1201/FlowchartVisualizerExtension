// 制御フロー抽出(テキスト版・tree-sitter版)の検証。`npm run compile` の後に実行する。
// 前回の見直しで「ブレースなしの if / for で無限ループしてメモリを使い切る」不備が見つかったため、
// 次を重点的に確認する:
//   - どんな入力でも必ず終わる(壊れた入力・ランダムに生成した入力を含む)
//   - 出力は常に正しい形(ID が一意・辺は実在するノードを指す・全ノードが start から到達でき End へ到達できる)
//   - よくある書き方(ブレースなしの本体・return/throw・文字列内の構文・セミコロン省略・括弧なしの条件)
//   - テキスト版と tree-sitter 版が、同じコードで同じ構造を返す
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { irFromFunctionText } = require("../dist/vscode-extension/src/functionSlicer");
const { maskCode } = require("../dist/vscode-extension/src/codeMask");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok   " + name);
  } catch (e) {
    console.error("  FAIL " + name + "\n" + e.stack);
    process.exitCode = 1;
  }
}

const scan = (code, label = "f()") => irFromFunctionText(code, 0, label, "x.cs");
const kinds = (ir) => ir.nodes.map((n) => n.kind);
const edgeSet = (ir) => new Set(ir.edges.map((e) => `${e.from}>${e.to}${e.label ? ":" + e.label : ""}`));
const labelOf = (ir, id) => ir.nodes.find((n) => n.id === id).label;
const byLabel = (ir, text) => ir.nodes.find((n) => n.label.includes(text));
const hasEdge = (ir, from, to, label) =>
  ir.edges.some((e) => e.from === from.id && e.to === to.id && (label === undefined || (e.label || "") === label));

/** 出力が常に満たすべき性質。 */
function assertWellFormed(ir, ctx = "") {
  const ids = ir.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, `${ctx}: ID が重複`);
  assert.equal(ir.nodes[0].kind, "start", `${ctx}: 先頭は start`);
  assert.equal(ir.nodes[ir.nodes.length - 1].kind, "end", `${ctx}: 末尾は end`);
  assert.equal(ir.nodes.filter((n) => n.kind === "start").length, 1);
  assert.equal(ir.nodes.filter((n) => n.kind === "end").length, 1);
  const set = new Set(ids);
  for (const e of ir.edges) assert.ok(set.has(e.from) && set.has(e.to), `${ctx}: 宙に浮いた辺 ${e.from}>${e.to}`);

  const reach = (from, edgesOf) => {
    const seen = new Set([from]);
    const q = [from];
    while (q.length) for (const t of edgesOf(q.shift())) if (!seen.has(t)) (seen.add(t), q.push(t));
    return seen;
  };
  const out = new Map();
  const inn = new Map();
  ids.forEach((i) => (out.set(i, []), inn.set(i, [])));
  ir.edges.forEach((e) => (out.get(e.from).push(e.to), inn.get(e.to).push(e.from)));
  const fromStart = reach(ids[0], (n) => out.get(n));
  const toEnd = reach(ids[ids.length - 1], (n) => inn.get(n));
  const unreachable = ids.filter((i) => !fromStart.has(i));
  assert.deepEqual(unreachable, [], `${ctx}: start から届かないノード`);
  const dead = ids.filter((i) => !toEnd.has(i));
  assert.deepEqual(dead, [], `${ctx}: End へ届かないノード`);
}

(async () => {
  await test("ブレースなしの if / else / for / while で固まらない(以前はヒープ枯渇)。構造が正しい", () => {
    const ir = scan(`void F()
{
    if (a)
        Foo();
    else
        Bar();
    for (int i = 0; i < n; i++)
        Baz(i);
    while (running) Step();
    Done();
}`);
    assertWellFormed(ir);
    const d = byLabel(ir, "if (a)");
    assert.ok(hasEdge(ir, d, byLabel(ir, "Foo();"), "true"));
    assert.ok(hasEdge(ir, d, byLabel(ir, "Bar();"), "false"));
    const loop = byLabel(ir, "for (int i");
    assert.ok(hasEdge(ir, loop, byLabel(ir, "Baz(i);"), "true"));
    assert.ok(hasEdge(ir, byLabel(ir, "Baz(i);"), loop), "本体の終わりから条件へ戻る");
    assert.ok(hasEdge(ir, loop, byLabel(ir, "while (running)"), "false"), "ループを抜けると次へ");
    assert.equal(byLabel(ir, "Step();").sourceRange.startLine, 9);
  });

  await test("ブレースなしの if が連なっても(else if の連鎖・入れ子)正しく読める", () => {
    const ir = scan(`void F()
{
    if (a) X();
    else if (b) Y();
    else if (c)
        if (d) Z(); else W();
    End();
}`);
    assertWellFormed(ir);
    assert.deepEqual(kinds(ir).filter((k) => k === "decision").length, 4);
    assert.ok(byLabel(ir, "else if (b)") && byLabel(ir, "else if (c)"));
  });

  await test("return / throw の後ろへ線を引かない。End へ向かう。早期 return の後続は条件が false の経路", () => {
    const ir = scan(`void F()
{
    if (x == null)
    {
        return;
    }
    Work();
}`);
    assertWellFormed(ir);
    const ret = byLabel(ir, "return;");
    const end = ir.nodes[ir.nodes.length - 1];
    assert.deepEqual(
      ir.edges.filter((e) => e.from === ret.id).map((e) => e.to),
      [end.id],
      "return は End にだけ繋がる",
    );
    assert.ok(hasEdge(ir, byLabel(ir, "if (x"), byLabel(ir, "Work();"), "false"));
  });

  await test("到達不能なコード(return の後ろ)は図に出さない", () => {
    const ir = scan(`void F() { Start(); return; Dead(); if (z) { AlsoDead(); } }`);
    assertWellFormed(ir);
    assert.ok(!ir.nodes.some((n) => /Dead|if \(z\)/.test(n.label)));
    assert.deepEqual(kinds(ir), ["start", "process", "process", "end"]);
  });

  await test("すべての分岐が return で終わる関数でも、End に届く", () => {
    const ir = scan(`int F(int a) { if (a > 0) { return 1; } else { return 2; } }`);
    assertWellFormed(ir);
  });

  await test("文字列・コメントの中の { } if for は構文として読まない", () => {
    const ir = scan(`void F()
{
    var s = "if (x) { y(); } for (;;) {";   // while (true) { }
    /* switch (q) { case 1: } */
    var t = @"verbatim ""quoted"" } {";
    var u = \`template \${a} { if (b) } \`;
    Real();
}`);
    assertWellFormed(ir);
    assert.deepEqual(kinds(ir), ["start", "process", "end"]);
    // ラベルは60文字で切るので、最後の文(Real)は範囲の行で確かめる
    assert.equal(ir.nodes[1].sourceRange.endLine, 7, "Real(); の行まで1つの処理");
  });

  await test("セミコロンを省く書き方(TypeScript / JavaScript / Kotlin 風)でも、行ごとに文を読める", () => {
    const ir = scan(`function f() {
  const a = load()
  if (a) {
    run(a)
  }
  const b = a
    .filter(x => x)
    .map(x => x + 1)
  for (const x of b) {
    log(x)
  }
}`);
    assertWellFormed(ir);
    assert.deepEqual(kinds(ir), ["start", "process", "decision", "process", "process", "loop", "process", "end"]);
    assert.match(ir.nodes[4].label, /\.filter.*\.map/, "メソッドチェーンは1文");
  });

  await test("括弧を付けない条件(Go / Swift / Rust 風)も読める", () => {
    const ir = scan(`func f() {
    if x > 0 {
        a()
    } else {
        b()
    }
    for i := 0; i < n; i++ {
        c(i)
    }
    switch y {
    case 1:
        d()
    default:
        e()
    }
}`);
    assertWellFormed(ir);
    assert.ok(byLabel(ir, "if (x > 0)"));
    assert.ok(byLabel(ir, "for (i := 0; i < n; i++)"));
    assert.ok(byLabel(ir, "switch (y)"));
  });

  await test("do / while: 本体が先で、条件が true なら本体の先頭へ戻る", () => {
    const ir = scan(`void F() { do { Step(); } while (more); After(); }`);
    assertWellFormed(ir);
    const body = byLabel(ir, "Step();");
    const loop = byLabel(ir, "do/while (more)");
    assert.ok(hasEdge(ir, body, loop));
    assert.ok(hasEdge(ir, loop, body, "true"), "戻りの辺");
    assert.ok(hasEdge(ir, loop, byLabel(ir, "After();"), "false"));
  });

  await test("switch: case をまとめ、default が無ければ switch から次へ抜ける線が出る", () => {
    const ir = scan(`void F()
{
    switch (s)
    {
        case 1:
        case 2:
            A();
            break;
        case 3:
            return;
    }
    After();
}`);
    assertWellFormed(ir);
    const sw = byLabel(ir, "switch (s)");
    assert.equal(ir.edges.filter((e) => e.from === sw.id).length, 3, "A(); / return; / 抜ける線");
    assert.ok(hasEdge(ir, sw, byLabel(ir, "After();")), "default が無いので、どれにも入らなければ After へ");
    const withDefault = scan(`void F() { switch (s) { case 1: A(); break; default: B(); break; } }`);
    assertWellFormed(withDefault);
    const sw2 = byLabel(withDefault, "switch (s)");
    assert.equal(withDefault.edges.filter((e) => e.from === sw2.id).length, 2, "default があるので抜ける線はない");
  });

  await test("try / catch / finally: catch は本文の先頭から分かれ、finally は合流のあとに置く", () => {
    const ir = scan(`void F()
{
    try
    {
        Risky();
        More();
    }
    catch (Exception e)
    {
        Log(e);
    }
    finally
    {
        Cleanup();
    }
    After();
}`);
    assertWellFormed(ir);
    const risky = byLabel(ir, "Risky();");
    const catchHeader = byLabel(ir, "catch (Exception e)");
    assert.ok(hasEdge(ir, risky, catchHeader), "本文の先頭から catch へ");
    assert.ok(hasEdge(ir, byLabel(ir, "Log(e);"), byLabel(ir, "Cleanup();")));
    assert.ok(hasEdge(ir, risky, byLabel(ir, "Cleanup();")) || ir.edges.some((e) => e.to === byLabel(ir, "Cleanup();").id));
    assert.ok(hasEdge(ir, byLabel(ir, "Cleanup();"), byLabel(ir, "After();")));
  });

  await test("ローカル関数・ラムダ・オブジェクト初期化の波括弧は、文の一部として読む(中の if を図にしない)", () => {
    const ir = scan(`void F()
{
    int Local(int a) { if (a > 0) { return 1; } return 0; }
    items.ForEach(x => { if (x) Do(x); });
    var o = new Foo { A = 1, B = { C = 2 } };
    if (ready) Go();
}`);
    assertWellFormed(ir);
    assert.equal(ir.nodes.filter((n) => n.kind === "decision").length, 1, "外側の if (ready) だけ");
  });

  await test("using / lock / checked のブロックは、本体を流れに溶かす", () => {
    const ir = scan(`void F()
{
    using (var f = Open())
    {
        if (f.Ok) Read(f);
    }
    lock (gate) { Touch(); }
}`);
    assertWellFormed(ir);
    assert.ok(byLabel(ir, "if (f.Ok)") && byLabel(ir, "Touch();"));
  });

  await test("TypeScript の引数に型リテラル・戻り値に型リテラルがあっても、本体を取り違えない", () => {
    const ir = scan(`function f(opts: { a: number }): { b: number } {
  if (opts.a > 0) { return { b: 1 } }
  return { b: 0 }
}`);
    assertWellFormed(ir);
    assert.ok(byLabel(ir, "if (opts.a > 0)"));
  });

  await test("式形式の本体(=> expr)・本体のない宣言・空の関数でも壊れない", () => {
    for (const code of ["int F(int a) => a + 1;", "void F();", "void F() { }", "", "   \n  "]) {
      assertWellFormed(scan(code), JSON.stringify(code));
    }
  });

  await test("壊れた入力・途中まで書いた入力でも、必ず終わって(固まらず)、正しい形を返す", () => {
    const garbage = [
      "void F() { if (",
      "void F() { if (a) {",
      "void F() { for",
      "void F() { else }",
      "void F() { do",
      "void F() { do { } ",
      "void F() { switch (x) { case",
      "void F() { switch (x) { default",
      "void F() { try",
      "void F() { try { } catch",
      "void F() { } } } {",
      "if if if if if",
      "void F() { while (a) while (b) while (c)",
      "void F() { if (a) if (b) if (c)",
      "void F() { x = \"unterminated; if (a) { b(); } }",
      "void F() { /* never closed if (a) { }",
      "((((((((((",
      "{{{{{{{{{{",
      "}}}}}}}}}}",
      ";;;;;;;;;;",
      "void F() { return return return; }",
      "void F() { case 1: default: }",
    ];
    for (const code of garbage) {
      const t0 = Date.now();
      let ir;
      try {
        ir = scan(code);
      } catch (e) {
        // 安全装置(収束しない場合の例外)は許容するが、固まらないこと
        assert.match(e.message, /収束|解析しきれ/, `${JSON.stringify(code)}: 想定外の例外 ${e.message}`);
        continue;
      }
      assert.ok(Date.now() - t0 < 500, `${JSON.stringify(code)}: 遅い`);
      assertWellFormed(ir, JSON.stringify(code));
    }
  });

  await test("ランダムに生成した 400 個のコード(ブレースの有無・入れ子・return を混ぜる)で、常に正しい形になる", () => {
    let seed = 20261027;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    let id = 0;
    const simple = () => pick([`Foo${id++}();`, `x${id++} = ${id};`, `var v${id++} = Make();`, `list.Add(${id++});`]);
    function stmt(depth) {
      const r = rnd();
      if (depth > 3 || r < 0.35) return simple();
      if (r < 0.45) return pick(["return;", "return x;", "throw new Error();"]);
      const body = () => {
        const b = rnd();
        if (b < 0.3) return stmt(depth + 1); // ブレースなし(単文・入れ子の構文も)
        return `{\n${block(depth + 1)}\n}`;
      };
      if (r < 0.62) {
        const els = rnd();
        return `if (c${id++}) ${body()}` + (els < 0.35 ? ` else ${body()}` : els < 0.5 ? ` else if (d${id++}) ${body()}` : "");
      }
      if (r < 0.74) return `${pick(["for (int i = 0; i < n; i++)", "foreach (var x in xs)", "while (w" + id++ + ")"])} ${body()}`;
      if (r < 0.8) return `do ${rnd() < 0.5 ? `{\n${block(depth + 1)}\n}` : simple()} while (m${id++});`;
      if (r < 0.9) {
        const cases = [];
        const n = 1 + Math.floor(rnd() * 3);
        for (let i = 0; i < n; i++) cases.push(`case ${i}:\n${block(depth + 1)}${rnd() < 0.6 ? "\nbreak;" : ""}`);
        if (rnd() < 0.5) cases.push(`default:\n${block(depth + 1)}\nbreak;`);
        return `switch (s${id++}) {\n${cases.join("\n")}\n}`;
      }
      return `try {\n${block(depth + 1)}\n}${rnd() < 0.7 ? ` catch (Exception e) {\n${block(depth + 1)}\n}` : ""}${rnd() < 0.4 ? ` finally {\n${block(depth + 1)}\n}` : ""}`;
    }
    function block(depth) {
      const n = Math.floor(rnd() * 4);
      return Array.from({ length: n }, () => stmt(depth)).join("\n");
    }
    for (let k = 0; k < 400; k++) {
      const code = `void F()\n{\n${block(0)}\n}`;
      const t0 = Date.now();
      const ir = scan(code);
      assert.ok(Date.now() - t0 < 300, `#${k}: 遅い\n${code}`);
      try {
        assertWellFormed(ir, `#${k}`);
      } catch (e) {
        console.error(
          `--- 失敗したコード(#${k}) ---\n${code}\n--- IR ---\n` +
            ir.nodes.map((n) => `${n.id} ${n.kind} ${n.label}`).join("\n") +
            "\n" +
            ir.edges.map((x) => `${x.from}>${x.to}${x.label ? ":" + x.label : ""}`).join(" "),
        );
        throw e;
      }
    }
  });

  await test("性能: 5,000 行の関数を 1 秒以内に読める(行番号の計算が全文コピーでないこと)", () => {
    const body = [];
    for (let i = 0; i < 700; i++) {
      body.push(`    if (c${i})`, `    {`, `        Do${i}();`, `    }`, `    else Other${i}();`, `    for (int i = 0; i < n; i++) Step(i);`, `    Log(${i});`);
    }
    const code = `void Big()\n{\n${body.join("\n")}\n}`;
    assert.ok(code.split("\n").length > 4900);
    const t0 = Date.now();
    const ir = scan(code);
    const ms = Date.now() - t0;
    assertWellFormed(ir);
    assert.ok(ms < 1000, `${ms}ms`);
    console.log(`       ${code.split("\n").length} 行 / ${ir.nodes.length} ノード: ${ms}ms`);
  });

  await test("マスク: 同じ長さ・同じ改行位置で、コメントと文字列の中身だけが空白になる", () => {
    const src = `a("x{"); // c }\nb('}'); /* \n { */ c(\`{\`);`;
    const m = maskCode(src);
    assert.equal(m.length, src.length);
    assert.deepEqual([...m].map((c) => c === "\n"), [...src].map((c) => c === "\n"));
    assert.ok(!m.includes("{") && !m.includes("}"));
    assert.ok(m.includes("a(") && m.includes("b(") && m.includes("c("));
  });

  // ---------------------------------------------------------------- tree-sitter 版
  const wasmDir = path.join(__dirname, "..", "wasm");
  if (!fs.existsSync(path.join(wasmDir, "tree-sitter.wasm"))) {
    console.log("  skip tree-sitter(wasm/ が無い。`npm run fetch-wasm` を実行してください)");
  } else {
    const Parser = require("web-tree-sitter");
    await Parser.init({ locateFile: (f) => path.join(wasmDir, f) });
    const { buildFlowFromTree } = require("../dist/vscode-extension/src/treeSitterWalker");
    const langs = {
      ts: await Parser.Language.load(path.join(wasmDir, "tree-sitter-typescript.wasm")),
      cs: await Parser.Language.load(path.join(wasmDir, "tree-sitter-c_sharp.wasm")),
    };
    const flow = (lang, code, at) => {
      const p = new Parser();
      p.setLanguage(langs[lang]);
      const tree = p.parse(code);
      const r = buildFlowFromTree(tree.rootNode, at, "file");
      tree.delete();
      p.delete();
      return { ...r, sourceFile: "x", generatedAt: "t" };
    };

    const CS = `class P
{
    void Update()
    {
        if (isGrounded)
            Jump();
        else if (isFalling)
        {
            ApplyGravity();
        }
        else
            Idle();

        for (int i = 0; i < n; i++)
            Step(i);

        while (a) { if (b) return; Tick(); }

        switch (state)
        {
            case 0:
            case 1:
                A();
                break;
            default:
                B();
                break;
        }

        try { Risky(); } catch (Exception e) { Log(e); } finally { Cleanup(); }
        Done();
    }

    void Other() { Foo(); }
}`;

    await test("tree-sitter(C#): ブレースなし・else if・return・switch・try を正しい形で読む。ブレースなしの `;` をノードにしない", () => {
      const ir = flow("cs", CS, { row: 4, column: 8 });
      assertWellFormed(ir);
      assert.equal(ir.nodes[0].label, "Update()");
      assert.ok(!ir.nodes.some((n) => n.label === ";" || n.label.trim() === ""), "`;` だけのノードがない");
      assert.ok(byLabel(ir, "if (isGrounded)") && byLabel(ir, "else if (isFalling)"));
      assert.ok(hasEdge(ir, byLabel(ir, "if (isGrounded)"), byLabel(ir, "Jump();"), "true"));
      const ret = byLabel(ir, "return;");
      assert.ok(ret && ir.edges.filter((e) => e.from === ret.id).every((e) => ir.nodes.find((n) => n.id === e.to).kind === "end"));
    });

    await test("tree-sitter: カーソル位置の関数を選ぶ(別の関数にカーソルがあればそちら)。関数の外なら最初の関数", () => {
      const otherRow = CS.split("\n").findIndex((l) => l.includes("void Other()"));
      const other = flow("cs", CS, { row: otherRow, column: 20 });
      assert.equal(other.nodes[0].label, "Other()");
      assertWellFormed(other);
      assert.equal(flow("cs", CS, { row: 0, column: 0 }).nodes[0].label, "Update()");
      assert.equal(flow("cs", CS, undefined).nodes[0].label, "Update()");
    });

    const TS = `export class A {
  update(): void {
    if (this.grounded) this.jump();
    else this.fall();
    for (const e of this.enemies) { if (e.dead) this.destroy(e); }
    switch (this.state) {
      case 0:
      case 1:
        this.idle();
        break;
      default:
        this.other();
    }
    try { this.risky(); } catch (e) { this.log(e); } finally { this.cleanup(); }
    return;
  }
}`;
    await test("tree-sitter(TypeScript): 同じ規則で読める(else_clause の包み・for-of・switch・try・return)", () => {
      const ir = flow("ts", TS, { row: 2, column: 6 });
      assertWellFormed(ir);
      assert.equal(ir.nodes[0].label, "update()");
      assert.ok(byLabel(ir, "if (this.grounded)") && byLabel(ir, "for (const e of this.enemies)"));
      assert.ok(hasEdge(ir, byLabel(ir, "if (this.grounded)"), byLabel(ir, "this.fall();"), "false"));
      assert.ok(byLabel(ir, "switch (this.state)") && byLabel(ir, "catch (e)"));
    });

    await test("テキスト版と tree-sitter 版が、同じコードで同じ構造(ノードの種類の並び・辺の数)を返す", () => {
      const fnText = CS.slice(CS.indexOf("void Update()"), CS.indexOf("void Other()")).trimEnd().replace(/\n    $/, "");
      const text = scan(fnText, "Update()");
      const tree = flow("cs", CS, { row: 4, column: 8 });
      assertWellFormed(text);
      assertWellFormed(tree);
      assert.deepEqual(kinds(text), kinds(tree), "ノードの種類の並び");
      assert.deepEqual(
        text.nodes.map((n) => n.label.replace(/\s+/g, "")),
        tree.nodes.map((n) => n.label.replace(/\s+/g, "")),
        "ラベル",
      );
      assert.equal(text.edges.length, tree.edges.length, "辺の数");
      const norm = (ir) => [...edgeSet(ir)].sort();
      assert.deepEqual(norm(text), norm(tree), "辺の集合(ID・ラベルまで)");
    });
  }

  console.log(`scanner: ${passed} passed`);
})();
