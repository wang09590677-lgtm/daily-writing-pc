# -*- coding: utf-8 -*-
"""把剪贴板里的猫咪图转成我能"看"的形式：ASCII 轮廓 + 主色统计 + 分区域取样。"""
import sys
from PIL import Image, ImageFilter

P = r"C:\Users\lixue\.workbuddy-ai\clipboard-images\clipboard-2026-10-06T00-33-05-616Z-78e11596.jpg"
im = Image.open(P).convert("RGB")
W, H = im.size
print("尺寸:", W, "x", H)

# ---- 1) 背景色：取四角 20x20 的平均 ----
def avg(box):
    r = im.crop(box).resize((1, 1), Image.LANCZOS)
    return r.getpixel((0, 0))

corners = {
    "左上": avg((0, 0, 20, 20)),
    "右上": avg((W - 20, 0, W, 20)),
    "左下": avg((0, H - 20, 20, H)),
    "右下": avg((W - 20, H - 20, W, H)),
}
print("\n四角背景色:", {k: "#%02x%02x%02x" % v for k, v in corners.items()})

# ---- 2) 前景分割：与背景差异大的像素 ----
bg = corners["左上"]
px = im.load()
step = 2
fg_pts = []
for y in range(0, H, step):
    for x in range(0, W, step):
        r, g, b = px[x, y]
        if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 60:
            fg_pts.append((x, y))
if fg_pts:
    xs = [p[0] for p in fg_pts]; ys = [p[1] for p in fg_pts]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    print("前景(主体)包围盒: x %d~%d, y %d~%d  (宽%d 高%d)" % (x0, x1, y0, y1, x1-x0, y1-y0))
    print("主体占画面: 宽 %.0f%% 高 %.0f%%" % ((x1-x0)/W*100, (y1-y0)/H*100))
    cx = (x0+x1)//2; cy = (y0+y1)//2
    print("主体中心: (%d, %d)  → 画面相对位置 (%.2f, %.2f)" % (cx, cy, cx/W, cy/H))
else:
    print("未分割出主体（可能背景不单一）")

# ---- 3) 主体主色（量化后统计）----
if fg_pts:
    sub = im.crop((x0, y0, x1+1, y1+1)).convert("RGB")
    q = sub.quantize(colors=8, method=Image.MEDIANCUT).convert("RGB")
    from collections import Counter
    c = Counter(q.getdata())
    total = sum(c.values())
    print("\n主体主要颜色（前8）:")
    for col, n in c.most_common(8):
        print("   #%02x%02x%02x  %5.1f%%" % (col[0], col[1], col[2], n/total*100))

# ---- 4) ASCII 轮廓（让人能看出姿态）----
AW, AH = 78, 34
small = im.resize((AW, AH), Image.LANCZOS)
sp = small.load()
print("\n===== ASCII 轮廓（# 深 / + 中 / . 浅 / 空格=背景）=====")
for j in range(AH):
    line = []
    for i in range(AW):
        r, g, b = sp[i, j]
        d = abs(r-bg[0]) + abs(g-bg[1]) + abs(b-bg[2])
        lum = (r*299 + g*587 + b*114) / 1000
        if d <= 60:
            line.append(" ")
        elif lum < 70:
            line.append("#")
        elif lum < 130:
            line.append("+")
        elif lum < 185:
            line.append(":")
        else:
            line.append(".")
    print("".join(line))

# ---- 5) 按身体分区取样（头/中/下），帮判断各部位颜色 ----
if fg_pts:
    print("\n===== 纵向分区主色（从上到下 5 段）=====")
    for k in range(5):
        ya = y0 + (y1-y0)*k//5
        yb = y0 + (y1-y0)*(k+1)//5
        seg = im.crop((x0, ya, x1+1, max(yb, ya+1))).convert("RGB")
        qq = seg.quantize(colors=3, method=Image.MEDIANCUT).convert("RGB")
        cc = Counter(qq.getdata())
        tot = sum(cc.values())
        desc = "  ".join("#%02x%02x%02x(%.0f%%)" % (c0[0], c0[1], c0[2], n/tot*100)
                        for c0, n in cc.most_common(3))
        print("  第%d段 y=%d~%d: %s" % (k+1, ya, yb, desc))
