import type { FlowchartIR } from "../../core/flowchart-ir/schema";
import { maskCodeEx, matchBracket } from "./codeMask";
import { scanControlFlowHeuristic } from "./controlFlowScanner";

/**
 * `vscode` に依存しない、テキストだけを扱う関数群(Node 単体でテストできる)。
 *   - checkBraceBalance  : 編集中の構文エラー(波括弧の対応不整合)を検出する
 *   - sliceFunctionByName: 変更前(HEAD)のファイル全文から、名前で関数を切り出す(X3 の差分用)
 *   - plainFunctionName  : 「Update()」「Player.Update」などを素の関数名「Update」にする
 *   - irFromFunctionText : 関数宣言のテキストから FlowchartIR を作る
 *
 * 括弧の探索・文字列とコメントの読み飛ばしは codeMask.ts に一本化している。
 */

/** 文字列・コメントを読み飛ばして波括弧の対応を調べる。 */
export function checkBraceBalance(text: string): { ok: true } | { ok: false; reason: string } {
  const { masked, unclosedBlockComment } = maskCodeEx(text);
  if (unclosedBlockComment) return { ok: false, reason: "コメント /* が閉じられていません" };
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0) return { ok: false, reason: "閉じ波括弧 } が余っています" };
    }
  }
  if (depth > 0) return { ok: false, reason: "開き波括弧 { が閉じられていません" };
  return { ok: true };
}

/** 関数宣言のテキストから、制御フローのノード・エッジを組み立てる(vscode.* に依存しない)。 */
export function irFromFunctionText(text: string, startLine: number, label: string, sourceFile: string): FlowchartIR {
  const { nodes, edges } = scanControlFlowHeuristic(text, startLine, label);
  return { nodes, edges, sourceFile, generatedAt: new Date().toISOString() };
}

/** 「Update()」「Player.Update」「void Update(int x)」→「Update」。 */
export function plainFunctionName(label: string): string {
  const head = label.split("(")[0].trim();
  const last = head.split(/[\s.:]+/).filter(Boolean).pop() ?? head;
  return last.replace(/<.*$/, "");
}

const NOT_A_DEFINITION_BEFORE = /(?:^|[^\w$])(?:return|new|else|case|throw|await|yield|typeof|in|of|is|as|not|and|or)\s*$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SlicedFunction {
  /** 関数宣言の行頭から、本体の閉じ波括弧まで */
  text: string;
  /** text 1行目の行番号(0始まり) */
  startLine: number;
}

/**
 * ファイル全文から、`name` の関数/メソッド定義(本体が `{ ... }` のもの)を切り出す。
 * 同名の定義が複数あるとき(C# のオーバーロード等)は、出現順の `nth` 番目(0始まり)を返す。
 *
 * 呼び出し(`if (Update(x)) {`、`Update(x);`)を定義と取り違えないため、
 *   - 名前の直前が `(` `=` `.` `,` `!` などなら定義ではない
 *   - 引数の `)` の後ろが `;` なら定義ではない(宣言のみ・呼び出し)
 *   - 直前が return / new / else などの語なら定義ではない
 * 式形式のメンバー(`=> expr;`)は波括弧がなく、この拡張の対象外(切り出さない)。
 *
 * 探索はマスク(コメント・文字列を空白にしたテキスト)に対して行うので、
 * 文字列やコメントの中の関数名・括弧には引っかからない。
 */
export function sliceFunctionByName(text: string, name: string, nth = 0): SlicedFunction | null {
  const { masked } = maskCodeEx(text);
  const re = new RegExp("(^|[^\\w$])" + escapeRegExp(name) + "\\s*(?:<[^<>(){};]*>)?\\s*\\(", "g");
  let seen = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const nameStart = m.index + m[1].length;
    const parenIdx = m.index + m[0].length - 1;

    // 直前(同じ行内)の文字で、定義か呼び出しかを判定する
    const lineStart = masked.lastIndexOf("\n", nameStart - 1) + 1;
    const before = masked.slice(lineStart, nameStart).trimEnd();
    if (before.length > 0) {
      const last = before[before.length - 1];
      if (/[(=.,!?:+\-*/%<|&^[]/.test(last) && !/[>\]]$/.test(before)) continue;
      if (NOT_A_DEFINITION_BEFORE.test(before)) continue;
    }

    const close = matchBracket(masked, parenIdx, "(", ")");
    if (close < 0) continue;

    // 引数の後ろ: `{` までに `;` や `=>` が先に来たら定義ではない
    let i = close + 1;
    let found = -1;
    let angle = 0;
    while (i < masked.length) {
      const c = masked[i];
      if (c === "<") angle++;
      else if (c === ">" && masked[i - 1] !== "=" && angle > 0) angle--;
      else if (c === ";" && angle === 0) break;
      else if (c === "=" && masked[i + 1] === ">") break;
      else if (c === "{" && angle === 0) {
        found = i;
        break;
      } else if (c === "(") {
        const e = matchBracket(masked, i, "(", ")");
        if (e < 0) break;
        i = e;
      }
      i++;
    }
    if (found < 0) continue;
    const end = matchBracket(masked, found, "{", "}");
    if (end < 0) continue;

    if (seen++ < nth) {
      re.lastIndex = end; // 見つかった定義の内側は探さない
      continue;
    }
    return {
      text: text.slice(lineStart, end + 1),
      startLine: text.slice(0, lineStart).split("\n").length - 1,
    };
  }
  return null;
}
