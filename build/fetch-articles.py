# -*- coding: utf-8 -*-
"""文章补写素材库 · 取材探针 v2（只读，不写产品文件）

为什么要有这一步：
  产品要求「≥200 篇、适合 5-6 年级、每篇 ≤3000 字、带出处」，而项目硬规则要求
  只用真实数据、离线可用、版权干净。维基文库上的**公版（PD）中文散文**是唯一
  同时满足这三条的真实语料来源，所以先做一次"到底有多少可用"的**实测**，
  而不是先写 200 篇再发现不够。

两步走（尺寸参数必须在这两轮之间保持稳定，否则第二轮的分组会变）：
  1. 目录轮：把「散文四大分类」+「高产作者页」的作品名收集起来（只拉标题）
  2. 正文轮：逐条拉正文 → 去导航/注释/页眉 → 挑出真正能用的

产物：
  build/_articles-catalog-v2.json  候选标题（含来源）
  build/_articles-cache-v2/*.json  原始 HTML（可断点续跑）
  build/_articles-probe-report.txt 体检报告（篇幅/段落分布）

用法:
  python build/fetch-articles.py --stage list
  python build/fetch-articles.py --stage bodies
  python build/fetch-articles.py --stage report
"""
import os, sys, io, json, time, random, re, html, argparse
import urllib.parse, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, "_articles-cache-v2")
CATALOG = os.path.join(HERE, "_articles-catalog-v2.json")
REPORT = os.path.join(HERE, "_articles-probe-report.txt")
API = "https://zh.wikisource.org/w/api.php"

# 维基的 UA 政策要求「可识别的客户端」，用浏览器串反而更容易被反爬拦（实测 429 更频繁）。
UA = "KidsWritingApp/1.0 (offline Chinese writing trainer for primary school)"

# 散文四大分类 —— 上一轮实测：写景 37 / 叙事 17 / 议论 84 / 抒情 1（共 138）
CATS = {
    "写景游记类散文": "写景",
    "叙事性散文": "记事",
    "议论性散文": "说理",
    "抒情性散文": "抒情",
}

# 高产作者页：公版（1945 年前后已故）+ 作品多。作者分类页里挂着上百个作品链接。
AUTHORS = ["朱自清", "周作人", "郁達夫", "夏丏尊", "徐志摩", "聞一多", "魯迅",
           "陳獨秀", "胡適", "羅家倫", "蕭紅", "許地山"]

# 明显不适合 / 不能用作文本的标题特征（合集、序跋、目录、学术）
SKIP_PAT = re.compile(
    r"(散文集|詩集|全集|文集|選|序$|跋$|題記|小引|附記|校歌|"
    r"經典常談|語文|修辭|詩學|文學史|述略|釋$|編目|書後|答.*書)"
)

# 正文里必须剔掉的行：来源说明、公共领域模板、导航
JUNK_PAT = re.compile(
    r"(本作品.*(?:公有領域|公有领域)|^作者[:：]|^本文|^原載|^原载|初刊|轉載|转载|"
    r"^分類[:：]|^Category|隱藏分類|維基百科|^查看|^編輯|^校|^參見|^外部|"
    r"^目[錄次]|^\d+$|^[—\-–]{2,}$|^\W{1,6}$)"
)


# --------------------------------------------------------------------------
#  网络
# --------------------------------------------------------------------------
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
            time.sleep(4 * (i + 1))
    raise last


