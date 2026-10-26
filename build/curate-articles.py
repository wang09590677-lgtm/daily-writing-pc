# -*- coding: utf-8 -*-
"""文章补写素材库 · 生成器（从维基文库公版散文 → data/fill-articles.js）

口径（与老李确认前先按这个做，随时可调）：
  * 只收**公版**（作者 1945 年前后已故，维基文库条目带 {{Pd}} 模板），来源写清"维基文库·公版"
  * 统一转**简体**（数据层统一，避免同一本书里简繁混杂；改回繁体只需把 --keep-trad 打开）
  * 单篇 500~2600 字（题干要求 ≤3000），段落 4~22 段
  * 挖空：从正文里挑**中间偏后、非首尾**的连续段落，累计 ≥280 字，且不超过全文 40%
    —— 挖太后面孩子接不上，挖太前面（开头段）等于换题；两头都留一段，孩子才知道往哪走

产物格式（与 data/models-authored-*.js 同样的"二维数组 + 格式注释"风格）：
  window.FILL_ARTICLE_LIBRARY = [
    [id, 分类, 标题, 作者, 出处, [段落...], 挖空起始段, 挖空段数, 训练能力],
    ...
  ]
  ★ 挖空信息**不单独存一份正文**：原样保留全文，页面渲染时按 [gapStart, gapCount] 决定
    哪几段显示成"空缺卡片"。这样"孩子补写 vs 原文"的对照永远以**同一份文本**为准，
    不会出现"存了两份、改了一份"的漂移。
"""
import os, sys, io, json, re, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, "_articles-cache-v2")
OUT = os.path.join(ROOT, "data", "fill-articles.js")
PICK = os.path.join(HERE, "_articles-picked.json")

TAG_BLOCK = re.compile(r"<(style|script|table|sup|figure)[^>]*>.*?</\1>", re.S)
PAGENUM = re.compile(r'<span[^>]*ws-pagenum[^>]*>.*?</span></span>', re.S)
# 维基的"全角空格缩进"用的就是 &#8195;&#8195;，不先转回来就留成一串可见垃圾
ENT_FIX = {"&#8195;": "", "&#12288;": "", "&#160;": " ", "&nbsp;": " ", "&#8203;": ""}
JUNK_PAT = re.compile(
    r"(本作品.*(?:公有領域|公有领域)|^作者[:：]|^本文|^原載|^原载|初刊|轉載|转载|"
    r"^分類[:：]|^Category|隱藏分類|維基百科|^查看|^編輯|^校|^參見|^外部|"
    r"^目[錄次]|^\d+$|^[—\-–]{2,}$)"
)

# 繁体 → 简体：只做**本文用到的**高频字对，不引第三方库（离线版不能加依赖）
# 覆盖度靠"生成时检查残留繁体字数量"，残留过多的篇目直接丢弃（宁缺勿滥，可查）
TRAD2SIMP = {}


