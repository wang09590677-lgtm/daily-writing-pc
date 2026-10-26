# -*- coding: utf-8 -*-
"""精确分割猫角色（flood fill 抠背景）并提取权威配色与身体比例。"""
import cv2
import numpy as np

P = r"C:\Users\lixue\.workbuddy-ai\clipboard-images\clipboard-2026-10-06T00-33-05-616Z-78e11596.jpg"
img = cv2.imread(P)
H, W = img.shape[:2]

# ---- flood fill 从四边灌背景：能稳健处理渐变背景 ----
mask = np.zeros((H + 2, W + 2), np.uint8)
ff = img.copy()
for seed in [(2, 2), (W - 3, 2), (2, H - 3), (W - 3, H - 3),
             (W // 2, 2), (W // 2, H - 3), (2, H // 2), (W - 3, H // 2)]:
    if mask[seed[1] + 1, seed[0] + 1] == 0:
        cv2.floodFill(ff, mask, seed, (0, 0, 0), (12, 12, 12), (12, 12, 12),
                      cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (255 << 8))
# mask 里 255 = 背景（被灌过）
bgmask = (mask[1:-1, 1:-1] == 255)
fg = ~bgmask
fg = cv2.morphologyEx(fg.astype(np.uint8) * 255, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))

n, lab, st, cent = cv2.connectedComponentsWithStats(fg, 8)
comps = [(i, st[i, 4], st[i, 0], st[i, 1], st[i, 2], st[i, 3]) for i in range(1, n)]
comps.sort(key=lambda t: -t[1])
print("连通域（面积前 8）:")
for i, area, x, y, w, h in comps[:8]:
    print("  #%d 面积%6d (%.1f%%)  盒 x%d y%d w%d h%d  宽高比%.2f" %
          (i, area, area / (W * H) * 100, x, y, w, h, w / max(1, h)))


def hexbgr(c):
    return "#%02x%02x%02x" % (int(c[2]), int(c[1]), int(c[0]))


# ---- 取最大的"人形"连通域（宽高比 < 0.6 且 h > 0.5H）----
figs = [t for t in comps if t[5] > H * 0.5 and t[4] / max(1, t[5]) < 0.62]
print("\n识别到 %d 个站姿人形" % len(figs))

# 头部特写单独找（h 在 0.1~0.3 H，宽高比接近 1）
heads = [t for t in comps if H * 0.1 < t[5] < H * 0.32 and 0.7 < t[4] / max(1, t[5]) < 1.4]

def palette(idx, x, y, w, h, label):
    m = (lab[y:y + h, x:x + w] == idx)
    px = img[y:y + h, x:x + w][m]
    if len(px) < 100:
        return None
    lum = px.astype(int).sum(axis=1)
    o = np.argsort(lum)
    q = lambda f: px[o[int(len(o) * f)]]
    res = {
        "n": len(px),
        "p05": q(0.05), "p25": q(0.25), "p50": q(0.50), "p75": q(0.75), "p95": q(0.95),
        "dark%": float((lum < np.percentile(lum, 35)).mean() * 100),
    }
    print("\n[%s]  像素%d  深色占比%.0f%%" % (label, res["n"], res["dark%"]))
    print("   p05%s  p25%s  p50%s  p75%s  p95%s" %
          (hexbgr(res["p05"]), hexbgr(res["p25"]), hexbgr(res["p50"]),
           hexbgr(res["p75"]), hexbgr(res["p95"])))
    return res

if figs:
    i, area, x, y, w, h = figs[0]
    print("\n" + "=" * 56)
    print("站姿人形配色（第 1 个，盒 x%d y%d w%d h%d）" % (x, y, w, h))
    print("=" * 56)
    palette(i, x, y, w, h, "整体")
    # 纵向 8 段
    segs = ["头顶/耳", "脸/颈", "胸", "腹/腰", "胯/大腿", "小腿", "脚", "底影"]
    for k, name in enumerate(segs):
        ya = y + int(h * k / len(segs)); yb = max(ya + 1, y + int(h * (k + 1) / len(segs)))
        m = (lab[ya:yb, x:x + w] == i)
        px = img[ya:yb, x:x + w][m]
        if len(px) < 60:
            print("  %-9s 样本少" % name); continue
        lum = px.astype(int).sum(axis=1)
        o = np.argsort(lum)
        print("  %-9s 中位%s  暗%s  亮%s  深色%.0f%%" %
              (name, hexbgr(np.median(px, axis=0)),
               hexbgr(px[o[len(o) // 6]]), hexbgr(px[o[-len(o) // 6]]),
               (lum < np.percentile(lum, 35)).mean() * 100))

    # 身体比例（用于建模）
    m = (lab[:, :] == i)
    ys = np.where(m.any(axis=1))[0]
    y0, y1 = ys.min(), ys.max()
    print("\n【身体比例】（人体高 = 1.0）")
    for k in range(0, 20):
        yy = int(y0 + (y1 - y0) * (k + 0.5) / 20)
        row = np.where(m[yy])[0]
        if row.size == 0:
            continue
        print("   y=%.2f  宽%.0f%%  中心%.2f" %
              ((k + 0.5) / 20, (row.max() - row.min()) / W * 100, (row.max() + row.min()) / 2 / W))

if heads:
    i, area, x, y, w, h = heads[0]
    print("\n" + "=" * 56)
    print("头部特写配色（盒 x%d y%d w%d h%d）" % (x, y, w, h))
    print("=" * 56)
    palette(i, x, y, w, h, "头部")
