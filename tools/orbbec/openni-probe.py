# -*- coding: utf-8 -*-
"""
ORBBEC Astra Pro —— OpenNI2 深度探测

确认深度流真的在出数据。会自动用 tools/orbbec/runtime 里那份调过的 orbbec.ini。

    python openni-probe.py            # 默认抓 60 帧
    python openni-probe.py 150        # 抓 150 帧（约 5 秒）

输出：每一帧的有效像素比例，以及**最好的那一帧**的 ASCII 深度图。
（Astra 刚启动的头若干帧可能是空的，所以看"最好帧"比看"最后一帧"靠谱。）
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from openni2bind import (OpenNI2, Stream, pick_mode, ascii_map, LIB_DIR,
                         ONI_SENSOR_DEPTH, ONI_PIXEL_FORMAT_DEPTH_1_MM,
                         ONI_DEVICE_PROPERTY_FIRMWARE_VERSION,
                         SENSOR_NAMES, PIXEL_NAMES)


def stats(buf):
    valid = 0
    dmin, dmax, dsum = 65535, 0, 0
    for v in buf:
        if v > 0:
            valid += 1
            dsum += v
            if v < dmin:
                dmin = v
            if v > dmax:
                dmax = v
    return valid, len(buf), (dmin if valid else 0), dmax, (int(dsum / valid) if valid else 0)


def main():
    want = 60
    if len(sys.argv) > 1:
        try:
            want = int(sys.argv[1])
        except ValueError:
            pass

    print("=" * 64)
    print("  ORBBEC Astra Pro - OpenNI2 depth probe")
    print("  运行时目录: %s" % LIB_DIR)
    print("  提示: 想改深度范围/USB 传输方式，编辑 runtime/OpenNI2/Drivers/orbbec.ini")
    print("=" * 64)

    oni = OpenNI2()
    if oni.initialize() != 0:
        print("[X] 初始化失败：%s" % oni.err())
        return 1

    dev = oni.open_first()
    if not dev:
        print("[X] 找不到设备：%s" % oni.err())
        return 2

    print("\n设备: %s  vendor=%s  VID:PID=%04X:%04X"
          % (dev["name"], dev["vendor"], dev["vid"], dev["pid"]))
    print("固件: %s" % (oni.get_string_property(ONI_DEVICE_PROPERTY_FIRMWARE_VERSION) or "?"))

    print("\n传感器模式：")
    for sensor in (ONI_SENSOR_DEPTH, 2, 1):  # DEPTH / COLOR / IR
        modes = oni.sensor_modes(sensor)
        if not modes:
            print("  %-6s 不可用" % SENSOR_NAMES[sensor])
            continue
        seen = []
        for m in modes:
            key = "%dx%d@%d" % (m["w"], m["h"], m["fps"])
            if key not in seen:
                seen.append(key)
        print("  %-6s %s" % (SENSOR_NAMES[sensor], ", ".join(seen)))

    mode = pick_mode(oni.sensor_modes(ONI_SENSOR_DEPTH), 640, 480, 30,
                     ONI_PIXEL_FORMAT_DEPTH_1_MM)
    st = Stream(oni, ONI_SENSOR_DEPTH, mode)

    print("\n抓 %d 帧（约 %d 秒）..." % (want, want // 30 + 1))
    best = None
    nonzero = 0
    for i in range(want):
        r = st.read(2500)
        if not r:
            continue
        buf, w, h, meta = r
        s = stats(buf)
        if s[0] > 0:
            nonzero += 1
        if best is None or s[0] > best[0][0]:
            best = (s, buf, w, h, i + 1)

    st.stop()
    oni.shutdown()

    print("\n共 %d/%d 帧有深度数据" % (nonzero, want))
    if not best or best[0][0] == 0:
        print("[X] 全程都是 0。检查：镜头有没有遮挡 / 目标是不是在 0.6-8 米内 / 换个 USB 口")
        return 3

    s, buf, w, h, nth = best
    print("最好的是第 %d 帧：有效像素 %d/%d (%.1f%%) 最近 %dmm 最远 %dmm 均值 %dmm"
          % (nth, s[0], s[1], 100.0 * s[0] / s[1], s[2], s[3], s[4]))
    print("\nASCII 深度图（字符越密 = 离摄像头越近，空格 = 无数据）：")
    for line in ascii_map(buf, w, h, cols=44, rows=16):
        print("  |%s|" % line)
    print("\n结论：深度数据正常 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
