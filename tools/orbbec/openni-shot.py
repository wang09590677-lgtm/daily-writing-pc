# -*- coding: utf-8 -*-
"""
把红外图和深度图存成 PNG，并且把每个深度分辨率都跑一遍。

为什么需要它：光看 ASCII 图和百分比猜不出相机到底"看到"了什么。
存成图片可以直接用眼睛判断：投影器有没有照亮、画面里有没有东西、
有效深度集中在哪个区域。

依赖：纯标准库（zlib + struct 手写 PNG），不需要装 Pillow。

用法：python openni-shot.py
输出：shot_ir.png / shot_depth_<WxH>.png  （就在本脚本旁边）
"""

import sys
import os
import time
import zlib
import struct

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from openni2bind import (OpenNI2, Stream, pick_mode,
                         ONI_SENSOR_IR, ONI_SENSOR_DEPTH,
                         ONI_PIXEL_FORMAT_DEPTH_1_MM, ONI_PIXEL_FORMAT_GRAY16)

OUT_DIR = os.path.dirname(os.path.abspath(__file__))


# ---------------- 纯标准库 PNG 写出 ----------------
def _chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, w, h, rows, rgb=False):
    """rows: list[bytearray]，灰度每行 w 字节，RGB 每行 w*3 字节"""
    color = 2 if rgb else 0
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, color, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) +
           _chunk(b"IDAT", zlib.compress(raw, 6)) + _chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return path


def gray_rows(buf, w, h, lo=None, hi=None):
    vals = [buf[i] for i in range(w * h)]
    lo = lo if lo is not None else min(vals)
    hi = hi if hi is not None else max(vals)
    span = float(hi - lo) if hi > lo else 1.0
    rows = []
    for y in range(h):
        row = bytearray(w)
        base = y * w
        for x in range(w):
            v = int(255.0 * (buf[base + x] - lo) / span)
            row[x] = 0 if v < 0 else (255 if v > 255 else v)
        rows.append(row)
    return rows, lo, hi


def depth_rows(buf, w, h, max_mm=4000):
    """近=红 远=蓝，0=黑"""
    rows = []
    for y in range(h):
        row = bytearray(w * 3)
        base = y * w
        for x in range(w):
            v = buf[base + x]
            i = x * 3
            if v == 0:
                row[i] = row[i + 1] = row[i + 2] = 0
                continue
            t = min(1.0, v / float(max_mm))   # 0=最近 1=最远
            # 近=红 → 黄 → 绿 → 青 → 远=蓝
            row[i] = int(255 * (1.0 - t))
            row[i + 1] = int(255 * (1.0 - abs(2.0 * t - 1.0)))
            row[i + 2] = int(255 * t)
        rows.append(row)
    return rows


def stats(buf, w, h):
    """返回 (有效像素%, 最近mm, 最远mm, 平均mm)"""
    total = valid = 0
    mn = 1 << 30
    mx = 0
    s = 0
    for i in range(0, w * h, 3):
        total += 1
        v = buf[i]
        if v > 0:
            valid += 1
            s += v
            if v < mn:
                mn = v
            if v > mx:
                mx = v
    if not valid:
        return 0.0, 0, 0, 0
    return 100.0 * valid / total, mn, mx, s // valid


