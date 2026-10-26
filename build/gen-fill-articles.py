# -*- coding: utf-8 -*-
"""data/fill-articles.js 生成器

输入：build/_articles-picked.json（curate-articles.py 的产物）
输出：data/fill-articles.js

记录格式（**二维数组 + 紧凑对象混排**，和 data/models-authored-*.js 风格一致）：
    [id, 分类, 标题, 作者, 出处, [段落...], 挖空起始段, 挖空段数, 训练能力, 提示]

三条必须写死的约束（改之前先读）：
  1. **挖空信息只存下标**，正文永远存**完整原文**。这样"孩子补写 vs 原文"的对照
     永远取自同一份文本，不会出现"存了两份、改了一份"的漂移。
  2. 分类只用四个字：写景 / 记事 / 说理 / 抒情，与页面下拉框一一对应；
     "作者页:朱自清" 这种来源信息进 source 字段，不进分类。
  3. 训练能力必须落在 state.skills 的 8 个键里（人物描写/环境描写/细节描写/故事结构/
     语言表达/想象能力/内容与立意/观察描写），否则 updateSkills() 涨不到技能条。
"""
import os, io, json, re, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PICK = os.path.join(HERE, "_articles-picked.json")
OUT = os.path.join(ROOT, "data", "fill-articles.js")

# 分类 → (训练能力, 提示)。提示要"教孩子怎么补"，不是"提示答案"。
BUCKET_META = {
    "写景": ("环境描写", "补写时先想清楚这一段写的是什么时候、什么位置，再按"
             "“看到的颜色—听到的声音—自己的感受”的顺序铺开。"),
    "记事": ("故事结构", "补写时要把这一段里“谁做了什么、遇到了什么、结果怎样”交代清楚，"
             "不要只写结果，中间那一下最关键。"),
    "说理": ("内容与立意", "补写时先说出这一段要讲的道理，再用一件小事或一个例子把它撑起来；"
             "最后补一句自己的看法。"),
    "抒情": ("细节描写", "补写时不要直接写“我很感动”，选一个动作、一个画面，"
             "让读者自己看出来你在感动。"),
}

# 来源标签：作者页要翻译成人名，"Category:xx散文" 翻译成中文分类名
SRC_LABEL = {
    "写景游记类散文": "写景游记·公版",
    "叙事性散文": "叙事散文·公版",
    "议论性散文": "议论散文·公版",
    "抒情性散文": "抒情散文·公版",
}

# 标题里带这些词的，题材对小学生不友好，直接不要（作者/出处还在，只是不选它）
UNSUITABLE = re.compile(
    r"(娼|妓|性|色情|礼赞|礼赞|胡闹|老人|鸦片|抽大烟|赌|杀|血|尸|鬼|坟墓|"
    r"征兵|战争|抗战|抗日|屠杀|国难|帝国主义|国民党|共产党|政|军|革命|五四|"
    r"新文化|文学改良|八股|文字学|文字|语言学|日本|希腊|俄罗斯|巴黎|伦敦|欧洲)"
)


def id_of(i):
    return "fa-%04d" % (i + 1)


def author_of(rec):
    s = rec["src"]
    if s.startswith("Author:"):
        return s.split(":", 1)[1]
    return ""


def bucket_of(rec):
    """分类只看粗类，不看来源。

    ★ 这里踩过一次：curate 里 src 有"作者页:朱自清"和"写景游记类散文"两种，
      bucket 字段对作者页写的是"作者页:朱自清" —— 直接当**分类**用，下拉框里
      就会冒出「作者页:朱自清（59 篇）」这种鬼东西。
      分类（写景/记事/说理/抒情）和来源（维基文库·公版）是**两件事**，不能混。
    """
    b = rec.get("bucket") or ""
    if b in BUCKET_META:
        return b
    # 作者页来源的：按标题粗分（没有更强信号时归到"记事"）
    t = rec["title"]
    if re.search(r"(山|水|湖|江|海|园|寺|花|树|春|秋|夜|雪|雨|月|巷|街|城|游记|杂记|行)", t):
        return "写景"
    if re.search(r"(论|談|谈|说|说|礼赞|赞|评|答|书后|主义|精神|问题)", t):
        return "说理"
    return "记事"


