/**
 * ソースの「構造を読むための」下ごしらえ。コメントと文字列リテラルの中身を空白に置き換えた、
 * 同じ長さ・同じ改行位置のテキスト(マスク)を作る。
 *
 * 制御構文のキーワード・波括弧・丸括弧を探すときはマスクを見る。こうすると
 *   var s = "if (x) { y(); }";   // for (;;) { }
 * のような行を構文と取り違えない。ラベルに出す文字列は、同じ位置の元のテキストから取る。
 * (以前は、波括弧の対応・括弧の探索・キーワード検出がそれぞれ別の簡易処理で、
 *  文字列やコメントの扱いがばらばらだった。)
 *
 * vscode に依存しない純粋関数。
 */

export interface MaskResult {
  masked: string;
  /** `/*` が閉じられていない(編集中の構文エラーの目印) */
  unclosedBlockComment: boolean;
}

export function maskCodeEx(text: string): MaskResult {
  const n = text.length;
  const out = text.split("");
  let unclosedBlockComment = false;

  /** [from, to) を空白にする。改行は残す(行番号を保つ)。 */
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      const c = out[k];
      if (c !== "\n" && c !== "\r") out[k] = " ";
    }
  };

  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];

    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }

    if (c === "/" && d === "*") {
      const j = text.indexOf("*/", i + 2);
      if (j < 0) {
        blank(i, n);
        unclosedBlockComment = true;
        i = n;
      } else {
        blank(i, j + 2);
        i = j + 2;
      }
      continue;
    }

    if (c === '"') {
      // C# の生文字列 """...""" と逐語的文字列 @"..." / $@"..." は複数行にまたがる
      if (text.startsWith('"""', i)) {
        const j = text.indexOf('"""', i + 3);
        const stop = j < 0 ? n : j;
        blank(i + 3, stop);
        i = j < 0 ? n : j + 3;
        continue;
      }
      const verbatim =
        text[i - 1] === "@" || (text[i - 1] === "$" && text[i - 2] === "@");
      let j = i + 1;
      if (verbatim) {
        while (j < n) {
          if (text[j] === '"') {
            if (text[j + 1] === '"') j += 2;
            else break;
          } else j++;
        }
      } else {
        // 通常の文字列は同じ行で閉じる。閉じ忘れは行末で打ち切る(後続を巻き込まない)
        while (j < n && text[j] !== '"' && text[j] !== "\n") {
          j += text[j] === "\\" ? 2 : 1;
        }
      }
      blank(i + 1, Math.min(j, n));
      i = text[j] === '"' ? j + 1 : j;
      continue;
    }

    if (c === "'") {
      // 文字リテラル / JS の単引用符文字列。同じ行に閉じ引用符が無ければ、ただのアポストロフィとして扱う
      let j = i + 1;
      while (j < n && text[j] !== "'" && text[j] !== "\n") {
        j += text[j] === "\\" ? 2 : 1;
      }
      if (text[j] === "'") {
        blank(i + 1, j);
        i = j + 1;
      } else {
        i++;
      }
      continue;
    }

    if (c === "`") {
      // JS のテンプレートリテラル(複数行・${...} を含む)
      let j = i + 1;
      while (j < n && text[j] !== "`") {
        j += text[j] === "\\" ? 2 : 1;
      }
      blank(i + 1, Math.min(j, n));
      i = j + 1;
      continue;
    }

    i++;
  }

  return { masked: out.join(""), unclosedBlockComment };
}

export function maskCode(text: string): string {
  return maskCodeEx(text).masked;
}

/** マスク済みテキストで、openIdx の `open` に対応する閉じ括弧の位置(なければ -1)。 */
export function matchBracket(
  masked: string,
  openIdx: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    const c = masked[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
