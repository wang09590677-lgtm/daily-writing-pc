# -*- coding: utf-8 -*-
"""把猫角色各视图渲染成可读轮廓（用半块字符做 2x 纵向分辨率）+ 分区取色。"""
import cv2
import numpy as np

P = r"C:\Users\lixue\.workbuddy-ai\clipboard-images\clipboard-2026-10-06T00-33-05-616Z-78e11596.jpg"
img = cv2.imread(P)
H, W = img.shape[:2]


def figure_mask(x, y, w, h, pad=12):
    x0 = max(0, x - pad); y0 = max(0, y - pad)
    x1 = min(W, x + w + pad); y1 = min(H, y + h + pad)
    roi = img[y0:y1, x0:x1]
    k = max(21, (min(roi.shape[:2]) // 8) | 1)
    bg = cv2.GaussianBlur(roi, (k, k), 0)
    d = cv2.absdiff(roi, bg)
    g = cv2.cvtColor(d, cv2.COLOR_BGR2GRAY)
    _, m = cv2.threshold(g, 20, 255, cv2.THRESH_BINARY)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    # 只保留最大连通域
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    if n > 1:
        big = 1 + int(np.argmax(st[1:, 4]))
        m = np.where(lab == big, 255, 0).astype(np.uint8)
    return roi, m


def render(mask, cols=34):
    h, w = mask.shape
    rows = max(8, int(cols * h / w / 2))
    m = cv2.resize(mask, (cols, rows * 2), interpolation=cv2.INTER_AREA)
    out = []
    for r in range(rows):
        t = m[r * 2] > 110
        b = m[r * 2 + 1] > 110
        out.append("".join("█" if (t[i] and b[i]) else "▀" if t[i] else "▄" if b[i] else " "
                           for i in range(cols)))
    return out


FIGS = [
    ("视图1 (最左, 含头)", 52, 41, 351, 790),
    ("视图2", 456, 42, 346, 830),
    ("视图3", 848, 40, 318, 785),
    ("视图4 (最右)", 1257, 40, 329, 781),
]

for name, x, y, w, h in FIGS[:2]:
    roi, m = figure_mask(x, y, w, h)
    rh, rw = m.shape
    print("\n" + "=" * 40)
    print("%s   抠图尺寸 %dx%d  宽高比 %.2f" % (name, rw, rh, rw / rh))
    print("=" * 40)
    for line in render(m, 34):
        print(line)

# ---- 分区取色（视图2，纯色区）----
print("\n" + "=" * 40)
print("视图2 分区主色")
print("=" * 40)
roi, m = figure_mask(456, 42, 346, 830)
ys, xs = np.where(m > 110)
ry0, ry1, rx0, rx1 = ys.min(), ys.max(), xs.min(), xs.max()
for k in range(6):
    ya = ry0 + (ry1 - ry0) * k // 6
    yb = max(ya + 1, ry0 + (ry1 - ry0) * (k + 1) // 6)
    sel = m[ya:yb, rx0:rx1] > 110
    if sel.sum() < 50:
        print("  第%d段: 样本太少" % (k + 1)); continue
    sub = roi[ya:yb, rx0:rx1][sel]
    med = np.median(sub, axis=0)
    # 同时给出"最亮"和"最暗"代表色
    lum = sub.astype(int).sum(axis=1)
    dark = sub[int(np.argmin(lum))]
    light = sub[int(np.argmax(lum))]
    print("  第%d段(y%.2f~%.2f) 中位#%02x%02x%02x  最暗#%02x%02x%02x  最亮#%02x%02x%02x" %
          (k + 1, k / 6, (k + 1) / 6, med[2], med[1], med[0], dark[2], dark[1], dark[0],
           light[2], light[1], light[0]))
