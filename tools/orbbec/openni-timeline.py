# -*- coding: utf-8 -*-
"""
深度稳定性时间序列：连续跑 N 秒，每秒打印一次这一秒里"有数据的帧占比"。

用来回答："深度是偶发出一帧，还是稳定每秒 30 帧都有？"
采样时每 8 个像素取 1 个，保证 Python 能跟上 30fps 不被自己拖慢。
"""

import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from openni2bind import (OpenNI2, Stream, pick_mode,
                         ONI_SENSOR_DEPTH, ONI_PIXEL_FORMAT_DEPTH_1_MM)

SECONDS = 12
STEP = 8


def valid_ratio(buf):
    # 每 STEP 个像素取一个做统计，够快也够准
    total = 0
    valid = 0
    for v in buf[::STEP]:
        total += 1
        if v > 0:
            valid += 1
    return (100.0 * valid / total) if total else 0.0


def main():
    seconds = SECONDS
    if len(sys.argv) > 1:
        try:
            seconds = int(sys.argv[1])
        except ValueError:
            pass

    oni = OpenNI2()
    if oni.initialize() != 0:
        print("[X] 初始化失败：%s" % oni.err())
        return 1
    dev = oni.open_first()
    if not dev:
        print("[X] 无设备：%s" % oni.err())
        return 2

    mode = pick_mode(oni.sensor_modes(ONI_SENSOR_DEPTH), 640, 480, 30,
                     ONI_PIXEL_FORMAT_DEPTH_1_MM)
    st = Stream(oni, ONI_SENSOR_DEPTH, mode)

    print("连续跑 %d 秒，每秒一行（fps=这一秒读到的帧数，ok=有深度数据的帧数）" % seconds)
    print("-" * 62)
    overall_ok = 0
    overall_frames = 0
    for sec in range(seconds):
        t_end = time.time() + 1.0
        frames = 0
        ok = 0
        best = 0.0
        while time.time() < t_end:
            r = st.read(500)
            if not r:
                continue
            buf, w, h, meta = r
            frames += 1
            ratio = valid_ratio(buf)
            if ratio > 0:
                ok += 1
            if ratio > best:
                best = ratio
        overall_frames += frames
        overall_ok += ok
        bar = "#" * int(best / 5) if best else ""
        print("  第 %2d 秒: fps=%2d  有数据=%2d  最好帧有效=%5.1f%%  %s"
              % (sec + 1, frames, ok, best, bar))
    st.stop()
    oni.shutdown()

    print("-" * 62)
    if overall_frames == 0:
        print("  一帧都没读到。")
        return 3
    pct = 100.0 * overall_ok / overall_frames
    print("  总计 %d/%d 帧有深度数据 (%.1f%%)" % (overall_ok, overall_frames, pct))
    if pct > 80:
        print("  深度稳定 ✅")
    elif pct > 20:
        print("  深度断断续续 ⚠️  —— 桥接服务必须做自动恢复（连续空帧就重开设备）")
    else:
        print("  深度基本不可用 ❌ —— 先拔插摄像头 / 换 USB 口，再跑一次")
    return 0


if __name__ == "__main__":
    sys.exit(main())
