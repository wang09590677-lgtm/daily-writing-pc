# -*- coding: utf-8 -*-
"""用 cv2 分析猫图：找出主体轮廓、判断是不是"人形站姿猫"、量各部位比例。"""
import cv2
import numpy as np

P = r"C:\Users\lixue\.workbuddy-ai\clipboard-images\clipboard-2026-10-06T00-33-05-616Z-78e11596.jpg"
img = cv2.imread(P)
H, W = img.shape[:2]
print("尺寸: %dx%d  宽高比 %.2f" % (W, H, W / H))

# 背景：用"四周一圈像素"的均值 + 大模糊作为背景估计，做差分
k = max(31, (min(H, W) // 12) | 1)
bg = cv2.GaussianBlur(img, (k, k), 0)
diff = cv2.absdiff(img, bg)
gray = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)
_, m = cv2.threshold(gray, 25, 255, cv2.THRESH_BINARY)
m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))

n, lab, stats, cent = cv2.connectedComponentsWithStats(m, 8)
comps = []
for i in range(1, n):
    x, y, w, h, area = stats[i]
    if area > W * H * 0.002:
        comps.append((area, x, y, w, h, cent[i]))
comps.sort(reverse=True)
print("\n主要连通域 (面积>0.2%%画面): %d 个" % len(comps))
for area, x, y, w, h, c in comps[:8]:
    print("  面积%6d (%.1f%%)  盒 x%d y%d w%d h%d  宽高比%.2f  中心(%.0f,%.0f)" %
          (area, area / (W * H) * 100, x, y, w, h, w / max(1, h), c[0], c[1]))

# 取最大连通域当主体，输出更精细的 ASCII
if comps:
    area, x, y, w, h, c = comps[0]
    roi = img[y:y + h, x:x + w]
    rh, rw = roi.shape[:2]
    print("\n最大主体: %dx%d  宽高比 %.2f  (占画面高 %.0f%%)" % (rw, rh, rw / max(1, rh), rh / H * 100))
    rbg = cv2.GaussianBlur(roi, (max(21, (min(rh, rw) // 8) | 1),) * 2, 0)
    rd = cv2.absdiff(roi, rbg)
    rg = cv2.cvtColor(rd, cv2.COLOR_BGR2GRAY)
    _, rm = cv2.threshold(rg, 22, 255, cv2.THRESH_BINARY)
    rm = cv2.morphologyEx(rm, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    AW, AH = 74, 36
    sm = cv2.resize(rm, (AW, AH), interpolation=cv2.INTER_AREA)
    sg = cv2.cvtColor(cv2.resize(roi, (AW, AH), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    print("\n===== 主体抠图 ASCII（# 是主体，空格是背景）=====")
    for j in range(AH):
        print("".join("#" if sm[j, i] > 60 else " " for i in range(AW)))

    # 逐行量"主体宽度"，看形状（头/肩/腰/腿）
    print("\n===== 各高度处主体横向范围（判断形态）=====")
    print("  相对高度  左~右(占宽%)   宽度%")
    for k2 in range(0, 20):
        yy = int(rm.shape[0] * (k2 + 0.5) / 20)
        row = rm[yy] > 60
        if row.sum() == 0:
            print("   %.2f      （空）" % ((k2 + 0.5) / 20))
            continue
        idx = np.where(row)[0]
        print("   %.2f      %3.0f~%3.0f        %3.0f%%" %
              ((k2 + 0.5) / 20, idx.min() / rw * 100, idx.max() / rw * 100,
               (idx.max() - idx.min()) / rw * 100))