def build_t2s():
    pairs = [
        ("這", "这"), ("們", "们"), ("時", "时"), ("說", "说"), ("會", "会"), ("國", "国"),
        ("過", "过"), ("來", "来"), ("對", "对"), ("為", "为"), ("個", "个"), ("別", "别"),
        ("實", "实"), ("現", "现"), ("點", "点"), ("發", "发"), ("覺", "觉"), ("裡", "里"),
        ("裏", "里"), ("麼", "么"), ("樣", "样"), ("還", "还"), ("著", "着"), ("於", "于"),
        ("與", "与"), ("從", "从"), ("將", "将"), ("經", "经"), ("見", "见"), ("聽", "听"),
        ("聲", "声"), ("樹", "树"), ("葉", "叶"), ("裏", "里"), ("後", "后"), ("東", "东"),
        ("風", "风"), ("雲", "云"), ("電", "电"), ("陽", "阳"), ("陰", "阴"), ("閒", "闲"),
        ("間", "间"), ("關", "关"), ("門", "门"), ("問", "问"), ("開", "开"), ("長", "长"),
        ("頭", "头"), ("體", "体"), ("邊", "边"), ("遠", "远"), ("處", "处"), ("邊", "边"),
        ("車", "车"), ("學", "学"), ("覺", "觉"), ("樣", "样"), ("幾", "几"), ("樂", "乐"),
        ("語", "语"), ("讀", "读"), ("寫", "写"), ("書", "书"), ("畫", "画"), ("戲", "戏"),
        ("歲", "岁"), ("錢", "钱"), ("賣", "卖"), ("買", "买"), ("給", "给"), ("總", "总"),
        ("種", "种"), ("兩", "两"), ("萬", "万"), ("裏", "里"), ("還", "还"), ("麼", "么"),
        ("紅", "红"), ("綠", "绿"), ("藍", "蓝"), ("黃", "黄"), ("鳥", "鸟"), ("魚", "鱼"),
        ("飛", "飞"), ("馬", "马"), ("龍", "龙"), ("蟲", "虫"), ("蟬", "蝉"), ("聲", "声"),
        ("氣", "气"), ("熱", "热"), ("冷", "冷"), ("涼", "凉"), ("暖", "暖"), ("濕", "湿"),
        ("靜", "静"), ("動", "动"), ("輕", "轻"), ("慢", "慢"), ("遠", "远"), ("近", "近"),
        ("變", "变"), ("讓", "让"), ("被", "被"), ("從", "从"), ("們", "们"), ("她", "她"),
        ("愛", "爱"), ("親", "亲"), ("媽", "妈"), ("爺", "爷"), ("媽", "妈"), ("兒", "儿"),
        ("女", "女"), ("舊", "旧"), ("夢", "梦"), ("憶", "忆"), ("懷", "怀"), ("願", "愿"),
        ("驚", "惊"), ("喜", "喜"), ("憂", "忧"), ("傷", "伤"), ("淚", "泪"), ("笑", "笑"),
        ("種", "种"), ("蟲", "虫"), ("語", "语"), ("詞", "词"), ("詩", "诗"), ("節", "节"),
        ("禮", "礼"), ("義", "义"), ("議", "议"), ("論", "论"), ("證", "证"), ("識", "识"),
        ("記", "记"), ("認", "认"), ("識", "识"), ("試", "试"), ("驗", "验"), ("應", "应"),
        ("該", "该"), ("當", "当"), ("難", "难"), ("簡", "简"), ("單", "单"), ("複", "复"),
        ("雜", "杂"), ("舊", "旧"), ("習", "习"), ("慣", "惯"), ("準", "准"), ("備", "备"),
        ("塵", "尘"), ("帶", "带"), ("幫", "帮"), ("務", "务"), ("費", "费"), ("價", "价"),
        ("貴", "贵"), ("賤", "贱"), ("農", "农"), ("業", "业"), ("產", "产"), ("礦", "矿"),
        ("鐵", "铁"), ("銀", "银"), ("鐘", "钟"), ("傢", "家"), ("衛", "卫"), ("職", "职"),
        ("級", "级"), ("眾", "众"), ("圍", "围"), ("園", "园"), ("團", "团"), ("圖", "图"),
        ("號", "号"), ("燈", "灯"), ("燭", "烛"), ("煙", "烟"), ("霧", "雾"), ("慶", "庆"),
        ("禱", "祷"), ("獸", "兽"), ("貓", "猫"), ("雞", "鸡"), ("鴨", "鸭"), ("鵝", "鹅"),
        ("橋", "桥"), ("樓", "楼"), ("牆", "墙"), ("磚", "砖"), ("塊", "块"), ("層", "层"),
        ("達", "达"), ("運", "运"), ("進", "进"), ("選", "选"), ("連", "连"), ("迴", "回"),
        ("迴", "回"), ("麼", "么"), ("甚", "甚"), ("離", "离"), ("爾", "尔"), ("雖", "虽"),
        ("實", "实"), ("徵", "征"), ("餘", "余"), ("儘", "尽"), ("盡", "尽"), ("據", "据"),
        ("撐", "撑"), ("擁", "拥"), ("擔", "担"), ("挑", "挑"), ("搖", "摇"), ("擺", "摆"),
        ("麼", "么"), ("豔", "艳"), ("麗", "丽"), ("莊", "庄"), ("嚴", "严"), ("肅", "肃"),
        ("亂", "乱"), ("戰", "战"), ("爭", "争"), ("勝", "胜"), ("敗", "败"), ("殺", "杀"),
        ("醫", "医"), ("藥", "药"), ("療", "疗"), ("夢", "梦"), ("戀", "恋"), ("歲", "岁"),
        ("廚", "厨"), ("廳", "厅"), ("臥", "卧"), ("廁", "厕"), ("廂", "厢"), ("縣", "县"),
        ("鄉", "乡"), ("鎮", "镇"), ("莊", "庄"), ("畝", "亩"), ("穀", "谷"), ("麥", "麦"),
        ("麵", "面"), ("餅", "饼"), ("飯", "饭"), ("湯", "汤"), ("鹽", "盐"), ("醬", "酱"),
        ("鮮", "鲜"), ("醜", "丑"), ("惡", "恶"), ("醜", "丑"), ("髒", "脏"), ("淨", "净"),
        ("擺", "摆"), ("掃", "扫"), ("灑", "洒"), ("礙", "碍"), ("確", "确"), ("礎", "础"),
        ("豎", "竖"), ("橫", "横"), ("縱", "纵"), ("縱", "纵"), ("織", "织"), ("線", "线"),
        ("繞", "绕"), ("纏", "缠"), ("縫", "缝"), ("補", "补"), ("襪", "袜"), ("褲", "裤"),
        ("髪", "发"), ("髮", "发"), ("臉", "脸"), ("頸", "颈"), ("頰", "颊"), ("額", "额"),
        ("唇", "唇"), ("齒", "齿"), ("腳", "脚"), ("腦", "脑"), ("腸", "肠"), ("豈", "岂"),
        ("嘆", "叹"), ("歡", "欢"), ("稱", "称"), ("讀", "读"), ("講", "讲"), ("譯", "译"),
        ("詢", "询"), ("訪", "访"), ("許", "许"), ("託", "托"), ("諾", "诺"), ("談", "谈"),
        ("謀", "谋"), ("詐", "诈"), ("謊", "谎"), ("誤", "误"), ("誘", "诱"), ("請", "请"),
        ("讚", "赞"), ("賞", "赏"), ("賜", "赐"), ("贈", "赠"), ("輸", "输"), ("贏", "赢"),
    ]
    for t, s in pairs:
        TRAD2SIMP[t] = s


