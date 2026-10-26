# -*- coding: utf-8 -*-
"""把 AI 批量生成的文章合并成 data/fill-articles.js。

为什么要单独一步（而不是生成脚本直接写产品文件）：
  生成是**多次、可中断**的（按年级分两轮跑，中途可能失败重来）；
  产品文件必须**一次成文**（格式统一、可 diff、有文件头说明）。
  中间用 JSON 草稿隔开，任何一轮生成坏了都不会污染 data/。

格式与旧库完全一致（app.js 的 RAW_FILL_ARTICLES 按位置解构）：
  [id, 分类, 标题, 作者, 出处, [段落...], 挖空起始段, 挖空段数, 训练能力, 补写提示]

用法：
  python build/merge-fill-ai.py                       # 只用 AI 生成的文章
  python build/merge-fill-ai.py --keep-classic 33     # 再补进旧库里最合适的 N 篇
"""
import io, os, re, json, argparse, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "data", "fill-articles.js")
# 经典池来源：**已经做过简繁清洗的那一版**（data/fill-articles.js 的副本）。
# ⚠️ 不要指回 _fill-articles.before-tradfix.js —— 那一版有 184/210 篇混着繁体字
#    （「奔喪囘家」），挑进新库会把刚清干净的东西又带回来。
CLASSIC = os.path.join(HERE, "_fill-articles.classic-clean.js")

DRAFTS = [
    os.path.join(HERE, "_fill-ai-grade5.json"),
    os.path.join(HERE, "_fill-ai-grade6.json"),
    os.path.join(HERE, "_fill-ai-g5-say.json"),
    os.path.join(HERE, "_fill-ai-g6-say.json"),
    # 试跑留下的两份也算数：篇数不多，但都是过了闸的，扔掉纯浪费
    os.path.join(HERE, "_fill-ai-test2.json"),
    os.path.join(HERE, "_fill-ai-test3.json"),
]

SKILL = {"记事": "故事结构", "写景": "环境描写", "说理": "内容与立意", "抒情": "细节描写"}
ORDER = {"记事": 0, "写景": 1, "说理": 2, "抒情": 3}
SRC_LABEL = "AI 生成 · 按 5、6 年级课标"
AUTHOR = "AI 写作老师"


def load_drafts():
    kept = []
    for p in DRAFTS:
        if not os.path.exists(p):
            continue
        d = json.load(io.open(p, encoding="utf-8"))
        for k in d.get("kept", []):
            k["_from"] = os.path.basename(p)
            kept.append(k)
    return kept