# --------------------------------------------------------------------------
#  第一步：目录
# --------------------------------------------------------------------------
def stage_list():
    out = {}
    for cat, bucket in CATS.items():
        d = api(action="query", list="categorymembers", cmtitle="Category:" + cat,
                cmlimit="500", cmnamespace="0")
        rows = [{"title": x["title"], "bucket": bucket, "src": cat}
                for x in d["query"]["categorymembers"]]
        out[cat] = rows
        print("%-10s -> %3d 条" % (cat, len(rows)), flush=True)
        time.sleep(4)

    for author in AUTHORS:
        page = "Author:" + author
        try:
            d = api(action="parse", page=page, prop="text")
        except Exception as e:
            print("%-10s 失败 %s" % (author, type(e).__name__), flush=True)
            continue
        titles = []
        for _href, t in re.findall(r'<a href="/wiki/([^"#]+)"[^>]*title="([^"]+)"', d["parse"]["text"]):
            if ":" in t or SKIP_PAT.search(t):
                continue
            if t not in titles:
                titles.append(t)
        out[page] = [{"title": t, "bucket": "作者页:" + author, "src": page} for t in titles]
        print("%-10s -> %3d 条" % (author, len(titles)), flush=True)
        time.sleep(3)

    with io.open(CATALOG, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    total = len({r["title"] for rows in out.values() for r in rows})
    print("已写 %s（去重后 %d 篇候选）" % (CATALOG, total), flush=True)


# --------------------------------------------------------------------------
#  第二步：正文
# --------------------------------------------------------------------------
def _fname(title):
    return "".join("_%02x" % ord(c) if c in r'"*/\:?<>|' else c for c in title) + ".json"


def stage_bodies():
    if not os.path.exists(CATALOG):
        raise SystemExit("先跑 --stage list")
    catalog = json.load(io.open(CATALOG, encoding="utf-8"))
    os.makedirs(CACHE, exist_ok=True)
    seen, todo = set(), []
    for rows in catalog.values():
        for r in rows:
            if r["title"] in seen:
                continue
            seen.add(r["title"])
            todo.append(r)
    print("合计 %d 条（去重后）" % len(todo), flush=True)

    ok = fail = 0
    for i, r in enumerate(todo):
        path = os.path.join(CACHE, _fname(r["title"]))
        if os.path.exists(path):
            ok += 1
            continue
        try:
            d = api(action="parse", page=r["title"], prop="text")
        except Exception as e:
            fail += 1
            print("[%4d/%d] FAIL %-26s %s" % (i + 1, len(todo), r["title"], type(e).__name__), flush=True)
            time.sleep(8)
            continue
        rec = dict(r)
        rec["html"] = d["parse"]["text"]
        with io.open(path, "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False)
        ok += 1
        print("[%4d/%d] ok %s" % (i + 1, len(todo), r["title"]), flush=True)
        # 2.0~3.0 秒一条：实测 3.5s 反而因为零星 429+退避更慢
        time.sleep(2.0 + random.uniform(0, 1.0))
    print("正文缓存完成：成功 %d / 失败 %d" % (ok, fail), flush=True)


# --------------------------------------------------------------------------
#  第三步：解析 + 体检
# --------------------------------------------------------------------------
TAG_BLOCK = re.compile(r"<(style|script|table|sup|figure)[^>]*>.*?</\1>", re.S)
PAGENUM = re.compile(r'<span[^>]*ws-pagenum[^>]*>.*?</span></span>', re.S)


def parse_paras(raw_html):
    """把维基渲染后的 HTML 拆成"真段落"。

    上一轮的教训：直接按 <p> 拆不够，同一条 <p> 里还嵌着 ws-pagenum 页码锚点，
    它会把一句话劈成两段（"這幾天心裏頗不寧靜。…妻在屋裏拍着" | "，迷迷糊糊地哼着眠歌。"）。
    所以先把页码锚点整段剔掉，再按 <p> 切。
    """
    h = raw_html
    m = re.search(r'class="prp-pages-output"[^>]*>(.*)', h, re.S)
    if m:
        h = m.group(1)
    h = TAG_BLOCK.sub("", h)
    h = PAGENUM.sub("", h)
    paras = []
    for chunk in re.split(r"</p>|<br\s*/?>|\n", h):
        t = re.sub(r"<[^>]+>", "", chunk)
        t = html.unescape(t)
        t = t.replace("\u3000", "").replace("\xa0", " ")
        t = re.sub(r"[ \t]+", "", t).strip()
        if len(t) < 12:
            continue
        if JUNK_PAT.search(t):
            continue
        paras.append(t)
    # 相邻段如果明显是被切断的半句（以上一句的标点结尾判断），拼回去
    merged = []
    for p in paras:
        if merged and not re.search(r"[。！？…”』」）\.\!\?]$", merged[-1]) and len(merged[-1]) < 60:
            merged[-1] = merged[-1] + p
        else:
            merged.append(p)
    return [p for p in merged if len(p) >= 20]


def looks_modern(txt):
    """区分简体/繁體稿：同一作者名下两种稿子混在一起，简繁不统一会很难看。"""
    simp = len(re.findall(r"[这们时说会国过来对为个别实现点发觉得里么样还]", txt))
    trad = len(re.findall(r"[這們時說會國過來對為個別實現點發覺裡麼樣還]", txt))
    return simp > trad


def stage_report():
    rows = []
    for f in sorted(os.listdir(CACHE)):
        d = json.load(io.open(os.path.join(CACHE, f), encoding="utf-8"))
        ps = parse_paras(d["html"])
        n = sum(len(p) for p in ps)
        rows.append(dict(title=d["title"], bucket=d["bucket"], src=d["src"],
                         chars=n, paras=len(ps), modern=looks_modern("".join(ps)),
                         longest=max((len(p) for p in ps), default=0)))
    lines = []
    def put(s=""):
        lines.append(s)
        print(s, flush=True)

    put("候选标题 %d 条，成功解析 %d 条" % (len(rows), len([r for r in rows if r["paras"]])))
    usable = [r for r in rows if r["paras"] >= 4 and 500 <= r["chars"] <= 2600 and r["longest"] >= 80]
    put("★ 可用（≥4 段、500~2600 字、最长段≥80 字）：%d 篇" % len(usable))

    from collections import Counter
    put()
    put("按来源分类：")
    for k, v in Counter(r["src"] for r in usable).most_common():
        put("  %-22s %3d" % (k, v))
    put()
    put("按文种：")
    for k, v in Counter("简体" if r["modern"] else "繁體" for r in usable).most_common():
        put("  %-8s %3d" % (k, v))
    put()
    put("篇幅分布：")
    for lo, hi in [(500, 800), (800, 1100), (1100, 1400), (1400, 1700), (1700, 2000), (2000, 2300), (2300, 2600)]:
        c = len([r for r in usable if lo <= r["chars"] < hi])
        put("  %4d~%4d 字  %3d 篇 %s" % (lo, hi, c, "#" * (c // 2)))
    put()
    put("逐篇（按字数）：")
    for r in sorted(usable, key=lambda x: -x["chars"]):
        put("  %4d字 %2d段  %-26s %s" % (r["chars"], r["paras"], r["title"], r["src"]))

    io.open(REPORT, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print("\n报告已写 %s" % REPORT)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["list", "bodies", "report"], required=True)
    a = ap.parse_args()
    {"list": stage_list, "bodies": stage_bodies, "report": stage_report}[a.stage]()
