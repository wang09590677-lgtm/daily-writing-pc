# -*- coding: utf-8 -*-
"""公版儿童文学库存探测（只读，不写产品文件）。

为什么先探再抓：候选作家必须先过**两道闸**，过不了的白抓一遍。
  闸 1｜版权：中国著作权法 = 作者终生 + 死后 50 年，截止于死后第 50 年 12 月 31 日。
        以 2026-10 为基准，公版线是「1975 年 12 月 31 日前去世」。
  闸 2｜库存：维基文库要求作品在**美国 + 来源国**都属公有领域。
        1930 年后出版的作品在美国要等 95 年（1934 年出版 → 2029 才公版），
        所以「中国已公版」不等于「维基文库上有」。

用法：python build/_probe-children-lit.py
"""
import os, sys, io, json, time, random, re, argparse
import urllib.parse, urllib.request, urllib.error

API = "https://zh.wikisource.org/w/api.php"
UA = "KidsWritingApp/1.0 (offline Chinese writing trainer for primary school)"

# 候选：儿童文学 / 儿童题材散文作家。dead = 卒年，pd_year = 中国公版年
CANDIDATES = [
    ("老舍",   1966, "散文与儿童小说，《小坡的生日》《济南的冬天》"),
    ("丰子恺", 1975, "《缘缘堂随笔》，大量儿童视角散文"),
    ("鄭振鐸", 1958, "《海燕》《猫》，儿童文学翻译与创作"),
    ("郑振铎", 1958, "同上（简体重定向）"),
    ("朱湘",   1933, "《咬菜根》，语言浅"),
    ("夏丏尊", 1946, "《平屋杂文》，已在旧库"),
    ("許地山", 1941, "《落花生》，已在候选池"),
    ("叶绍钧", 1988, "叶圣陶本名 —— 未公版，预期查不到"),
    ("冰心",   1999, "未公版，预期查不到"),
    ("張天翼", 1985, "未公版，预期查不到"),
]


def api(**params):
    params.setdefault("format", "json")
    params.setdefault("formatversion", "2")
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last = None
    for i in range(5):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 502, 503, 504):
                wait = 5 * (2 ** i) + random.uniform(0, 2)
                print("      %d，等 %.0fs 重试" % (e.code, wait), flush=True)
                time.sleep(wait)
                continue
            raise
        except Exception as e:
            last = e
            time.sleep(3)
    raise RuntimeError("请求失败：%s" % last)


def author_pages(name):
    """作者页下挂的作品（Author: 命名空间的子页面）。"""
    try:
        d = api(action="query", list="prefixsearch",
                pssearch="Author:" + name + "/", pslimit="100", psnamespace="0")
        hits = d.get("query", {}).get("prefixsearch", []) or []
        return [h["title"] for h in hits]
    except Exception as e:
        return []


def category_pages(cat):
    try:
        d = api(action="query", list="categorymembers", cmtitle="Category:" + cat,
                cmlimit="200", cmnamespace="0")
        return [h["title"] for h in d.get("query", {}).get("categorymembers", []) or []]
    except Exception as e:
        return []


def main():
    print("基准日：2026-10 · 公版线 = 1975-12-31 前去世\n")
    print("%-8s %-6s %-8s %-6s %s" % ("作家", "卒年", "中国公版", "库存", "说明"))
    print("-" * 78)
    total = 0
    for name, dead, note in CANDIDATES:
        pd_ok = dead <= 1975
        pages = author_pages(name) if pd_ok else []
        # 作者页没挂子页时，试分类页
        if pd_ok and not pages:
            pages = category_pages(name)
        total += len(pages)
        flag = "OK" if pd_ok else "未公版"
        print("%-8s %-6d %-8s %-6d %s" % (name, dead, flag, len(pages), note))
        if pages:
            print("         样例：%s" % " / ".join(p.replace("Author:" + name + "/", "") for p in pages[:6]))
        time.sleep(1.0)

    print("-" * 78)
    print("公版候选合计（去重前）：%d 篇" % total)
    print("\n注意：上面只是**标题数**，还要过篇幅/段数/挖空/难度四道闸，")
    print("      历史经验是 100 个标题能留下 30~40 篇成品。")


if __name__ == "__main__":
    main()
