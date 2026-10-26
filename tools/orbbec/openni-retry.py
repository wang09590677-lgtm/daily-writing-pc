# -*- coding: utf-8 -*-
"""
深度"全 0"的恢复测试：反复 关闭设备 → 重新打开 → 读深度，看第几次能恢复。

如果"重新打开设备"能恢复，桥接服务就照这个思路做自动恢复；
如果怎么重试都是 0，那就是硬件/USB 层面的问题，需要拔插或换口。
"""

import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from openni2bind import (OpenNI2, Stream, pick_mode, ascii_map,
                         ONI_SENSOR_DEPTH, ONI_PIXEL_FORMAT_DEPTH_1_MM)

ATTEMPTS = 5
FRAMES = 30


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


def main():
    ok = False
    for attempt in range(1, ATTEMPTS + 1):
        print("\n--- 第 %d 次尝试 ---" % attempt)
        oni = OpenNI2()
        if oni.initialize() != 0:
            print("  初始化失败：%s" % oni.err())
            time.sleep(2)
            continue
        dev = oni.open_first()
        if not dev:
            print("  打不开设备：%s" % oni.err())
            oni.shutdown()
            time.sleep(2)
            continue

        mode = pick_mode(oni.sensor_modes(ONI_SENSOR_DEPTH), 640, 480, 30,
                         ONI_PIXEL_FORMAT_DEPTH_1_MM)
        st = Stream(oni, ONI_SENSOR_DEPTH, mode)
        best = None
        nonzero = 0
        for _ in range(FRAMES):
            r = st.read(2500)
            if not r:
                continue
            buf, w, h, meta = r
            s = stats(buf)
            if s[0] > 0:
                nonzero += 1
            if best is None or s[0] > best[0][0]:
                best = (s, buf, w, h)
        st.stop()

        if best:
            s, buf, w, h = best
            print("  %d/%d 帧有数据，最好一帧 %.1f%%  最近 %dmm 最远 %dmm"
                  % (nonzero, FRAMES, 100.0 * s[0] / s[1], s[2], s[3]))
            if s[0] > 0:
                for line in ascii_map(buf, w, h, cols=44, rows=14):
                    print("      |%s|" % line)
                ok = True
        oni.shutdown()
        if ok:
            print("\n[OK] 第 %d 次尝试成功。" % attempt)
            break
        time.sleep(3)

    if not ok:
        print("\n" + "=" * 60)
        print("  重试 %d 次仍然全是 0。建议：" % ATTEMPTS)
        print("   1) 拔掉摄像头，换个 USB 口（优先电脑后置 / USB3.0）再插回去")
        print("   2) 确认镜头没有被遮挡、没有贴保护膜")
        print("   3) 重启一次电脑（驱动刚装好时偶尔需要）")
        print("   4) 若仍不行，用管理员跑 3-reset-device.bat 清掉设备节点重来")
        print("=" * 60)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
