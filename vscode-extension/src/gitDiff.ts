import { execFile } from "child_process";
import * as path from "path";
import * as vscode from "vscode";

/**
 * 変更前(Git の HEAD)のファイル全文を取り出す。X3(フロー差分)で、現在の関数と比べるために使う。
 *   - ok        : HEAD に存在する(text は改行を LF にそろえたもの)
 *   - untracked : HEAD に存在しない(新規ファイル・未追跡)。全関数が「追加」扱いになる
 *   - error     : Git を使えない(リポジトリ外・git コマンドが無い等)。理由は message
 */
export type HeadText =
  | { kind: "ok"; text: string }
  | { kind: "untracked" }
  | { kind: "error"; message: string };

function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 15000, windowsHide: true, encoding: "buffer" },
      (error, stdout, stderr) => {
        const out = Buffer.from(stdout ?? "").toString("utf8");
        const err = Buffer.from(stderr ?? "").toString("utf8");
        if (!error) {
          resolve({ stdout: out, stderr: err, code: 0 });
          return;
        }
        // 終了コードなら number、起動失敗(git が無い等)なら "ENOENT" のような文字列
        const code = (error as NodeJS.ErrnoException).code;
        resolve({
          stdout: out,
          stderr: typeof code === "string" ? `${err} ${code}` : err,
          code: typeof code === "number" ? code : -1,
        });
      },
    );
  });
}

export async function getHeadText(doc: vscode.TextDocument): Promise<HeadText> {
  if (doc.isUntitled || doc.uri.scheme !== "file") {
    return { kind: "error", message: "保存されたファイルではないため、HEAD と比べられません。" };
  }
  const cwd = path.dirname(doc.fileName);
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    const missing = /ENOENT/.test(top.stderr);
    return {
      kind: "error",
      message: missing
        ? "git コマンドが見つかりません。Git をインストールしてください。"
        : "このファイルは Git リポジトリの中にありません。",
    };
  }
  const rel = path.relative(top.stdout.trim(), doc.fileName).split(path.sep).join("/");
  const shown = await git(cwd, ["show", `HEAD:${rel}`]);
  if (shown.code === 0) {
    return { kind: "ok", text: shown.stdout.replace(/\r\n/g, "\n") };
  }
  // HEAD にそのパスが無い(新規ファイル)、または最初のコミット前
  if (/exists on disk, but not in|does not exist in|unknown revision|bad revision|invalid object name|ambiguous argument 'HEAD'/i.test(shown.stderr)) {
    return { kind: "untracked" };
  }
  return { kind: "error", message: `Git から変更前の内容を取得できませんでした: ${shown.stderr.trim().split("\n")[0]}` };
}
