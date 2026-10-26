# -*- coding: utf-8 -*-
"""文章补写素材库 · 公版儿童文学/浅近白话散文 取材（只读，不写产品文件）

为什么要换来源（2026-10-18 实测结论）：
  旧库 210 篇全是民国「文白夹杂」的散文（朱自清/周作人/闻一多/郁达夫），
  按人教版 5、6 年级课文的实测区间量下来 —— 平均句长中位 30.7 字（课本 18~25）、
  长句占比 14.5%（课本 <6%）、平均段长 185 字 —— 210 篇里 0 篇达标。
  这不是阈值没调好，是**来源本身错位**：民国散文的语言密度天然高于小学课文。

  换成语言最浅的近现代白话作家，并按「课本级」硬指标筛。

版权闸（中国著作权法：终生 + 死后 50 年，截止于死后第 50 年 12 月 31 日）：
  以 2026-10 为基准，公版线 = 1975-12-31 前去世。
  ✅ 老舍 1966 · 鄭振鐸 1958 · 夏丏尊 1946 · 許地山 1941
  ❌ 叶圣陶 1988 · 冰心 1999 · 张天翼 1985 · 丰子恺 1975（分类页仅 1 篇，实际抓不到）

用法：
  python build/fetch-lit.py --stage list     # 只拉标题，先看有多少候选
  python build/fetch-lit.py --stage bodies   # 逐条拉正文（可断点续跑）
"""
import os, io, json, time, random, re, argparse
import urllib.parse, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "_articles-cache-lit")
CATALOG = os.path.join(HERE, "_articles-catalog-lit.json")
API = "https://zh.wikisource.org/w/api.php"
UA = "KidsWritingApp/1.0 (offline Chinese writing trainer for primary school)"

# 作者页前缀。繁体名是维基的实际页面名；简体名一并试，避免漏收简繁两稿。
SOURCES = [
    ("老舍",    "Author:老舍/",    "老舍"),
    ("鄭振鐸",  "Author:鄭振鐸/",  "鄭振鐸"),
    ("郑振铎",  "Author:郑振铎/",  "郑振铎"),
    ("夏丏尊",  "Author:夏丏尊/",  "夏丏尊"),
    ("許地山",  "Author:許地山/",  "許地山"),
    ("许地山",  "Author:许地山/",  "许地山"),
]

# 标题里带这些词的多半不是「能给孩子当范文的散文」：创作谈、序跋、学术、政论
SKIP_PAT = re.compile(
    r"(序$|跋$|後記|后记|題記|题记|小引|附記|附记|自序|代序|引言|導言|导言|"
    r"寫作|写作|經過|经过|創作|创作|劇本|剧本|演員|演员|導演|导演|演出|"
    r"演講|演讲|講話|讲话|宣言|答問|答问|訪問|访问|通信|書信|书信|"
    r"主義|主义|政治|革命|階級|阶级|抗戰|抗战|黨|党|國是|国是|壓迫|压迫|"
    r"批評|批评|論|论|問題|问题|雜感|杂感|隨感|随感|漫談|漫谈|"
    r"散文集|詩集|诗集|全集|文集|選集|选集|經典|经典|修辭|修辞|詩學|诗学|"
    r"文學史|文学史|述略|編目|编目|書後|书后|校歌|譯本|译本|翻譯|翻译)"
)


def api(**params):
    params.setdefault("format", "json")
    params.setdefault("formatversion", "2")
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last = None
    for i in range(6):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 502, 503, 504):
                wait = 6 * (2 ** i) + random.uniform(0, 3)
                print("    %d，等 %.0fs 重试（第 %d 次）" % (e.code, wait, i + 1), flush=True)
                time.sleep(wait)
                continue
            raise
        except Exception as e:
            last = e
            time.sleep(4)
    raise RuntimeError("请求失败：%s" % last)


def _fname(title):
    return "".join("_%02x" % ord(c) if c in r'"*/\:?<>|' else c for c in title) + ".json"


def stage_list():
    out, seen = [], set()
    for label, prefix, bucket in SOURCES:
        try:
            d = api(action="query", list="prefixsearch",
                    pssearch=prefix, pslimit="500", psnamespace="0")
        except Exception as e:
            print("%-8s 失败 %s" % (label, type(e).__name__), flush=True)
            time.sleep(4)
            continue
        hits = [x["title"] for x in d.get("query", {}).get("prefixsearch", []) or []]
        kept = []
        for t in hits:
            short = t.split("/", 1)[1] if "/" in t else t
            if not short or short in seen:
                continue
            if SKIP_PAT.search(short):
                continue
            seen.add(short)
            kept.append({"title": t, "short": short, "bucket": "作者页:" + bucket, "src": prefix})
        out.extend(kept)
        print("%-8s 原始 %3d → 过标题闸 %3d" % (label, len(hits), len(kept)), flush=True)
        time.sleep(2.5)

    with io.open(CATALOG, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("\n已写 %s（去重后 %d 篇候选）" % (CATALOG, len(out)))
    print("下一步：--stage bodies 抓正文（%d 条 × 约 2.5s ≈ %d 分钟）"
          % (len(out), round(len(out) * 2.5 / 60)))


def stage_bodies():
    if not os.path.exists(CATALOG):
        raise SystemExit("先跑 --stage list")
    todo = json.load(io.open(CATALOG, encoding="utf-8"))
    os.makedirs(CACHE, exist_ok=True)
    ok = fail = skip = 0
    for i, r in enumerate(todo):
        path = os.path.join(CACHE, _fname(r["short"]))
        if os.path.exists(path):
            skip += 1
            continue
        try:
            d = api(action="parse", page=r["title"], prop="text")
        except Exception as e:
            fail += 1
            print("[%4d/%d] FAIL %-24s %s" % (i + 1, len(todo), r["short"], type(e).__name__), flush=True)
            time.sleep(8)
            continue
        rec = dict(r)
        rec["html"] = d["parse"]["text"]
        with io.open(path, "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False)
        ok += 1
        print("[%4d/%d] ok %s" % (i + 1, len(todo), r["short"]), flush=True)
        time.sleep(2.0 + random.uniform(0, 1.0))
    print("正文缓存完成：新增 %d / 已有 %d / 失败 %d" % (ok, skip, fail), flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["list", "bodies"], required=True)
    a = ap.parse_args()
    stage_list() if a.stage == "list" else stage_bodies()
