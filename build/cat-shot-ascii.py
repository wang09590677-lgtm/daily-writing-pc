# -*- coding: utf-8 -*-
"""高分辨率 ASCII「看」猫：整体轮廓 + 头部特写 + 尾巴位置。
当前底层模型不支持读图，这是唯一可靠的造型验证手段。"""
import cv2
import numpy as np

img = cv2.imread("build/shots/cat-avatar.png")
H, W = img.shape[:2]
b = img[:, :, 0].astype(int)
g = img[:, :, 1].astype(int)
r = img[:, :, 2].astype(int)
fg = ~((b > r + 8) & (b < 95) & (r < 80))
fg[int(H * 0.88):, :] = False          # 去掉底部控制条
keep = np.zeros_like(fg)
keep[:, int(W * 0.25):int(W * 0.75)] = True
fg = fg & keep

ys, xs = np.where(fg)
y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
print(f"模型包围盒: x {x0}-{x1} ({x1-x0}px)  y {y0}-{y1} ({y1-y0}px)")


def ascii_of(mask, cols, aspect=0.48, thr=0.25, label=""):
    ch, cw = mask.shape
    rows = max(1, int(ch / cw * cols * aspect))
    small = cv2.resize(mask.astype(np.uint8), (cols, rows),
                       interpolation=cv2.INTER_AREA)
    print(f"\n=== {label} ({cols}x{rows}) ===")
    for row in small:
        print("".join("#" if v > thr else "." for v in row))


crop = fg[y0:y1 + 1, x0:x1 + 1]
ascii_of(crop, 64, 0.48, 0.22, "整体轮廓")

# 头部特写：取上 22%
head = fg[y0:y0 + int((y1 - y0) * 0.22), x0:x1 + 1]
ascii_of(head, 60, 0.55, 0.22, "头部特写（应有两只三角耳）")

# 找耳朵：头顶 12% 内的连通域应有 2 个（两只耳尖）
top = fg[y0:y0 + int((y1 - y0) * 0.14), x0:x1 + 1].astype(np.uint8)
n, lab, stats, cent = cv2.connectedComponentsWithStats(top, 8)
sizes = sorted([stats[i, cv2.CC_STAT_AREA] for i in range(1, n)], reverse=True)
print(f"\n头顶 14% 内的连通块数（含噪声）: {n-1}，各块面积: {sizes[:6]}")

# 尾巴：检查中段右/左侧是否有明显外伸的独立区域
mid = fg[y0 + int((y1 - y0) * 0.30):y0 + int((y1 - y0) * 0.62), :]
cols_any = mid.any(axis=0)
idx = np.where(cols_any)[0]
print(f"躯干段（30%~62%）前景列范围: {idx.min()}-{idx.max()}，中心 {(idx.min()+idx.max())//2}，"
      f"画面中心 {W//2}")
right_ext = idx.max() - W // 2
left_ext = W // 2 - idx.min()
print(f"  右伸 {right_ext}px / 左伸 {left_ext}px  → 尾巴/手臂偏向"
      f"{'右' if right_ext > left_ext else '左'}侧")
