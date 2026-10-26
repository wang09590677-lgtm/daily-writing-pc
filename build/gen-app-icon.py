# -*- coding: utf-8 -*-
"""生成应用图标 assets/app.ico

与页面左上角品牌标识保持一致（index.html 的 .brand-icon）：
橙色圆角方块 + 白色「写」字，配色取自 styles.css 的
linear-gradient(135deg, #fb923c, #f97316)。

为什么自己生成而不是找现成图：项目里没有任何 .ico，
而快捷方式指向 .bat 时默认是齿轮图标，家长认不出来。
用同一个品牌标识做的图标，和双击进去看到的界面对得上。

运行：python build/gen-app-icon.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "app.ico")

SIZES = [16, 24, 32, 48, 64, 128, 256]
SS = 4                                   # 超采样倍数，降采样后边缘才干净
C1 = (0xFB, 0x92, 0x3C)                  # 左上（浅橙）
C2 = (0xF9, 0x73, 0x16)                  # 右下（深橙）= --primary
FONT = "C:/Windows/Fonts/msyhbd.ttc"     # 微软雅黑 粗体
GLYPH = "\u5199"                         # 「写」


def render(size):
    S = size * SS

    # --- 135° 线性渐变：用 2x2 图双线性放大，比逐像素循环快且足够平滑 ---
    mid = tuple((C1[i] + C2[i]) // 2 for i in range(3))
    g = Image.new("RGB", (2, 2))
    g.putpixel((0, 0), C1)
    g.putpixel((1, 0), mid)
    g.putpixel((0, 1), mid)
    g.putpixel((1, 1), C2)
    grad = g.resize((S, S), Image.BICUBIC)

    # --- 圆角遮罩（页面 .brand-icon 是 18/54 = 0.33，整体取 0.23 更像应用图标）---
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, S - 1, S - 1], radius=int(S * 0.23), fill=255)

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    # --- 白色「写」字，按实际墨迹包围盒居中（anchor="mm" 对中文会偏上）---
    font = ImageFont.truetype(FONT, int(S * 0.60))
    d = ImageDraw.Draw(img)
    bbox = d.textbbox((0, 0), GLYPH, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((S - w) / 2 - bbox[0], (S - h) / 2 - bbox[1]),
           GLYPH, font=font, fill=(255, 255, 255, 255))

    return img.resize((size, size), Image.LANCZOS)


os.makedirs(os.path.dirname(OUT), exist_ok=True)
imgs = [render(s) for s in SIZES]
imgs[-1].save(OUT, format="ICO", sizes=[(s, s) for s in SIZES])
print("已生成 " + OUT)
print("大小 " + str(os.path.getsize(OUT)) + " bytes, 含尺寸 " + str(SIZES))