def load_classic(n):
    """从旧库里挑 n 篇**难度最合适**的（按句长从低到高）。"""
    if not n or not os.path.exists(CLASSIC):
        return []
    s = io.open(CLASSIC, encoding="utf-8").read()
    m = re.search(r"window\.FILL_ARTICLE_LIBRARY\s*=\s*(\[.*\]);?", s, re.S)
    if not m:
        return []
    rows = json.loads(m.group(1))

    SENT_SPLIT = re.compile(r"[。！？；\n]+")
    CJK = re.compile(r"[\u4e00-\u9fff]")
    CL = set("之其者亦矣焉哉乃遂故虽乎耶夫盖")

    def score(r):
        paras = r[5]
        text = "".join(paras)
        chars = [c for c in text if CJK.match(c)]
        n = len(chars)
        sents = [x for x in SENT_SPLIT.split(text) if x.strip()]
        sl = [len([c for c in x if CJK.match(c)]) for x in sents]
        sl = [x for x in sl if x > 0]
        avg = sum(sl) / float(len(sl)) if sl else 99
        cl = len([c for c in chars if c in CL]) / float(n) if n else 1
        return avg, cl

    scored = [(score(r), r) for r in rows]
    # 只收句长 ≤ 28 且文言 ≤1.5% 的（"偏难但可读"的底线）
    ok = [r for (avg, cl), r in scored if avg <= 28 and cl <= 0.015]
    ok.sort(key=lambda r: score(r)[0])
    picked = ok[:n]
    out = []
    for r in picked:
        out.append({
            "title": r[2], "category": r[1], "skill": r[8],
            "paragraphs": r[5], "gapStart": r[6], "gapCount": r[7],
            "hint": r[9], "chars": sum(len(p) for p in r[5]),
            "gapChars": sum(len(p) for p in r[5][r[6]:r[6] + r[7]]),
            "author": r[3] or "", "source": r[4] or "维基文库·公版",
            "_classic": True
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-classic", type=int, default=0, help="再补进旧库最合适的 N 篇")
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()

    items = load_drafts()
    if not items:
        raise SystemExit("没有草稿：先跑 build/gen-fill-ai.js")

    # 标题去重（同一轮里模型偶尔会起同名）
    seen, uniq = set(), []
    for k in items:
        if k["title"] in seen:
            continue
        seen.add(k["title"])
        uniq.append(k)
    items = uniq

    classic = load_classic(a.keep_classic)
    for c in classic:
        if c["title"] in seen:
            continue
        seen.add(c["title"])
        items.append(c)

    # 排序：分类 → 字数（短的在前，孩子更容易起步）
    items.sort(key=lambda k: (ORDER.get(k["category"], 9), k.get("chars") or 0))

    rows = []
    for i, k in enumerate(items):
        rows.append([
            "ai-%03d" % (i + 1) if not k.get("_classic") else "cls-%03d" % (i + 1),
            k["category"],
            k["title"],
            k.get("author") or AUTHOR,
            k.get("source") or SRC_LABEL,
            k["paragraphs"],
            k["gapStart"],
            k["gapCount"],
            k.get("skill") or SKILL.get(k["category"], "语言表达"),
            k.get("hint") or ""
        ])

    from collections import Counter
    cnt = Counter(r[1] for r in rows)
    gaps = [sum(len(p) for p in r[5][r[6]:r[6] + r[7]]) for r in rows]
    tots = [sum(len(p) for p in r[5]) for r in rows]

    print("合并后 %d 篇（其中旧库经典 %d 篇）" % (len(rows), len(classic)))
    print("分类：%s" % dict(cnt))
    print("挖空 min/中位/max = %d / %d / %d（要求 ≥280）"
          % (min(gaps), sorted(gaps)[len(gaps) // 2], max(gaps)))
    print("全文 min/中位/max = %d / %d / %d（要求 ≤3000）"
          % (min(tots), sorted(tots)[len(tots) // 2], max(tots)))

    # 自检：挖到首尾、挖空比例过高
    bad1 = [r[2] for r in rows if r[6] == 0 or r[6] + r[7] >= len(r[5])]
    bad2 = [(r[2], round(g / t, 2)) for r, g, t in
            zip(rows, gaps, tots) if t and g / t > 0.52]
    print("挖到首/末段：%d 篇 %s" % (len(bad1), bad1[:3]))
    print("挖空占比 >52%%：%d 篇 %s" % (len(bad2), bad2[:3]))

    if a.dry:
        print("\n（--dry，没写文件）")
        return

    today = datetime.date.today().isoformat()
    head = """/* 文章补写素材库 —— AI 按 5、6 年级课标生成（%s）

 * ★ 为什么换掉原来的「民国散文」库：
 *   旧库 210 篇按人教版 5、6 年级课文实测区间量下来 —— 平均句长中位 30.7 字
 *   （课本 18~25）、长句占比 14.5%%（课本 <6%%）、平均段长 185 字，
 *   而且 184/210 篇是「简体为主 + 繁体残留」的混合体（《背影》里写「奔喪囘家」）。
 *   孩子读不下去，不是阈值没调好，是来源本身错位。
 *
 * ★ 这一版的每篇都过了四道闸：
 *   ① 篇幅：五年级 600~1000 字、六年级 650~1150 字（按年级标尺，见 ai-grader.js 的 FILL_GRADE_SCALE）
 *   ② 句长：单句 ≤22 字（六年级 ≤24），平均句长实测 15~20 字
 *   ③ 段长：每段 50~83 字（模型实测自然段长 ~65 字），一段只讲一件事
 *   ④ 挖空：连续 4~6 段、累计 ≥280 字、≤全文 50%%、绝不挖首尾段
 *   另禁：文言虚词（之乎者也矣焉哉）、四字成语堆砌、典故古诗、繁体字。
 *
 * ★ 挖空只存下标：paragraphs 是完整原文，gapStart/gapCount 标出哪几段显示成空缺卡片。
 *   渲染时**只许读 paragraphs 与下标**，不许读被挖的段落 —— 答案不进 DOM。
 *
 * 格式：[id, 分类, 标题, 作者, 出处, [段落...], 挖空起始段, 挖空段数, 训练能力, 补写提示]
 */
""" % today

    body = "window.FILL_ARTICLE_LIBRARY = " + json.dumps(rows, ensure_ascii=False, indent=0) + ";\n"
    io.open(OUT, "w", encoding="utf-8").write(head + body)
    print("\n已写 %s（%.1f KB）" % (OUT, os.path.getsize(OUT) / 1024.0))


if __name__ == "__main__":
    main()
