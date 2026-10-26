# -*- coding: utf-8 -*-
"""细看猫角色：配色分区、头部特写、四视图差异。"""
import cv2
import numpy as np

P = r"C:\Users\lixue\.workbuddy-ai\clipboard-images\clipboard-2026-10-06T00-33-05-616Z-78e11596.jpg"
img = cv2.imread(P)
H, W = img.shape[:2]


def figure_mask(x, y, w, h, pad=10, thr=20):
    x0 = max(0, x - pad); y0 = max(0, y - pad)
    x1 = min(W, x + w + pad); y1 = min(H, y + h + pad)
    roi = img[y0:y1, x0:x1]
    k = max(21, (min(roi.shape[:2]) // 8) | 1)
    bg = cv2.GaussianBlur(roi, (k, k), 0)
    d = cv2.absdiff(roi, bg)
    g = cv2.cvtColor(d, cv2.COLOR_BGR2GRAY)
    _, m = cv2.threshold(g, thr, 255, cv2.THRESH_BINARY)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((13, 13), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    if n > 1:
        big = 1 + int(np.argmax(st[1:, 4]))
        m = np.where(lab == big, 255, 0).astype(np.uint8)
    return roi, m, (x0, y0)


def hexs(c):
    return "#%02x%02x%02x" % (int(c[2]), int(c[1]), int(c[0]))


# ---- A. 头部特写 (x138 y41 w180 h187) ----
print("=" * 52)
print("A. 头部特写分析  (原图区域 x138-318, y41-228)")
print("=" * 52)
roi, m, (ox, oy) = figure_mask(138, 41, 180, 187, pad=6)
rh, rw = m.shape
# 头部用较细节的渲染
AW = 40; AH = 22
sm = cv2.resize(m, (AW, AH), interpolation=cv2.INTER_AREA)
sg = cv2.cvtColor(cv2.resize(roi, (AW, AH), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
print("( # 暗部/深色斑纹, + 中间调, . 亮部, 空格 背景 )")
for j in range(AH):
    line = []
    for i in range(AW):
        if sm[j, i] < 60:
            line.append(" ")
            continue
        v = sg[j, i]
        line.append("#" if v < 90 else "+" if v < 150 else "." if v < 200 else ":")
    print("".join(line))
sel = m > 110
sub = roi[sel]
lum = sub.astype(int).sum(axis=1)
o = np.argsort(lum)
print("\n头部配色: 最暗10%%中位 %s | 整体中位 %s | 最亮10%%中位 %s" %
      (hexs(np.median(sub[o[:max(1, len(o)//10)]], axis=0)),
       hexs(np.median(sub, axis=0)),
       hexs(np.median(sub[o[-max(1, len(o)//10):]], axis=0))))
# 深色像素占比
dark = (lum < np.percentile(lum, 35)).mean()
print("深色（暗斑/线条）占头部面积: %.0f%%" % (dark * 100))

# ---- B. 四个站姿视图的差异 ----
print("\n" + "=" * 52)
print("B. 四个站姿视图对比（看是不是同一角色的不同姿势）")
print("=" * 52)
VIEWS = [("视图1", 52, 41, 351, 790), ("视图2", 456, 42, 346, 830),
         ("视图3", 848, 40, 318, 785), ("视图4", 1257, 40, 329, 781)]
for name, x, y, w, h in VIEWS:
    roi2, m2, _ = figure_mask(x, y, w, h)
    ys, xs = np.where(m2 > 110)
    rh2, rw2 = m2.shape
    fh = ys.max() - ys.min(); fw = xs.max() - xs.min()
    sel2 = m2 > 110
    sub2 = roi2[sel2]
    lum2 = sub2.astype(int).sum(axis=1)
    dk = (lum2 < np.percentile(lum2, 35)).mean()
    # 逐行宽度轮廓（20 段）—— 用来看姿势差异
    prof = []
    for k in range(20):
        yy = int(ys.min() + fh * (k + 0.5) / 20)
        row = np.where(m2[yy] > 110)[0]
        prof.append(0 if row.size == 0 else (row.max() - row.min()) / rw2)
    print("\n%s: 抠图 %dx%d 宽高比%.2f | 身体高%0.f%%画面 | 中位色 %s | 深色%.0f%%" %
          (name, rw2, rh2, rw2 / rh2, fh / H * 100, hexs(np.median(sub2, axis=0)), dk * 100))
    print("        逐段宽度: " + " ".join("%2.0f" % (v * 100) for v in prof))

# ---- C. 视图2 分区配色（自上而下）----
print("\n" + "=" * 52)
print("C. 视图2 自上而下分区配色")
print("=" * 52)
roi3, m3, _ = figure_mask(456, 42, 346, 830)
ys, xs = np.where(m3 > 110)
ry0, ry1, rx0, rx1 = ys.min(), ys.max(), xs.min(), xs.max()
LABELS = ["头顶/耳", "脸", "颈肩", "胸腹", "腰胯", "大腿", "小腿", "脚"]
for k, lb in enumerate(LABELS):
    ya = ry0 + int((ry1 - ry0) * k / len(LABELS))
    yb = max(ya + 1, ry0 + int((ry1 - ry0) * (k + 1) / len(LABELS)))
    s = m3[ya:yb, rx0:rx1] > 110
    if s.sum() < 40:
        print("  %-8s: 样本少" % lb); continue
    px = roi3[ya:yb, rx0:rx1][s]
    l2 = px.astype(int).sum(axis=1)
    o2 = np.argsort(l2)
    print("  %-8s: 中位%s 暗部%s(%2.0f%%) 亮部%s" %
          (lb, hexs(np.median(px, axis=0)),
           hexs(np.median(px[o2[:max(1, len(o2)//5)]], axis=0)),
           (l2 < np.percentile(l2, 35)).mean() * 100,
           hexs(np.median(px[o2[-max(1, len(o2)//5):]], axis=0))))
