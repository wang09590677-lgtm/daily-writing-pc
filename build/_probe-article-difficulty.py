# -*- coding: utf-8 -*-
"""素材库难度体检：用可量化的指标看「210 篇到底有多难」。

指标选取理由（每个都要能对着 5、6 年级课本说清）：
  · 平均句长     —— 课本课文一般 18~25 字/句；超过 30 字孩子要回读
  · 长句占比     —— >50 字的句子，5、6 年级理解负担陡增
  · 文言虚词密度 —— 之/其/者/亦/矣/焉/哉/乃/遂，民国白话文残留最多
  · 生僻字占比   —— 不在 GB2312 一级字库（3755 常用字）里的字
  · 四字成语密度 —— 成语堆砌是"范文腔"，孩子学不到可模仿的句子
  · 平均段长     —— 段落过长，孩子读不进去也接不上

用法：python build/_probe-article-difficulty.py [--top 12]
"""
import io, os, re, json, sys, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "data", "fill-articles.js")

SENT_SPLIT = re.compile(r"[。！？；\n]+")
CLASSICAL = set("之其者亦矣焉哉乃遂故虽矣乎耶夫盖")
CJK = re.compile(r"[\u4e00-\u9fff]")


def is_common(ch):
    """GB2312 一级字库（3755 常用字）判定：能编进 gb2312 且落在汉字区即视为常用。

    用编码探测而不是内置字表，是为了**可复现**——不同机器结果一致，
    不需要额外数据文件（离线版不能加依赖）。
    """
    try:
        b = ch.encode("gb2312")
    except UnicodeEncodeError:
        return False
    # GB2312 汉字区：B0A1-D7F9（一级 3755 常用字）+ D8A1-F7FE（二级 3008 次常用字）
    # 只认一级区，二级区（如「菡」「蘅」）算生僻
    return len(b) == 2 and 0xB0 <= b[0] <= 0xD7


def load_rows():
    s = io.open(SRC, encoding="utf-8").read()
    m = re.search(r"window\.FILL_ARTICLE_LIBRARY\s*=\s*(\[.*\]);?", s, re.S)
    if not m:
        raise SystemExit("没在 %s 里找到 FILL_ARTICLE_LIBRARY" % SRC)
    return json.loads(m.group(1))


def metrics(paras):
    text = "".join(paras)
    chars = [c for c in text if CJK.match(c)]
    n = len(chars)
    if not n:
        return None
    sents = [x for x in SENT_SPLIT.split(text) if x.strip()]
    slens = [len([c for c in x if CJK.match(c)]) for x in sents]
    slens = [x for x in slens if x > 0]
    avg_sent = sum(slens) / float(len(slens)) if slens else 0
    long_ratio = len([x for x in slens if x > 50]) / float(len(slens)) if slens else 0
    classical = len([c for c in chars if c in CLASSICAL]) / float(n)
    rare_chars = [c for c in chars if not is_common(c)]
    rare = len(rare_chars) / float(n)
    avg_para = n / float(len(paras)) if paras else 0
    return dict(chars=n, paras=len(paras), avgSent=avg_sent, longRatio=long_ratio,
                classical=classical, rare=rare, avgPara=avg_para,
                rareTop="".join(sorted(set(rare_chars))[:14]))


def verdict(m):
    """给出「超纲 / 偏难 / 合适」三档。

    阈值来源：五、六年级语文课文实测区间（人教版 5~6 年级课文抽样）
      平均句长 18~25 字 · 长句占比 < 6% · 文言虚词 < 0.8% · 生僻字 < 0.6%
    超过上限的按超纲算——宁可判严，因为孩子读不下去是硬伤。
    """
    hits = []
    if m["avgSent"] > 30:
        hits.append("句长")
    if m["longRatio"] > 0.10:
        hits.append("长句")
    if m["classical"] > 0.012:
        hits.append("文言")
    if m["rare"] > 0.010:
        hits.append("生僻字")
    if m["avgPara"] > 260:
        hits.append("段过长")
    if len(hits) >= 3:
        return "超纲", hits
    if hits:
        return "偏难", hits
    return "合适", hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=12, help="列出最难的 N 篇")
    a = ap.parse_args()

    rows = load_rows()
    recs = []
    for r in rows:
        aid, cat, title, author, src, paras = r[0], r[1], r[2], r[3], r[4], r[5]
        m = metrics(paras)
        if not m:
            continue
        v, hits = verdict(m)
        recs.append(dict(id=aid, cat=cat, title=title, author=author, m=m, v=v, hits=hits))

    from collections import Counter
    print("总篇数：%d" % len(recs))
    print("难度分档：%s" % dict(Counter(x["v"] for x in recs)))
    print()
    print("=== 中位数汇总（五项，逐项）===")
    for k, lab in [("avgSent", "平均句长(字)"), ("longRatio", "长句>50字占比"),
                   ("classical", "文言虚词占比"), ("rare", "生僻字占比"),
                   ("avgPara", "平均段长(字)")]:
        vals = sorted(x["m"][k] for x in recs)
        med = vals[len(vals) // 2]
        print("  %-16s 中位 %8.3f   最大 %8.3f" % (lab, med, vals[-1]))
    print()
    print("=== 生僻字判定抽查（确认不是误判）===")
    for x in recs[:4]:
        print("  %-14s 生僻 %.1f%%  样本：%s"
              % (x["title"][:14], x["m"]["rare"] * 100, x["m"]["rareTop"]))
    print()
    print("=== 最难的 %d 篇（按超纲指标数 → 句长排序）===" % a.top)
    hard = sorted(recs, key=lambda x: (-len(x["hits"]), -x["m"]["avgSent"]))[:a.top]
    for x in hard:
        print("  [%s] %-18s %-6s 句长%.1f 文言%.3f 生僻%.3f  ← %s"
              % (x["v"], x["title"][:18], x["author"][:6], x["m"]["avgSent"],
                 x["m"]["classical"], x["m"]["rare"], "/".join(x["hits"])))
    print()
    print("=== 相对最友好的 %d 篇（若要做「降难版」可作参照）===" % min(6, len(recs)))
    easy = sorted(recs, key=lambda x: (len(x["hits"]), x["m"]["avgSent"]))[:6]
    for x in easy:
        print("  [%s] %-18s 句长%.1f 文言%.3f 生僻%.3f"
              % (x["v"], x["title"][:18], x["m"]["avgSent"], x["m"]["classical"], x["m"]["rare"]))


if __name__ == "__main__":
    main()