def grid(buf, w, h, rows_n=6, cols_n=8):
    """有效深度在画面上的空间分布（每格的百分比）"""
    out = []
    for r in range(rows_n):
        line = []
        for c in range(cols_n):
            x0 = c * w // cols_n
            x1 = max(x0 + 1, (c + 1) * w // cols_n)
            y0 = r * h // rows_n
            y1 = max(y0 + 1, (r + 1) * h // rows_n)
            tot = ok = 0
            for y in range(y0, y1, 2):
                base = y * w
                for x in range(x0, x1, 2):
                    tot += 1
                    if buf[base + x] > 0:
                        ok += 1
            line.append(int(round(100.0 * ok / tot)) if tot else 0)
        out.append(line)
    return out


def grab(oni, sensor, mode, seconds, tag):
    st = Stream(oni, sensor, mode)
    best = (0.0, None, None, None)
    last = None
    t_end = time.time() + seconds
    n = 0
    while time.time() < t_end:
        r = st.read(500)
        if not r:
            continue
        buf, w, h, meta = r
        n += 1
        last = (buf, w, h, meta)
        if sensor == ONI_SENSOR_DEPTH:
            ratio = stats(buf, w, h)[0]
        else:
            ratio = sum(buf[::37]) / float(len(buf[::37]))
        if ratio >= best[0]:
            best = (ratio, buf, w, h)
    st.stop()
    print("  %-12s %2.0f 秒读到 %3d 帧" % (tag, seconds, n))
    return best, last


def main():
    oni = OpenNI2()
    if oni.initialize() != 0:
        print("[X] 初始化失败：%s" % oni.err())
        return 1
    dev = oni.open_first()
    if not dev:
        print("[X] 无设备：%s" % oni.err())
        return 2
    print("设备: %s  固件: %s  序列号: %s"
          % (dev["name"], oni.get_string_property(0), oni.get_string_property(3)))

    # ---------- 红外 ----------
    print("\n[1] 红外图（看投影器有没有把场景照亮）")
    ir_modes = oni.sensor_modes(ONI_SENSOR_IR)
    ir_mode = pick_mode(ir_modes, 640, 480, 30, ONI_PIXEL_FORMAT_GRAY16)
    if ir_mode:
        best, last = grab(oni, ONI_SENSOR_IR, ir_mode, 3, "IR")
        buf, w, h = best[1], best[2], best[3]
        if buf is None:
            buf, w, h = last[0], last[1], last[2]
        vals = [buf[i] for i in range(0, w * h, 7)]
        print("      %dx%d  最小 %d / 最大 %d / 平均 %d"
              % (w, h, min(vals), max(vals), sum(vals) // len(vals)))
        rows, lo, hi = gray_rows(buf, w, h, 0, 1023)
        write_png(os.path.join(OUT_DIR, "shot_ir.png"), w, h, rows)
        print("      已保存 shot_ir.png   ← 打开看看画面里有没有东西、亮不亮")
    else:
        print("      没有 IR 模式")

    # ---------- 各深度分辨率 ----------
    print("\n[2] 逐个深度分辨率测试")
    dmodes = oni.sensor_modes(ONI_SENSOR_DEPTH)
    seen = []
    for m in dmodes:
        key = (m["w"], m["h"], m["fps"])
        if key in seen:
            continue
        seen.append(key)
    print("     可用: %s" % ", ".join("%dx%d@%d" % k for k in seen))

    results = []
    for (w0, h0, fps0) in seen:
        mode = pick_mode(dmodes, w0, h0, fps0, ONI_PIXEL_FORMAT_DEPTH_1_MM)
        if not mode:
            continue
        best, last = grab(oni, ONI_SENSOR_DEPTH, mode, 3, "%dx%d@%d" % (w0, h0, fps0))
        buf, w, h = best[1], best[2], best[3]
        if buf is None:
            print("      %dx%d: 一帧都没读到" % (w0, h0))
            results.append((w0, h0, 0.0))
            continue
        pct, mn, mx, avg = stats(buf, w, h)
        print("      %4dx%-4d 最好一帧 有效 %5.1f%%   范围 %d~%d mm  平均 %d"
              % (w, h, pct, mn, mx, avg))
        results.append((w, h, pct))
        if pct > 0 and (w0, h0) == (640, 480):
            write_png(os.path.join(OUT_DIR, "shot_depth_640x480.png"),
                      w, h, depth_rows(buf, w, h), rgb=True)
            print("      已保存 shot_depth_640x480.png（近=红 远=蓝 黑=没数据）")
            print("      有效深度在画面上的分布（每格 %）：")
            for line in grid(buf, w, h):
                print("        " + " ".join("%3d" % v for v in line))

    oni.shutdown()

    print("\n" + "=" * 62)
    best = max(results, key=lambda r: r[2]) if results else (0, 0, 0)
    print("  有效比例最高的分辨率: %dx%d (%.1f%%)" % best)
    print("=" * 62)
    return 0


if __name__ == "__main__":
    sys.exit(main())
