#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""看图编故事配图生成器（Pollinations.ai 免费档）

用法:
  python gen-pictures.py              # 生成全部缺失的
  python gen-pictures.py --limit 5    # 只做前 5 张（试跑）
  python gen-pictures.py --start 20   # 从第 20 张开始
  python gen-pictures.py --only pic007,pic008

产物: ../assets/pictures/picXXX.jpg  (底部裁掉 34px 去除 pollinations 水印)
"""
import os, sys, io, json, time, argparse, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUTDIR = os.path.join(ROOT, "assets", "pictures")
os.makedirs(OUTDIR, exist_ok=True)

W, H = 896, 704          # 请求尺寸（比目标略高，便于裁掉水印）
CROP_BOTTOM = 34         # 底部裁掉的像素（水印高度约 25px）
MIN_BYTES = 15000        # 小于此值视为失败产物

def load():
    pics = json.load(open(os.path.join(HERE, "pictures.json"), encoding="utf-8"))
    pp = json.load(open(os.path.join(HERE, "picture-prompts.json"), encoding="utf-8"))
    prefix = pp["prefix"]
    suffix = pp.get("suffix", "")
    prompts = pp["prompts"]
    missing = [p["id"] for p in pics if p["id"] not in prompts]
    if missing:
        raise SystemExit("缺少提示词: " + ", ".join(missing))
    return pics, prefix, suffix, prompts

def build_prompt(prefix, scene, suffix):
    """风格锚点放首尾两端，实测能显著提升风格稳定性（只放开头会被长描述稀释）"""
    return prefix + ", " + scene + ", " + suffix

def url_for(full_prompt, seed):
    q = {"width": W, "height": H, "seed": seed, "nologo": "true"}
    return ("https://image.pollinations.ai/prompt/"
            + urllib.parse.quote(full_prompt, safe="") + "?"
            + urllib.parse.urlencode(q))

def download(full_prompt, seed, tries=5):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(
                url_for(full_prompt, seed),
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                         "Referer": "https://pollinations.ai/"})
            with urllib.request.urlopen(req, timeout=200) as r:
                data = r.read()
            if data[:2] == b"\xff\xd8" or data[:8] == b"\x89PNG\r\n\x1a\n":
                if len(data) >= MIN_BYTES:
                    return data
                last = "too small (%d bytes)" % len(data)
            else:
                last = "not an image: %r" % data[:100]
        except Exception as e:
            last = "%s: %s" % (type(e).__name__, e)
        wait = 8 + i * 6
        print("      retry %d/%d in %ds  (%s)" % (i + 1, tries, wait, last), flush=True)
        time.sleep(wait)
    raise RuntimeError(last)

def crop_and_save(raw, path):
    from PIL import Image
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = im.size
    im = im.crop((0, 0, w, max(1, h - CROP_BOTTOM)))
    im.save(path, "JPEG", quality=86, optimize=True, progressive=True)
    return im.size

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--start", type=int, default=1)
    ap.add_argument("--only", default="")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    pics, prefix, suffix, prompts = load()
    if a.only:
        want = set(x.strip() for x in a.only.split(",") if x.strip())
        todo = [p for p in pics if p["id"] in want]
    else:
        todo = [p for p in pics if p["idx"] >= a.start]
        if a.limit:
            todo = todo[:a.limit]

    if not a.force:
        todo = [p for p in todo
                if not (os.path.exists(os.path.join(OUTDIR, p["id"] + ".jpg"))
                        and os.path.getsize(os.path.join(OUTDIR, p["id"] + ".jpg")) >= MIN_BYTES)]

    total = len(todo)
    print("待生成 %d 张 -> %s" % (total, OUTDIR), flush=True)
    ok = fail = 0
    t_all = time.time()
    for n, p in enumerate(todo, 1):
        pid, title = p["id"], p["title"]
        full = build_prompt(prefix, prompts[pid], suffix)
        seed = 1000 + p["idx"] * 7          # 固定种子 => 可复现
        path = os.path.join(OUTDIR, pid + ".jpg")
        t0 = time.time()
        try:
            raw = download(full, seed)
            size = crop_and_save(raw, path)
            ok += 1
            print("[%3d/%3d] %s %-14s ok  %s  %.1fs" % (n, total, pid, title, size, time.time() - t0), flush=True)
        except Exception as e:
            fail += 1
            print("[%3d/%3d] %s %-14s FAIL  %s" % (n, total, pid, title, e), flush=True)
        time.sleep(1.2)
    print("\n完成: 成功 %d / 失败 %d  用时 %.1f 分钟" % (ok, fail, (time.time() - t_all) / 60), flush=True)

if __name__ == "__main__":
    main()
