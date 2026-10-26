# -*- coding: utf-8 -*-
"""
激光投影器（LDP / LASER）开关测试

症状：深度流稳定 30fps，但几乎每一帧的深度值都是 0。
      = 相机收到的是"没被照亮的画面"，算不出视差。

Astra 是结构光相机，靠一颗红外散斑投影器照明。官方 ExtendedAPI 样例里
切换 LDP 的做法是：先 stop 掉 depth/IR 流 → setProperty → 再 start。
而且 oniDeviceIsPropertySupported 对这个属性会返回 False（驱动没实现查询），
所以不能"先看支持再设"，要直接盲设。

用法：python openni-laser.py
"""

import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from openni2bind import (OpenNI2, Stream, pick_mode, ascii_map,
                         ONI_SENSOR_DEPTH, ONI_PIXEL_FORMAT_DEPTH_1_MM)

LDP_PROPS = [
    ("OBEXTENSION_ID_LDP_EN", 13),
    ("OBEXTENSION_ID_LASER_EN", 15),
    ("XN_MODULE_PROPERTY_LDP_ENABLE", 0x1080FFBE),
]
STEP = 8


def valid_ratio(buf):
    total = valid = 0
    for v in buf[::STEP]:
        total += 1
        if v > 0:
            valid += 1
    return (100.0 * valid / total) if total else 0.0


def measure(oni, mode, seconds, tag):
    st = Stream(oni, ONI_SENSOR_DEPTH, mode)
    frames = ok = 0
    best = 0.0
    best_buf = None
    t_end = time.time() + seconds
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
            best, best_buf, bw, bh = ratio, buf, w, h
    st.stop()
    print("  [%s] %.0f 秒：%d 帧，其中 %d 帧有深度，最好一帧 %.1f%%"
          % (tag, seconds, frames, ok, best))
    if best_buf is not None and best > 0:
        for line in ascii_map(best_buf, bw, bh, cols=44, rows=12):
            print("       |%s|" % line)
    return ok


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

    mode = pick_mode(oni.sensor_modes(ONI_SENSOR_DEPTH), 640, 480, 30,
                     ONI_PIXEL_FORMAT_DEPTH_1_MM)

    print("\n[1] 基线（还没碰激光开关）：")
    base_ok = measure(oni, mode, 4, "基线")

    print("\n[2] 读取激光相关属性（盲读，不看 supports）：")
    # 注意：样例要求在改 LDP 前把流停掉，这里此刻没有流在跑
    for name, pid in LDP_PROPS:
        v = oni.get_int_property(pid)
        print("     %-32s = %s" % (name, v))

    print("\n[3] 把激光全部设成 1（开）：")
    for name, pid in LDP_PROPS:
        rc = oni.set_int_property(pid, 1)
        after = oni.get_int_property(pid)
        print("     %-32s set→rc=%d  读回=%s" % (name, rc, after))

    print("\n[4] 开完之后再测：")
    after_ok = measure(oni, mode, 8, "开激光后")

    oni.shutdown()

    print("\n" + "=" * 60)
    if after_ok > base_ok:
        print("  开激光之后明显变好 ✅  基线 %d 帧 → 现在 %d 帧有深度" % (base_ok, after_ok))
        print("  把这个设置固化：在 openni2bind / 桥接服务里启动后先 set 一次。")
    elif after_ok > 0:
        print("  开激光前后都有数据（基线 %d → 现在 %d）。" % (base_ok, after_ok))
    else:
        print("  开着激光也几乎没有深度（基线 %d → 现在 %d）。" % (base_ok, after_ok))
        print("  下一步：拔插摄像头 / 换 USB 口，或确认镜头没被遮挡。")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
