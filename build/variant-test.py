#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""提示词变体对照测试：找出能真正稳定住「儿童绘本扁平插画」风格 + 元素跟随的写法"""
import os, io, time, urllib.parse, urllib.request, hashlib
from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "imgtest")
os.makedirs(OUT, exist_ok=True)
W, H, CROP = 896, 704, 34

LONG = {
 "s003": ("heavy rain at a bus stop, five people crowded under the sign, a boy holding an umbrella very high "
          "sheltering a stranger old man, a bus approaching from far away with headlights glowing through the rain"),
 "s014": ("afternoon in an old house, a vintage sewing machine by the window with sunlight on it, a grandmother "
          "sewing with a thimble, a child sitting on a small stool holding a scrap of cloth"),
}
SHORT = {
 "s003": "a rainy bus stop, a boy holding up an umbrella for an old man, a bus arriving",
 "s014": "a grandmother sewing at a sewing machine by a sunny window, a child watching beside her",
}

P_CUR = "children's picture book illustration, flat vector art, soft colors, gentle light, clean simple composition, no text"
P_NEW = "bright children's picture book illustration, flat 2D vector art, simple shapes, cheerful warm colors, storybook"
SUF = "flat vector children's book art, bright cheerful colors, simple shapes, no text, no words"

def variants(k):
    return {
      "1cur":   (P_CUR + ", " + LONG[k], None),
      "2short": (P_NEW + ", " + SHORT[k] + ", " + SUF, None),
      "3flux":  (P_NEW + ", " + SHORT[k] + ", " + SUF, "flux"),
    }

def fetch(prompt, model, seed, tries=4):
    q = {"width": W, "height": H, "seed": seed, "nologo": "true"}
    if model: q["model"] = model
    url = "https://image.pollinations.ai/prompt/" + urllib.parse.quote(prompt, safe="") + "?" + urllib.parse.urlencode(q)
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://pollinations.ai/"})
            with urllib.request.urlopen(req, timeout=200) as r:
                data = r.read()
            if (data[:2] == b"\xff\xd8" or data[:8] == b"\x89PNG\r\n\x1a\n") and len(data) > 15000:
                return data
            last = "bad payload %d bytes" % len(data)
        except Exception as e:
            last = "%s: %s" % (type(e).__name__, e)
        time.sleep(8 + i * 6)
    raise RuntimeError(last)

for k in ["s003", "s014"]:
    for name, (prompt, model) in variants(k).items():
        t0 = time.time()
        try:
            raw = fetch(prompt, model, seed=900 + int(k[1:]) * 13)
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            w, h = im.size
            im = im.crop((0, 0, w, h - CROP))
            path = os.path.join(OUT, "%s-%s.jpg" % (k, name))
            im.save(path, "JPEG", quality=86, optimize=True)
            print("%s %-8s ok  %.1fs  %s" % (k, name, time.time() - t0, im.size), flush=True)
        except Exception as e:
            print("%s %-8s FAIL %s" % (k, name, e), flush=True)
        time.sleep(1.5)
print("done")
