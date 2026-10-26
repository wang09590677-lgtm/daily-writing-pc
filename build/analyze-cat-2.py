# -*- coding: utf-8 -*-
"""细看这张图：是不是多联拼图？主体轮廓比例如何？"""
from PIL import Image
import numpy as np

P = r"C:\Users\lixue\.workbuddy-ai\clipboard-images\clipboard-2026-10-06T00-33-05-616Z-78e11596.jpg"
im = Image.open(P).convert("RGB")
a = np.asarray(im).astype(np.int16)
H, W, _ = a.shape
print("尺寸:", W, "x", H, " 宽高比 %.2f" % (W / H))

# 背景估算：四角 40x40 中位数
def med_corner():
    cs = [a[0:40, 0:40], a[0:40, W-40:W], a[H-40:H, 0:40], a[H-40:H, W-40:W]]
    return np.median(np.concatenate([c.reshape(-1, 3) for c in cs], axis=0), axis=0)
bg = med_corner()
print("背景色(中位): #%02x%02x%02x" % tuple(int(v) for v in bg))

diff = np.abs(a - bg).sum(axis=2)
fg = diff > 70
print("前景像素占比: %.1f%%" % (fg.mean() * 100))

# 列直方图：找"空列"分隔 → 判断是否多联图
colsum = fg.sum(axis=0)
thr = H * 0.02
empty = colsum < thr
# 找出连续空列区间
runs = []
s = None
for i, e in enumerate(empty):
    if e and s is None:
        s = i
    elif not e and s is not None:
        runs.append((s, i - 1)); s = None
if s is not None:
    runs.append((s, W - 1))
wide = [(x, y) for x, y in runs if y - x > W * 0.01]
print("\n连续空列区间（宽度>1%%画面）:", [(x, y, y - x) for x, y in wide][:20])

# 行直方图
rowsum = fg.sum(axis=1)
rempty = rowsum < W * 0.02
runs2 = []
s = None
for i, e in enumerate(rempty):
    if e and s is None:
        s = i
    elif not e and s is not None:
        runs2.append((s, i - 1)); s = None
if s is not None:
    runs2.append((s, H - 1))
wide2 = [(x, y) for x, y in runs2 if y - x > H * 0.02]
print("连续空行区间:", [(x, y, y - x) for x, y in wide2][:20])

# 前景包围盒
ys, xs = np.where(fg)
if len(xs):
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    print("\n整体前景包围盒: x %d~%d y %d~%d (宽%d 高%d)  宽高比 %.2f" %
          (x0, x1, y0, y1, x1 - x0, y1 - y0, (x1 - x0) / max(1, y1 - y0)))

    # 分 4 段看每段是否有独立主体
    print("\n按宽度 4 等分，各段前景像素占比:")
    for k in range(4):
        xa, xb = k * W // 4, (k + 1) * W // 4
        seg = fg[:, xa:xb]
        if seg.sum():
            sy, sx = np.where(seg)
            print("  第%d段 x=%d~%d: 占比%.1f%%  包围盒高 %d~%d (高%d, 占段高%.0f%%)" %
                  (k + 1, xa, xb, seg.mean() * 100, sy.min(), sy.max(), sy.max() - sy.min(),
                   (sy.max() - sy.min()) / H * 100))
        else:
            print("  第%d段 x=%d~%d: 空" % (k + 1, xa, xb))
