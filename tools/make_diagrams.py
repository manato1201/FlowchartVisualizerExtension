"""docs/diagrams/ の構成図(SVG)を作る。`python tools/make_diagrams.py` で作り直す。部品は tools/svgkit.py。"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from svgkit import Diagram  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "docs" / "diagrams"


def architecture() -> Diagram:
    d = Diagram(1560, 780, "FlowchartVisualizerExtension の構成",
                "3 つの IDE(VS Code・Visual Studio・Rider)が、それぞれ固有の方法でコードの制御構造を読み、共通の中間表現 FlowchartIR に変換する。"
                "IR は core/ の共有部品(差分・全体階層・Mermaid 変換)を通り、3 ホストで同じ共有 Webview バンドルが描く。")
    d.text(40, 44, "FlowchartVisualizerExtension — 構成", cls="hd")
    d.text(40, 66, "青=主な流れ / 灰の破線=補助。読む側(抽出)はホスト固有、IR と描画は共有", cls="note")

    d.group(40, 100, 300, 600, "HOSTS — 抽出はホスト固有", color="gray")
    vs = d.card(190, 220, "extension", "VS Code(TypeScript)", "DocumentSymbol + 括弧の走査\n(シンボル無しなら tree-sitter)")
    vsx = d.card(190, 400, "gear", "Visual Studio(C#)", "Roslyn ControlFlowGraph\n→ SyntaxWalker")
    rd = d.card(190, 580, "terminal", "Rider(Kotlin)", "Java PSI(C# は未対応)")

    d.group(400, 100, 320, 600, "CORE — 共有の中間表現", color="teal")
    ir = d.card(560, 400, "branch", "FlowchartIR", "nodes・edges\nsourceFile・generatedAt")
    diff = d.card(560, 220, "check", "diff/ir-diff.ts", "LCS で HEAD と比べる\n(追加・削除・変更)")
    arch = d.card(560, 580, "folder", "architecture/", "CodeBoarding の analysis.json\n→ 全体 › ファイル › 関数")

    d.group(780, 100, 400, 600, "WEBVIEW — 3 ホスト共通のバンドル", color="blue")
    br = d.card(980, 220, "browser", "bridge.js", "メッセージ・書き出し・ジャンプ")
    vw = d.card(980, 400, "list", "views.js", "フロー / 呼び出し / 状態\n(純粋関数・UMD)")
    mo = d.card(980, 580, "pulse", "motion.js・viewport.js", "動き・パン・ズーム・ミニマップ")

    d.group(1240, 100, 280, 600, "OUTPUT — 書き出し", color="orange")
    mm = d.card(1380, 260, "doc", "Mermaid", "flowchart TD(テキスト)")
    sv = d.card(1380, 400, "film", "SVG / PNG", "表示中のビューを画像に")
    mc = d.card(1380, 540, "wave", "魔方陣(エンタメ)", "別リポジトリの入力 JSON")

    # ホスト → IR(縦の幹線 x=370 に合流)
    d.arrow([vs.right, (370, 220), (370, 400), ir.left], "FlowchartIR に変換", at=2, dx=-10, dy=-10)
    d.arrow([vsx.right, (370, 400)], "")
    d.arrow([rd.right, (370, 580), (370, 400)], "")
    # IR → 共有部品(カードの下に文字があるので、横の幹線 x=670 を通す)
    d.arrow([ir.right, (670, 400), (670, 220), diff.right], "HEAD と比較", kind="secondary", at=1, dx=0, dy=-10)
    d.arrow([(670, 400), (670, 580), arch.right], "全体階層", kind="secondary", at=1, dx=0, dy=0)
    # IR → Webview
    d.arrow([ir.right, (750, 400), vw.left], "IR を渡す", at=0, dy=-10)
    d.arrow([(750, 400), (750, 220), br.left], "")
    d.arrow([br.right, (1210, 220), (1210, 260), mm.left], "")
    d.arrow([vw.right, sv.left], "表示中のビュー", at=0, dy=-10)
    d.arrow([(750, 400), (750, 740), (1210, 740), (1210, 540), mc.left], "別のエミッター", kind="secondary", at=1, dy=-10)
    return d


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "architecture.svg").write_text(architecture().svg(), encoding="utf-8")
    print("wrote", OUT / "architecture.svg")


if __name__ == "__main__":
    main()