def src_label(rec):
    s = rec["src"]
    if s.startswith("Author:"):
        return "维基文库·公版"
    return SRC_LABEL.get(s, "维基文库·公版")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--keep-unsuitable", action="store_true")
    a = ap.parse_args()

    d = json.load(io.open(PICK, encoding="utf-8"))
    rows = d["picked"]
    if not a.keep_unsuitable:
        rows = [r for r in rows if not UNSUITABLE.search(r["title"])]
    # 稳定排序：分类 → 篇幅（短的在前，孩子更容易起步）
    order = {"记事": 0, "写景": 1, "说理": 2, "抒情": 3}
    rows.sort(key=lambda r: (order.get(bucket_of(r), 9), r["chars"]))
    if a.limit:
        rows = rows[:a.limit]

    out = []
    for i, r in enumerate(rows):
        bucket = bucket_of(r)
        skill, hint = BUCKET_META.get(bucket, ("语言表达", ""))
        out.append([
            id_of(i), bucket, r["title"], author_of(r), src_label(r),
            r["paras"], r["gapStart"], r["gapCount"], skill, hint
        ])
        assert len(out[-1]) == 10, out[-1]

    head = """/* 文章补写素材库（自动生成，勿手改）
 *
 * 来源：维基文库（zh.wikisource.org）**公有领域**中文散文。全部篇目的作者均于
 * 1945 年前后已故，作品已进入公有领域，可离线分发；出处与作者在界面上逐篇标注。
 * 抓取/策展/生成三步的脚本在 build/ 下：
 *   build/fetch-articles.py   拉目录 + 拉正文（带缓存与 429 退避）
 *   build/curate-articles.py  去噪、简繁统一、挑挖空段、按篇幅/段数筛
 *   build/gen-fill-articles.py 生成本文件
 *
 * 条目格式：
 *   [id, 分类, 标题, 作者, 出处, [段落...], 挖空起始段, 挖空段数, 训练能力, 补写提示]
 *
 * ★ 挖空只用**下标**表示（gapStart / gapCount），正文永远是**完整原文**。
 *   页面渲染时把这几段换成"空缺卡片"，提交后拿同一条记录里的段落做对照 ——
 *   一份数据两处用，不会出现"存了两份、改了一份"的漂移。
 * ★ 分类只有四个字：写景 / 记事 / 说理 / 抒情，与下拉框一一对应。
 * ★ 训练能力必须落在 state.skills 的键里，否则 updateSkills() 涨不到技能条。
 */
window.FILL_ARTICLE_LIBRARY = [
"""
    lines = []
    for row in out:
        idv, bucket, title, author, src, paras, gs, gc, skill, hint = row
        paras_js = "[" + ",".join(json.dumps(p, ensure_ascii=False) for p in paras) + "]"
        lines.append("  [%s,%s,%s,%s,%s,%s,%d,%d,%s,%s]" % (
            json.dumps(idv), json.dumps(bucket, ensure_ascii=False),
            json.dumps(title, ensure_ascii=False), json.dumps(author, ensure_ascii=False),
            json.dumps(src, ensure_ascii=False), paras_js, gs, gc,
            json.dumps(skill, ensure_ascii=False), json.dumps(hint, ensure_ascii=False)))

    body = ",\n".join(lines)
    io.open(OUT, "w", encoding="utf-8", newline="\n").write(head + body + "\n];\n")

    from collections import Counter
    print("已写 %s：%d 篇" % (OUT, len(rows)))
    print("分类：", dict(Counter(r[1] for r in out)))
    print("作者数：", len({r[3] for r in out if r[3]}))
    print("文件大小：%.1f KB" % (os.path.getsize(OUT) / 1024.0))


if __name__ == "__main__":
    main()
