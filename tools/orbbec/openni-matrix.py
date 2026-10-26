# -*- coding: utf-8 -*-
"""
矩阵测试：找出"到底要怎么开，Astra Pro 的深度才出数据"

对比四种开法：
  A  只开深度，用驱动默认模式
  B  只开深度，显式指定 640x480@30 DEPTH_1_MM
  C  先开红外跑一会儿再关，然后开深度
  D  红外和深度同时开着
"""

import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from openni2bind import (OpenNI2, Stream, pick_mode, ascii_map,
                         ONI_SENSOR_DEPTH, ONI_SENSOR_IR,
                         ONI_PIXEL_FORMAT_DEPTH_1_MM, ONI_PIXEL_FORMAT_GRAY16)

FRAMES = 40


def stats(buf):
    valid = 0
    dmin, dmax = 65535, 0
    for v in buf:
        if v > 0:
            valid += 1
            if v < dmin:
                dmin = v
            if v > dmax:
                dmax = v
    return valid, len(buf), (dmin if valid else 0), dmax


def run_depth(oni, mode, frames=FRAMES, label=""):
    st = Stream(oni, ONI_SENSOR_DEPTH, mode)
    best = None
    for _ in range(frames):
        r = st.read(2500)
        if not r:
            continue
        buf, w, h, meta = r
        s = stats(buf)
        if best is None or s[0] > best[0][0]:
            best = (s, buf, w, h)
    st.stop()
    return best


def report(name, best):
    if not best:
        print("  %-8s 读不到帧" % name)
        return 0
    s, buf, w, h = best
    ratio = 100.0 * s[0] / s[1]
    print("  %-8s 最好一帧有效 %6d/%d (%5.1f%%)  最近 %5dmm 最远 %5dmm"
          % (name, s[0], s[1], ratio, s[2], s[3]))
    if ratio > 1.0:
        for line in ascii_map(buf, w, h, cols=44, rows=16):
            print("           |%s|" % line)
    return ratio


def main():
    oni = OpenNI2()
    if oni.initialize() != 0:
        print("[X] 初始化失败：%s" % oni.err())
        return 1
    dev = oni.open_first()
    if not dev:
        print("[X] 无设备：%s" % oni.err())
        return 2
    print("设备: %s" % dev["name"])

    depth_modes = oni.sensor_modes(ONI_SENSOR_DEPTH)
    dmode = pick_mode(depth_modes, 640, 480, 30, ONI_PIXEL_FORMAT_DEPTH_1_MM)
    ir_modes = oni.sensor_modes(ONI_SENSOR_IR)
    imode = pick_mode(ir_modes, 640, 480, 30, ONI_PIXEL_FORMAT_GRAY16)

    results = {}

    print("\nA 只开深度（默认模式，%d 帧）" % FRAMES)
    results["A"] = report("A", run_depth(oni, None, label="A"))

    print("\nB 只开深度（显式 640x480@30 DEPTH_1_MM，%d 帧）" % FRAMES)
    results["B"] = report("B", run_depth(oni, dmode, label="B"))

    print("\nC 先开红外跑 10 帧再关，然后开深度")
    if imode:
        s = Stream(oni, ONI_SENSOR_IR, imode)
        for _ in range(10):
            s.read(2500)
        s.stop()
    results["C"] = report("C", run_depth(oni, dmode, label="C"))

    print("\nD 红外和深度同时开着")
    if not imode:
        results["D"] = 0
        print("  D        IR 模式不可用，跳过")
    else:
        irs = Stream(oni, ONI_SENSOR_IR, imode)
        results["D"] = report("D", run_depth(oni, dmode, label="D"))
        irs.stop()

    oni.shutdown()

    print("\n" + "=" * 60)
    best_name = max(results, key=lambda k: results[k])
    print("  汇总：" + "  ".join("%s=%.1f%%" % (k, results[k]) for k in sorted(results)))
    print("  最有效的开法：%s" % best_name)
    if results[best_name] < 1.0:
        print("  全都低于 1%%，深度基本没数据 —— 需要改 orbbec.ini 或检查硬件。")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
