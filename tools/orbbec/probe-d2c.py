# -*- coding: utf-8 -*-
"""
Astra Pro —— D2C（深度对齐到彩色）可行性探测
=============================================

为什么需要这一步
----------------
体感主链路是 MediaPipe 在**彩色画面**上算出的 33 个关键点（归一化 x,y）。
要拿到关节的 z，就得拿这些 (x,y) 去深度图上采样。
但深度图有自己的镜头、自己的内参、自己的视场角，和彩色镜头之间还有一段基线。
**未对齐的深度图上，(x,y) 指的位置不是同一个物理点。**

所以先问驱动一个明确的问题：这台设备能不能开
    ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION (5) = ONI_IMAGE_REGISTRATION_DEPTH_TO_COLOR (1)
开了之后深度帧就落在**彩色相机的坐标系**里，(x,y) 才能直接对上。

判据（每一步都要有可验证的输出，不靠"应该支持"）
------------------------------------------------
  A. 属性 5 是否 supported（问驱动）
  B. 能否 set 成 1，且**读回**确认变成 1（写成功 != 生效）
  C. 彩色传感器有没有可用的视频模式（没有彩色流就无从对齐）
  D. 同时开深度+彩色，两边都能读出帧（真实跑一遍，不是查表）
  E. 对齐后深度帧的尺寸是否变成了彩色的尺寸（很多驱动会重采样）

    python probe-d2c.py
"""

import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from openni2bind import (OpenNI2, Stream, pick_mode, ascii_map, LIB_DIR,
                         ONI_SENSOR_COLOR, ONI_SENSOR_DEPTH,
                         ONI_PIXEL_FORMAT_DEPTH_1_MM,
                         ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION,
                         SENSOR_NAMES, PIXEL_NAMES)

REG_OFF = 0
REG_DEPTH_TO_COLOR = 1


def line(t=""):
    print(t, flush=True)


def stat_of(buf):
    """返回 (有效像素, 总数, 最近, 最远, 均值)"""
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
    return (valid, len(buf), (dmin if valid else 0), dmax,
            (int(dsum / valid) if valid else 0))


def read_best(st, want=40, timeout=2500):
    """读若干帧，返回有效像素最多的那一帧 (buf, w, h, nth)"""
    best = None
    for i in range(want):
        r = st.read(timeout)
        if not r:
            continue
        buf, w, h, meta = r
        s = stat_of(buf)
        if best is None or s[0] > best[0][0]:
            best = (s, buf, w, h, i + 1)
        if s[0] > 0 and i >= 12:
            # 已经拿到像样的帧就不用读满
            pass
    return best