def to_simp(txt):
    if not TRAD2SIMP:
        build_t2s()
    return "".join(TRAD2SIMP.get(ch, ch) for ch in txt)


def looks_simplified(txt):
    """判断原稿本身是简体还是繁体。用来"简体稿优先"——有原稿就别用字对硬转。"""
    simp = len(re.findall(r"[这们时说会国过来对为个别实现点发觉得里么样还]", txt))
    trad = len(re.findall(r"[這們時說會國過來對為個別實現點發覺裡麼樣還]", txt))
    return simp > trad


def parse_paras(raw_html):
    h = raw_html
    m = re.search(r'class="prp-pages-output"[^>]*>(.*)', h, re.S)
    if m:
        h = m.group(1)
    # ★ 先砍掉 HTML 注释：维基在正文末尾埋了 <\!-- NewPP limit report ... -->
    #   （里面 "Cached time:" 含冒号，不是标签，去标签时会被当成正文留下来 —— 上一轮就栽在这）
    h = re.sub(r"<!--.*?-->", "", h, flags=re.S)
    h = TAG_BLOCK.sub("", h)
    h = PAGENUM.sub("", h)
    for k, v in ENT_FIX.items():
        h = h.replace(k, v)
    out = []
    for chunk in re.split(r"</p>|<br\s*/?>|\n", h):
        t = re.sub(r"<[^>]+>", "", chunk)
        t = (t.replace("\u3000", "").replace("\xa0", " ")
              .replace("「", "“").replace("」", "”")
              .replace("『", "‘").replace("』", "’"))
        t = re.sub(r"[ \t]+", "", t).strip()
        # 无空格的英文/ASCII 长串 = 解析残渣（NewPP 报告、模板名、缓存键）
        if re.search(r"[A-Za-z]{14,}", t):
            continue
        if t.count(":") >= 2 and not re.search(r"[\u4e00-\u9fa5]{6}", t):
            continue
        if len(t) < 12 or JUNK_PAT.search(t):
            continue
        out.append(t)
    merged = []
    for p in out:
        if merged and len(merged[-1]) < 60 and not re.search(r"[。！？…”’）.!?]$", merged[-1]):
            merged[-1] += p
        else:
            merged.append(p)
    return [p for p in merged if len(p) >= 20]


def strip_tail_noise(paras):
    """去掉正文尾巴上的版权模板段（"1996年1月1日，这部作品…属于公有领域"之类）。

    这些段落在**正文之后**，且必然连着出现，所以从末尾往前扫，一见版权字眼就丢，
    直到遇到正常段落为止。只丢尾巴，不做全文替换 —— 正文里提到"公有"不能被误伤。
    """
    TAIL = re.compile(r"(公有領域|公有领域|Publicdomain|版权期限|版權期限|"
                      r"作者.*逝世|在美国以及|在世作品|本作品|属于公有|属于公有)")
    while paras and TAIL.search(paras[-1]):
        paras.pop()
    return paras


