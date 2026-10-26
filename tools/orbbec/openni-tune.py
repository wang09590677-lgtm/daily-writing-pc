# -*- coding: utf-8 -*-
"""
Astra Pro 深度"全 0"排查脚本

现象：深度流能出帧，但每个像素都是 0。
原因基本只有几个：
  1. 激光散斑投影器（LDP / LASER）没开 —— 结构光相机靠它照明，最常见
  2. 红外曝光/增益不对，接收端看不到散斑
  3. orbbec.ini 里 UsbInterface 选错（Windows 默认 ISO=1，包里写的是 BULK=2）
  4. 目标离得太近（< 0.6 m）或太远（> 8 m）

这个脚本按顺序试一遍：先看红外有没有图像，再逐个开关激光属性，
每改一次就重新开一次深度流，把有效像素比例打出来，最后给出结论。
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from openni2bind import (OpenNI2, Stream, pick_mode, ascii_map, ascii_map_gray,
                         ONI_SENSOR_DEPTH, ONI_SENSOR_IR,
                         ONI_PIXEL_FORMAT_DEPTH_1_MM, ONI_PIXEL_FORMAT_GRAY16,
                         ONI_DEVICE_PROPERTY_FIRMWARE_VERSION,
                         OBEXTENSION_ID_IR_GAIN, OBEXTENSION_ID_IR_EXP,
                         OBEXTENSION_ID_LDP_EN, OBEXTENSION_ID_LASER_EN,
                         OBEXTENSION_ID_DEVICETYPE)


def stats(buf):
    n = len(buf)
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
    return valid, n, (dmin if valid else 0), dmax, (int(dsum / valid) if valid else 0)


def gray_stats(buf):
    n = len(buf)
    gmin, gmax, gsum = 65535, 0, 0
    for v in buf:
        gsum += v
        if v < gmin:
            gmin = v
        if v > gmax:
            gmax = v
    return gmin, gmax, int(gsum / n)


def read_depth(oni, mode, frames=12):
    """开一次深度流，读若干帧，返回最好的一帧"""
    st = Stream(oni, ONI_SENSOR_DEPTH, mode)
    best = None
    got = 0
    try:
        for _ in range(frames):
            r = st.read(2500)
            if not r:
                continue
            buf, w, h, meta = r
            got += 1
            s = stats(buf)
            if best is None or s[0] > best[0][0]:
                best = (s, buf, w, h)
    finally:
        st.stop()
    return best, got


def main():
    oni = OpenNI2()
    if oni.initialize() != 0:
        print("[X] OpenNI2 初始化失败：%s" % oni.err())
        return 1

    dev = oni.open_first()
    if not dev:
        print("[X] 没有可用设备：%s" % oni.err())
        return 2

    print("=" * 64)
    print("  设备: %s  固件: %s" % (dev["name"], oni.get_string_property(
        ONI_DEVICE_PROPERTY_FIRMWARE_VERSION) or "?"))
    print("=" * 64)

    # ---- 1. 先看红外：红外全黑 = 传感器根本没收到光 ----
    print("\n[1] 红外流检查（红外全黑说明接收端没光，问题在投影或曝光）")
    ir_modes = oni.sensor_modes(ONI_SENSOR_IR)
    ir_mode = pick_mode(ir_modes, 640, 480, 30, ONI_PIXEL_FORMAT_GRAY16)
    ir_best = None
    if ir_mode:
        st = Stream(oni, ONI_SENSOR_IR, ir_mode)
        for _ in range(8):
            r = st.read(2500)
            if not r:
                continue
            buf, w, h, meta = r
            g = gray_stats(buf)
            if ir_best is None or g[2] > ir_best[0][2]:
                ir_best = (g, buf, w, h)
        st.stop()
    if ir_best:
        g, buf, w, h = ir_best
        print("   IR %dx%d  最小 %d / 最大 %d / 平均 %d" % (w, h, g[0], g[1], g[2]))
        for line in ascii_map_gray(buf, w, h, scale=max(1, g[1])):
            print("   |%s|" % line)
        if g[1] < 20:
            print("   >>> 红外几乎全黑：激光投影器很可能没开，或者被挡住了")
    else:
        print("   IR 流读不到帧")

    # ---- 2. 打印并逐个尝试激光相关属性 ----
    print("\n[2] 激光 / 红外相关属性")
    laser_props = [
        ("LDP_EN (激光散斑投影)", OBEXTENSION_ID_LDP_EN),
        ("LASER_EN (激光器)", OBEXTENSION_ID_LASER_EN),
        ("IR_GAIN (红外增益)", OBEXTENSION_ID_IR_GAIN),
        ("IR_EXP  (红外曝光)", OBEXTENSION_ID_IR_EXP),
        ("DEVICETYPE", OBEXTENSION_ID_DEVICETYPE),
    ]
    for name, pid in laser_props:
        supported = oni.supports(pid)
        cur = oni.get_int_property(pid) if supported else None
        print("   %-24s 支持=%-5s 当前=%s" % (name, supported, cur))

    depth_modes = oni.sensor_modes(ONI_SENSOR_DEPTH)
    depth_mode = pick_mode(depth_modes, 640, 480, 30, ONI_PIXEL_FORMAT_DEPTH_1_MM)

    print("\n[3] 基线：什么都不改，读深度")
    best, got = read_depth(oni, depth_mode)
    if best:
        s, buf, w, h = best
        print("   读到 %d 帧，最好一帧有效像素 %d/%d (%.1f%%) 最近 %dmm 最远 %dmm"
              % (got, s[0], s[1], 100.0 * s[0] / s[1], s[2], s[3]))
    base_valid = best[0][0] if best else 0

    # ---- 4. 逐个把激光属性设成 1 再试 ----
    for name, pid in [("LDP_EN", OBEXTENSION_ID_LDP_EN), ("LASER_EN", OBEXTENSION_ID_LASER_EN)]:
        if not oni.supports(pid):
            print("\n[4] %s 不支持，跳过" % name)
            continue
        st_code = oni.set_int_property(pid, 1)
        after = oni.get_int_property(pid)
        print("\n[4] 把 %s 设成 1 → 返回 %d，读回 %s" % (name, st_code, after))
        best, got = read_depth(oni, depth_mode)
        if best:
            s, buf, w, h = best
            print("   有效像素 %d/%d (%.1f%%) 最近 %dmm 最远 %dmm 均值 %dmm"
                  % (s[0], s[1], 100.0 * s[0] / s[1], s[2], s[3], s[4]))
            if s[0] > base_valid:
                print("   >>> 有改善！打印这一帧：")
                for line in ascii_map(buf, w, h):
                    print("   |%s|" % line)
        else:
            print("   还是读不到帧")

    # ---- 5. 红外曝光/增益 ----
    print("\n[5] 红外曝光 / 增益")
    for name, pid, val in [("IR_GAIN=1(自动?)", OBEXTENSION_ID_IR_GAIN, 1),
                           ("IR_EXP=1", OBEXTENSION_ID_IR_EXP, 1)]:
        if not oni.supports(pid):
            continue
        code = oni.set_int_property(pid, val)
        best, got = read_depth(oni, depth_mode)
        if best:
            s = best[0]
            print("   %s → 返回 %d，有效像素 %.1f%%"
                  % (name, code, 100.0 * s[0] / s[1]))

    oni.shutdown()

    print("\n" + "=" * 64)
    if base_valid > 0:
        print("  基线就有深度数据，说明相机本身是好的。")
    else:
        print("  基线全 0。若上面第 4 步也没改善，下一步：")
        print("   1) 确认摄像头没被遮挡、镜头前没有贴膜")
        print("   2) 站到 1.5 - 3 米远再试（Astra 有效范围约 0.6 - 8 米）")
        print("   3) 改 orbbec.ini：把 UsbInterface 从 2(BULK) 改成 1(ISO) 再跑一次")
        print("      文件：tools/openni/.../Win64-Release/sdk/libs/OpenNI2/Drivers/orbbec.ini")
        print("   4) 换一个 USB 口 / 直接插电脑，别经过集线器")
    print("=" * 64)
    return 0


if __name__ == "__main__":
    sys.exit(main())
