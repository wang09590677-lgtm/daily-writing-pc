# -*- coding: utf-8 -*-
"""
抓一段真实深度数据，降采样成引擎用的 96x72 网格，落盘成 JSON。

为什么需要它：
  之前的调试全靠在浏览器里"合成"一个理想人形（几何精确、边缘锐利、
  无深度空洞、无量化噪声）。用户质疑：没有真人参照物调出来的效果必然不对。
  要对这个质疑给出事实回答，必须先把**真实相机的数据特性**量出来，
  再和合成数据做对照。

本脚本做两件事：
  1. 抓真实深度 → 降采样 96x72（与 depth-link.js 的"每格取最近"完全一致）→ 落盘
  2. 打印真实数据的统计特性：量化台阶、空洞率、边缘过渡宽度、时间噪声

用法：
  python capture-real-depth.py --seconds 3 --tag empty
  python capture-real-depth.py --seconds 5 --tag person   # 让人站进去再跑
输出：real-depth-<tag>.json（96x72 网格 + 元信息）
"""

import sys
import os
import json
import time
import argparse
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from openni2bind import (OpenNI2, Stream, pick_mode, ONI_SENSOR_DEPTH,
                         ONI_PIXEL_FORMAT_DEPTH_1_MM)

GW, GH = 96, 72


def downsample(buf, w, h):
    """与 depth-link.js 完全一致：每格取最近的非零深度"""
    grid = [[0] * GW for _ in range(GH)]
    mapx = [min(GW - 1, x * GW // w) for x in range(w)]
    mapy = [min(GH - 1, y * GH // h) for y in range(h)]
    best = [[1 << 30] * GW for _ in range(GH)]
    for y in range(h):
        gy = mapy[y]
        base = y * w
        row = best[gy]
        for x in range(w):
            v = buf[base + x]
            if not v:
                continue
            gx = mapx[x]
            if v < row[gx]:
                row[gx] = v
    valid = 0
    for gy in range(GH):
        for gx in range(GW):
            v = best[gy][gx]
            if v >= (1 << 30):
                grid[gy][gx] = 0
            else:
                grid[gy][gx] = v
                valid += 1
    return grid, valid


def analyze(buf, w, h):
    """量真实数据的"不理想程度"：空洞率、量化、边缘过渡"""
    n = w * h
    vals = [buf[i] for i in range(n)]
    nz = [v for v in vals if v > 0]
    if not nz:
        return None
    # 量化台阶：相邻两个不同深度值的差（真实深度是离散的）
    uniq = sorted(set(nz))
    if len(uniq) > 1:
        gaps = [uniq[i + 1] - uniq[i] for i in range(len(uniq) - 1)]
        gaps = [g for g in gaps if g > 0]
        gap_med = statistics.median(gaps) if gaps else 0
        gap_max = max(gaps) if gaps else 0
    else:
        gap_med = gap_max = 0

    # 水平方向"边缘过渡宽度"：相邻像素深度差的分布
    diffs = []
    for y in range(0, h, 2):
        base = y * w
        for x in range(0, w - 1, 2):
            a, b = buf[base + x], buf[base + x + 1]
            if a and b:
                diffs.append(abs(a - b))
    diffs.sort()
    if diffs:
        d_med = diffs[len(diffs) // 2]
        d_p90 = diffs[int(len(diffs) * 0.90)]
        d_p99 = diffs[int(len(diffs) * 0.99)]
        d_max = diffs[-1]
    else:
        d_med = d_p90 = d_p99 = d_max = 0

    # 空洞率
    hole = 1.0 - len(nz) / float(n)

    return {
        "valid_ratio": round(len(nz) / float(n), 4),
        "hole_ratio": round(hole, 4),
        "min_mm": min(nz), "max_mm": max(nz),
        "uniq_values": len(uniq),
        "quant_gap_med": gap_med, "quant_gap_max": gap_max,
        "neighbor_diff_med": d_med,
        "neighbor_diff_p90": d_p90,
        "neighbor_diff_p99": d_p99,
        "neighbor_diff_max": d_max,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=3.0)
    ap.add_argument("--tag", default="scene")
    ap.add_argument("--frames", type=int, default=8,
                    help="落盘几帧到 JSON（测试回放用）")
    args = ap.parse_args()

    oni = OpenNI2()
    if oni.initialize() != 0:
        print("[X] OpenNI 初始化失败: %s" % oni.err())
        return 1
    dev = oni.open_first()
    if not dev:
        print("[X] 无设备: %s" % oni.err())
        return 1
    print("设备: %s  固件: %s  序列号: %s"
          % (dev["name"], oni.get_string_property(0), oni.get_string_property(3)))

    modes = oni.sensor_modes(ONI_SENSOR_DEPTH)
    mode = pick_mode(modes, 640, 480, 30, ONI_PIXEL_FORMAT_DEPTH_1_MM)
    if not mode:
        print("[X] 没有 640x480 深度模式")
        return 2
    st = Stream(oni, ONI_SENSOR_DEPTH, mode)
    print("深度流 %dx%d@%d" % (mode["w"], mode["h"], mode["fps"]))

    per_frame = []
    grids = []
    t_end = time.time() + args.seconds
    idx = 0
    while time.time() < t_end:
        r = st.read(500)
        if not r:
            continue
        buf, w, h, meta = r
        idx += 1
        a = analyze(buf, w, h)
        if a:
            per_frame.append(a)
        if len(grids) < args.frames:
            g, valid = downsample(buf, w, h)
            grids.append({"grid": g, "validCells": valid})
    st.stop()
    oni.shutdown()

    if not per_frame:
        print("[X] 一帧有效数据都没有")
        return 3

    # 跨帧汇总
    def avg(key):
        return round(statistics.mean([f[key] for f in per_frame]), 4)

    print("\n================ 真实 640x480 深度数据特性（%d 帧）================" % len(per_frame))
    print("  有效像素比例      : %.1f%%   （空房间实测）" % (avg("valid_ratio") * 100))
    print("  深度空洞比例      : %.1f%%   ← 合成数据永远是 0" % (avg("hole_ratio") * 100))
    print("  距离范围          : %d ~ %d mm" % (per_frame[0]["min_mm"], per_frame[0]["max_mm"]))
    print("  出现过的不同深度值: %d 个" % avg("uniq_values"))
    print("  量化台阶(中位/最大): %d / %d mm   ← 深度是离散的" % (avg("quant_gap_med"), avg("quant_gap_max")))
    print("  相邻像素深度差    : 中位 %d / p90 %d / p99 %d / 最大 %d mm"
          % (avg("neighbor_diff_med"), avg("neighbor_diff_p90"),
             avg("neighbor_diff_p99"), avg("neighbor_diff_max")))
    print("                      ← 合成人形这一步恒为 0（边缘一步跳变）")

    # 落盘
    out = {
        "device": dev["name"], "serial": oni.__class__.__name__ and "",
        "srcW": mode["w"], "srcH": mode["h"],
        "gw": GW, "gh": GH,
        "capturedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "tag": args.tag,
        "stats": {k: avg(k) for k in
                  ("valid_ratio", "hole_ratio", "uniq_values",
                   "quant_gap_med", "quant_gap_max", "neighbor_diff_med",
                   "neighbor_diff_p90", "neighbor_diff_p99", "neighbor_diff_max")},
        "frames": grids,
    }
    path = os.path.join(HERE, "real-depth-%s.json" % args.tag)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print("\n  已落盘: %s（%d 帧 96x72 网格）" % (os.path.basename(path), len(grids)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
