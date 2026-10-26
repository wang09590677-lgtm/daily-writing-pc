# -*- coding: utf-8 -*-
"""稳健分割：用 Canny 边缘 + 闭运算找角色块，避开渐变背景的干扰。"""
import cv2
import numpy as np

P = r"C:\Users\lixue\.workbuddy-ai\clipboard-images\clipboard-2026-10-06T00-33-05-616Z-78e11596.jpg"
img = cv2.imread(P)
H, W = img.shape[:2]
print("图 %dx%d" % (W, H))

gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
# 自适应阈值：对渐变背景友好
binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                              cv2.THRESH_BINARY_INV, 51, -6)
binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))

n, lab, st, cent = cv2.connectedComponentsWithStats(binary, 8)
comps = [(i, st[i, 4], st[i, 0], st[i, 1], st[i, 2], st[i, 3], cent[i]) for i in range(1, n)]
comps.sort(key=lambda t: -t[1])
print("\n连通域（面积前 10）:")
for i, area, x, y, w, h, c in comps[:10]:
    print("  #%-3d 面积%7d (%.1f%%)  盒 x%4d y%3d w%4d h%4d  宽高比%.2f  中心(%.0f,%.0f)" %
          (i, area, area / (W * H) * 100, x, y, w, h, w / max(1, h), c[0], c[1]))


def hexbgr(c):
    return "#%02x%02x%02x" % (int(c[2]), int(c[1]), int(c[0]))


# 站姿人形：高 > 0.55H 且 宽高比 < 0.65
figs = [t for t in comps if t[5] > H * 0.55 and t[4] / max(1, t[5]) < 0.65]
heads = [t for t in comps if H * 0.10 < t[5] < H * 0.34 and 0.65 < t[4] / max(1, t[5]) < 1.5]

print("\n>>> 识别站姿人形 %d 个, 头部特写 %d 个" % (len(figs), len(heads)))

if figs:
    i, area, x, y, w, h, c = figs[0]
    m = (lab[y:y + h, x:x + w] == i)
    px = img[y:y + h, x:x + w][m]
    lum = px.astype(int).sum(axis=1)
    o = np.argsort(lum)
    q = lambda f: hexbgr(px[o[min(len(o) - 1, int(len(o) * f))]])
    print("\n" + "=" * 60)
    print("【站姿人形】盒 x%d y%d w%d h%d  像素%d" % (x, y, w, h, len(px)))
    print("=" * 60)
    print("  分位色: p05%s  p25%s  p50%s  p75%s  p95%s" % (q(.05), q(.25), q(.5), q(.75), q(.95)))
    print("  深色(<35%%分位)占比: %.0f%%" % ((lum < np.percentile(lum, 35)).mean() * 100))

    segs = ["头顶/耳", "脸/颈", "胸腔", "腹/腰", "胯", "大腿", "小腿", "脚部"]
    print("\n  自上而下 8 段:")
    for k, name in enumerate(segs):
        ya = y + int(h * k / len(segs)); yb = max(ya + 1, y + int(h * (k + 1) / len(segs)))
        m2 = (lab[ya:yb, x:x + w] == i)
        p2 = img[ya:yb, x:x + w][m2]
        if len(p2) < 60:
            print("    %-8s 样本少(%d)" % (name, len(p2))); continue
        l2 = p2.astype(int).sum(axis=1); o2 = np.argsort(l2)
        print("    %-8s 中位%s  暗%s(%2.0f%%)  亮%s" %
              (name, hexbgr(np.median(p2, axis=0)), hexbgr(p2[o2[len(o2) // 6]]),
               (l2 < np.percentile(l2, 35)).mean() * 100, hexbgr(p2[o2[-len(o2) // 6]])))

    # 身体比例：横向宽度随高度变化
    print("\n  【比例】按人体高度归一化，各位置宽度（占画面宽%）:")
    mm = (lab == i)
    ys = np.where(mm.any(axis=1))[0]; y0, y1 = ys.min(), ys.max()
    for k in range(0, 24):
        yy = int(y0 + (y1 - y0) * (k + 0.5) / 24)
        row = np.where(mm[yy])[0]
        if row.size == 0:
            continue
        xa = x; xb = x + w
        rel = (row.max() - row.min()) / (xb - xa) * 100
        print("     y=%.2f 宽%3.0f%%  左%.2f 右%.2f" %
              ((k + 0.5) / 24, rel, (row.min() - xa) / (xb - xa), (row.max() - xa) / (xb - xa)))

if heads:
    i, area, x, y, w, h, c = heads[0]
    m = (lab[y:y + h, x:x + w] == i)
    px = img[y:y + h, x:x + w][m]
    lum = px.astype(int).sum(axis=1); o = np.argsort(lum)
    print("\n" + "=" * 60)
    print("【头部特写】盒 x%d y%d w%d h%d  宽高比%.2f  像素%d" % (x, y, w, h, w / h, len(px)))
    print("=" * 60)
    print("  分位色: p05%s  p25%s  p50%s  p75%s  p95%s" %
          (hexbgr(px[o[int(len(o) * .05)]]), hexbgr(px[o[int(len(o) * .25)]]),
           hexbgr(px[o[int(len(o) * .5)]]), hexbgr(px[o[int(len(o) * .75)]]),
           hexbgr(px[o[min(len(o) - 1, int(len(o) * .95))]])))
    print("  深色占比: %.0f%%" % ((lum < np.percentile(lum, 35)).mean() * 100))