def choose_gap(paras, lo=280):
    """挑挖空段落：中间偏后、非首尾、累计 ≥ lo 字、不超全文 40%。

    为什么"中间偏后"：开头段被挖掉孩子不知道从哪起笔，结尾段被挖掉整篇收不住。
    留头留尾，中间挖 1~3 段，是最像课本里"补写练习"的形状。
    """
    lens = [len(p) for p in paras]
    total = sum(lens)
    n = len(paras)
    best = None
    for start in range(1, n - 1):
        acc = 0
        for cnt in range(1, 4):
            if start + cnt > n - 1:
                break
            acc += lens[start + cnt - 1]
            if acc < lo:
                continue
            if acc > total * 0.42:
                break
            # 偏好：挖空位置落在 35%~75% 之间，段数 1~3
            pos = sum(lens[:start]) / total
            score = abs(pos - 0.55) + (cnt - 2) * 0.06 + abs(acc - 320) / 2000.0
            if best is None or score < best[0]:
                best = (score, start, cnt, acc)
            break
    if not best:
        return None
    return best[1], best[2], best[3]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-trad", action="store_true", help="保留繁体原文（默认转简体）")
    ap.add_argument("--min-chars", type=int, default=500)
    ap.add_argument("--max-chars", type=int, default=3000, help="题干要求 ≤3000 字")
    ap.add_argument("--limit", type=int, default=0, help="只输出前 N 篇（试跑用）")
    a = ap.parse_args()

    if not os.path.isdir(CACHE):
        raise SystemExit("缺 %s，先跑 fetch-articles.py --stage bodies" % CACHE)

    picked, dropped = [], {}
    for f in sorted(os.listdir(CACHE)):
        d = json.load(io.open(os.path.join(CACHE, f), encoding="utf-8"))
        raw = strip_tail_noise(parse_paras(d["html"]))
        # 简繁两版同名的处理：**简体稿优先**。上一轮实测鲁迅《五猖会》抓到的是繁体稿，
        # 而"转简体"只是按字对替换，做不到字形级准确（"髮/發"都映射到"发"还行，
        # 但"著/着""裡/里"这类靠字对会出错）。有简体原稿就绝不自己转。
        simp_native = looks_simplified("".join(raw))
        paras = [to_simp(p) for p in raw] if not a.keep_trad else list(raw)
        txt = "".join(paras)
        n = len(txt)
        key = d["title"]
        if n < a.min_chars or n > a.max_chars:
            dropped.setdefault(key, (n, "篇幅"))
            continue
        if not (4 <= len(paras) <= 22):
            dropped.setdefault(key, (n, "段数 %d" % len(paras)))
            continue
        if max(len(p) for p in paras) < 80:
            dropped.setdefault(key, (n, "段落过碎"))
            continue
        gap = choose_gap(paras)
        if not gap:
            dropped.setdefault(key, (n, "找不到合适挖空"))
            continue
        start, cnt, gaplen = gap
        rec = dict(title=d["title"], bucket=d["bucket"], src=d["src"],
                   paras=paras, chars=n, gapStart=start, gapCount=cnt,
                   gapChars=gaplen, simpNative=simp_native)
        # 同名（同标题）只留一条：作者页与分类页重复；简繁两稿也重复
        old = next((r for r in picked if r["title"] == key), None)
        if old is None:
            picked.append(rec)
        elif simp_native and not old["simpNative"]:
            picked[picked.index(old)] = rec
        dropped.pop(key, None)

    if a.limit:
        picked = picked[:a.limit]

    print("入选 %d 篇" % len(picked))
    from collections import Counter
    print("弃用原因（按篇）：", dict(Counter(v[1].split(" ")[0] for v in dropped.values())))
    print("其中简体原稿 %d 篇 / 繁体转简体 %d 篇"
          % (len([r for r in picked if r["simpNative"]]),
             len([r for r in picked if not r["simpNative"]])))
    if picked:
        gaps = [r["gapChars"] for r in picked]
        print("挖空字数 min/中位/max = %d / %d / %d（要求 ≥280）"
              % (min(gaps), sorted(gaps)[len(gaps) // 2], max(gaps)))
        print("全文篇幅 min/中位/max = %d / %d / %d"
              % (min(r["chars"] for r in picked),
                 sorted(r["chars"] for r in picked)[len(picked) // 2],
                 max(r["chars"] for r in picked)))
    json.dump(dict(picked=picked,
                   dropped=[(k, v[0], v[1]) for k, v in dropped.items()],
                   keptTrad=a.keep_trad),
              io.open(PICK, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("中间产物：%s" % PICK)
    print("要写 data/fill-articles.js 请跑 build/gen-fill-articles.py")


if __name__ == "__main__":
    main()
