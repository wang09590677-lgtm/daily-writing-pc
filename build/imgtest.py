#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""单张生图测试：验证提示词语言效果 + 水印裁剪 + 输出尺寸"""
import sys, os, io, time, json, urllib.parse, urllib.request, hashlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "imgtest")
os.makedirs(OUT, exist_ok=True)

def fetch(prompt, w=896, h=704, seed=7, model=None, tries=6):
    q = {"width": w, "height": h, "seed": seed, "nologo": "true"}
    if model:
        q["model"] = model
    url = "https://image.pollinations.ai/prompt/" + urllib.parse.quote(prompt, safe="") + "?" + urllib.parse.urlencode(q)
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://pollinations.ai/"})
            with urllib.request.urlopen(req, timeout=180) as r:
                data = r.read()
                ct = r.headers.get("Content-Type", "")
                if data[:2] == b"\xff\xd8" or data[:8] == b"\x89PNG\r\n\x1a\n":
                    return data, ct
                last = "not image: %s %r" % (ct, data[:120])
        except Exception as e:
            last = "%s: %s" % (type(e).__name__, e)
        time.sleep(6 + i * 4)
    raise RuntimeError(last)

def crop_watermark(raw, px=34):
    from PIL import Image
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = im.size
    im2 = im.crop((0, 0, w, max(1, h - px)))
    buf = io.BytesIO()
    im2.save(buf, "JPEG", quality=88, optimize=True)
    return im.size, im2.size, buf.getvalue()

if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "cn"
    if which == "cn":
        prompt = ("儿童绘本插画，扁平矢量风格，柔和温暖的颜色：傍晚的公园，天空有晚霞，"
                  "一个孩子站在草地上，手里拿着一架纸飞机，一只小狗追着纸飞机跑，"
                  "旁边的长椅上放着一个红色书包")
    else:
        prompt = ("children's picture book illustration, flat vector art, soft warm colors: "
                  "evening park with sunset clouds in the sky, a child standing on the grass holding "
                  "a paper airplane, a small dog chasing the flying paper airplane, a red schoolbag "
                  "left on a bench nearby")
    t0 = time.time()
    raw, ct = fetch(prompt)
    dim0, dim1, out = crop_watermark(raw)
    name = os.path.join(OUT, "cmp-%s.jpg" % which)
    open(name, "wb").write(out)
    print("lang=%s  elapsed=%.1fs  ct=%s  raw=%s  cropped=%s  bytes=%d  md5=%s" % (
        which, time.time() - t0, ct, dim0, dim1, len(out), hashlib.md5(out).hexdigest()[:12]))
    print("saved:", name)
