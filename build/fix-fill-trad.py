# -*- coding: utf-8 -*-
"""素材库简繁清洗（就地修 data/fill-articles.js）。

为什么必须单独做这一步：
  旧库是「简体为主 + 繁体残留」的混合体（206/210 篇含繁体字），根因是
  curate-articles.py 里的 TRAD2SIMP 只做了**字对替换**，覆盖不全。
  实测原文长这样：
      《背影》  「禍不单行」「奔喪囘家」「滿院狼藉」「囘家变卖典質」
      《荷塘月色》「頗不寧静」「閏儿」「蓊蓊鬱鬱」
      作者名     「聞一多」「郁達夫」「魯迅」
  孩子看到的是这种半简半繁，比全繁体还难看。

  换成 opencc 的 t2s（完整的繁→简映射），再补一张**异体字表** ——
  opencc 不处理「囘/賸/喫」这类异体字（它们不在标准繁体字表里）。

用法：
  python build/fix-fill-trad.py            # 试跑，只报告
  python build/fix-fill-trad.py --write    # 真的写回
"""
import io, os, re, json, argparse, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "data", "fill-articles.js")

try:
    import opencc
except ImportError:
    raise SystemExit("缺 opencc：pip install opencc-python-reimplemented")

CC = opencc.OpenCC("t2s")

# opencc 的 t2s 只覆盖「标准繁体 → 简体」，异体字/俗字不在表里，得自己补。
# 只收**确定会出现在民国白话文里**的那几个，宁少勿错（错改会毁掉原意）。
VARIANT = {
    "囘": "回", "囬": "回", "廻": "回", "逥": "回",
    "賸": "剩", "喫": "吃", "纔": "才", "甯": "宁",
    "牠": "它", "祗": "只", "敎": "教", "旣": "既",
    "卽": "即", "衞": "卫", "舖": "铺", "牀": "床",
    "疎": "疏", "麤": "粗", "嵗": "岁", "峯": "峰",
    "羣": "群", "眾": "众", "裏": "里", "麽": "么",
    "徧": "遍", "煖": "暖", "鑑": "鉴", "鑒": "鉴",
    "麪": "面", "麫": "面", "粧": "妆", "妝": "妆",
    "盌": "碗", "椀": "碗", "鉅": "巨", "敍": "叙",
    "敘": "叙", "尙": "尚", "吿": "告", "迺": "乃",
    "遊": "游", "週": "周", "閒": "闲", "註": "注",
    "讃": "赞", "讚": "赞", "蹟": "迹", "跡": "迹",
    "邨": "村", "箇": "个", "嗁": "啼", "囌": "苏",
}

# 繁体检测：这些字在简体文本里几乎不会出现（简繁不同形）。
# ⚠️ 不要往里放「西/南/北/東」这类 —— 简繁同形的字放进来会误判。
TRAD_CHECK = set(
    "們個這說時會來為國學對開麼過還發經樣現當與從裡點後應該讓給沒種覺聽寫"
    "話語讀課師題義認識愛樂書車門馬鳥魚龍鳳華歲萬億農場產業務員錢價買賣東"
    "難歡樂園處邊遠達進選遲適連運過還進遠違遜遞"
)


def clean(s):
    if not isinstance(s, str):
        return s
    out = CC.convert(s)
    for a, b in VARIANT.items():
        if a in out:
            out = out.replace(a, b)
    return out


def trad_hits(s):
    return [c for c in s if c in TRAD_CHECK]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()

    raw = io.open(SRC, encoding="utf-8").read()
    m = re.search(r"(window\.FILL_ARTICLE_LIBRARY\s*=\s*)(\[.*\])(;?)", raw, re.S)
    if not m:
        raise SystemExit("没找到 FILL_ARTICLE_LIBRARY")
    head, body, tail = m.group(1), m.group(2), m.group(3)
    rows = json.loads(body)

    before_rows = 0
    before_chars = 0
    for r in rows:
        txt = "".join(r[5])
        h = trad_hits(txt) + trad_hits(r[3] or "") + trad_hits(r[2] or "")
        if h:
            before_rows += 1
            before_chars += len(h)

    for r in rows:
        r[2] = clean(r[2])                    # 标题
        r[3] = clean(r[3] or "")              # 作者
        r[5] = [clean(p) for p in r[5]]       # 正文
        r[9] = clean(r[9] or "")              # 补写提示

    after_rows = 0
    after_chars = 0
    for r in rows:
        txt = "".join(r[5])
        h = trad_hits(txt) + trad_hits(r[3] or "") + trad_hits(r[2] or "")
        if h:
            after_rows += 1
            after_chars += len(h)

    print("清洗前：%d/%d 篇含繁体，共 %d 个繁体字" % (before_rows, len(rows), before_chars))
    print("清洗后：%d/%d 篇含繁体，共 %d 个繁体字" % (after_rows, len(rows), after_chars))
    if after_chars:
        print("\n仍残留的样本：")
        shown = 0
        for r in rows:
            txt = "".join(r[5])
            h = trad_hits(txt)
            if h and shown < 5:
                print("  《%s》 %s" % (r[2], "".join(sorted(set(h))[:12])))
                shown += 1

    # 抽查几条，肉眼确认没改坏
    print("\n=== 抽查（改后）===")
    for want in ("背影", "荷塘月色", "诗与话"):
        for r in rows:
            if r[2] == want:
                print("《%s》%s" % (r[2], r[3]))
                print("  " + r[5][0][:90])
                break

    if a.write:
        out = head + json.dumps(rows, ensure_ascii=False, indent=0) + tail + "\n"
        io.open(SRC, "w", encoding="utf-8").write(out)
        print("\n已写回 %s（%d 篇）" % (SRC, len(rows)))
    else:
        print("\n（试跑，没写文件；加 --write 才真的写回）")


if __name__ == "__main__":
    main()