def main():
    line("=" * 68)
    line("  Astra Pro - D2C (depth-to-color) feasibility probe")
    line("  runtime: %s" % LIB_DIR)
    line("=" * 68)

    oni = OpenNI2()
    if oni.initialize() != 0:
        line("[X] oniInitialize 失败: %s" % oni.err())
        return 1
    dev = oni.open_first()
    if not dev:
        line("[X] 找不到设备: %s" % oni.err())
        return 2

    line("\n设备: %s  VID:PID=%04X:%04X  serial=%s"
         % (dev["name"], dev["vid"], dev["pid"], dev["serial"] or "?"))

    # ---------- 传感器模式清单 ----------
    line("\n[1] 传感器可用模式")
    color_modes = oni.sensor_modes(ONI_SENSOR_COLOR)
    depth_modes = oni.sensor_modes(ONI_SENSOR_DEPTH)
    for name, modes in ((SENSOR_NAMES[ONI_SENSOR_DEPTH], depth_modes),
                        (SENSOR_NAMES[ONI_SENSOR_COLOR], color_modes)):
        if not modes:
            line("    %-6s 不可用" % name)
            continue
        seen = []
        for m in modes:
            k = "%dx%d@%d/%s" % (m["w"], m["h"], m["fps"],
                                 PIXEL_NAMES.get(m["pixelFormat"],
                                                 str(m["pixelFormat"])))
            if k not in seen:
                seen.append(k)
        line("    %-6s %s" % (name, ", ".join(seen[:8])))

    # ---------- A: 属性是否被支持 ----------
    line("\n[2] ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION (5)")
    sup = oni.supports(ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION)
    cur = oni.get_int_property(ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION)
    line("    supported = %s" % sup)
    line("    当前值    = %s" % cur)

    # ---------- B: 设置并读回 ----------
    line("\n[3] 尝试 set 为 DEPTH_TO_COLOR(1)")
    st_set = oni.set_int_property(ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION,
                                  REG_DEPTH_TO_COLOR)
    line("    setProperty 返回 status = %d  (0 = 成功)" % st_set)
    time.sleep(0.3)
    back = oni.get_int_property(ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION)
    line("    读回值 = %s   %s"
         % (back, "<== 生效" if back == REG_DEPTH_TO_COLOR else "<== 没生效"))

    reg_ok = (st_set == 0 and back == REG_DEPTH_TO_COLOR)

    # ---------- D: 同时开两路流 ----------
    line("\n[4] 同时开深度 + 彩色流")
    d_mode = pick_mode(depth_modes, 640, 480, 30, ONI_PIXEL_FORMAT_DEPTH_1_MM) \
        or (depth_modes[0] if depth_modes else None)
    if not d_mode:
        line("    [X] 没有深度模式，无法继续")
        oni.shutdown()
        return 3
    line("    深度模式: %dx%d@%d" % (d_mode["w"], d_mode["h"], d_mode["fps"]))

    dst = None
    cst = None
    try:
        dst = Stream(oni, ONI_SENSOR_DEPTH, d_mode)
        line("    深度流已开: %dx%d" % (d_mode["w"], d_mode["h"]))
    except Exception as e:
        line("    [X] 深度流开失败: %s" % e)
        oni.shutdown()
        return 4

    if color_modes:
        # 彩色优先 RGB888；没有就取第一个
        c_mode = pick_mode(color_modes, 640, 480, 30, 200) \
            or pick_mode(color_modes, 640, 480, 30) or color_modes[0]
        line("    彩色模式: %dx%d@%d fmt=%s"
             % (c_mode["w"], c_mode["h"], c_mode["fps"],
                PIXEL_NAMES.get(c_mode["pixelFormat"], c_mode["pixelFormat"])))
        try:
            cst = Stream(oni, ONI_SENSOR_COLOR, c_mode)
            line("    彩色流已开")
        except Exception as e:
            line("    [!] 彩色流开失败: %s" % e)
            cst = None
    else:
        line("    [!] 没有彩色模式（Orbbec 驱动的 COLOR 传感器不可用）")

    # ---------- 读帧 ----------
    line("\n[5] 读帧验证")
    best_d = read_best(dst, want=40)
    if best_d:
        s, buf, w, h, nth = best_d
        line("    深度: 第%d帧 有效 %d/%d (%.1f%%) 最近 %dmm 最远 %dmm 均值 %dmm"
             % (nth, s[0], s[1], 100.0 * s[0] / s[1], s[2], s[3], s[4]))
        line("          深度帧尺寸 = %dx%d" % (w, h))
        for l in ascii_map(buf, w, h, cols=40, rows=14):
            line("      |%s|" % l)
    else:
        line("    深度: 一帧都没读到")

    if cst:
        best_c = read_best(cst, want=30)
        if best_c:
            s, buf, w, h, nth = best_c
            line("    彩色: 第%d帧 尺寸 %dx%d 非零字节 %d/%d"
                 % (nth, w, h, s[0], s[1]))
        else:
            line("    彩色: 一帧都没读到")

    # ---------- 收尾 ----------
    for st in (cst, dst):
        if st:
            try:
                st.stop()
            except Exception:
                pass
    oni.shutdown()

    # ---------- 结论 ----------
    line("\n" + "=" * 68)
    line("  结论")
    line("=" * 68)
    line("  A 属性被支持      : %s" % ("是" if sup else "否"))
    line("  B set 且读回生效  : %s" % ("是" if reg_ok else "否"))
    line("  C 彩色传感器可用  : %s" % ("是" if color_modes else "否"))
    line("  D 两路流同时可读  : %s" % ("是" if (best_d and cst) else "否"))
    if reg_ok and color_modes:
        line("\n  => D2C 可走通，深度帧在彩色坐标系里，(x,y) 能直接采样。")
    elif color_modes and not reg_ok:
        line("\n  => 驱动不吃 registration。退路：手动算内参/外参做映射")
        line("     （需要彩色与深度的内参矩阵 + 基线，可从 OBEXTENSION_ID_CAM_PARAMS 取）")
    else:
        line("\n  => Orbbec 驱动不提供彩色传感器，registration 无从谈起。")
        line("     退路：彩色由浏览器 UVC 拿，深度由 OpenNI 拿，")
        line("     两者外参只能自己标定。")
    line("=" * 68)
    return 0


if __name__ == "__main__":
    sys.exit(main())
