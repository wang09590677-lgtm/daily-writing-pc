# -*- coding: utf-8 -*-
"""
Astra Pro —— 取内参/外参 + registration 生效时机穷举
=====================================================

两个问题
--------
Q1  OBEXTENSION_ID_CAM_PARAMS(14) 能不能读出 OBCameraParams？
    能读 => 不需要 D2C 也能自己做映射（有彩色内参、深度内参、彩色->深度 的 R/t）。
Q2  IMAGE_REGISTRATION(5) 到底在什么时机设才生效？
    OpenNI2 里有些驱动的 registration 必须在**流已创建但未启动**时设。
    依次试 4 种时机，看哪个能读回 1。

OBCameraParams（照抄 OniCTypes.h:87）
------------------------------------
    float l_intr_p[4];  // 深度 [fx,fy,cx,cy]
    float r_intr_p[4];  // 彩色 [fx,fy,cx,cy]
    float r2l_r[9];     // 彩色 -> 深度 旋转 (行优先)
    float r2l_t[3];     // 彩色 -> 深度 平移 (mm)
    float l_k[5];       // 深度畸变 [k1,k2,p1,p2,k3]
    float r_k[5];       // 彩色畸变
  合计 30 个 float = 120 字节

    python probe-camparams.py
"""

import sys
import os
import ctypes
import struct
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from openni2bind import (OpenNI2, Stream, pick_mode, LIB_DIR,
                         ONI_SENSOR_COLOR, ONI_SENSOR_DEPTH,
                         ONI_PIXEL_FORMAT_DEPTH_1_MM,
                         ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION)

CAM_PARAMS = 14
DEVICETYPE = 17
SERIALNUMBER = 16
LASER_EN = 15
LDP_EN = 13

REG_OFF = 0
REG_D2C = 1


def line(t=""):
    print(t, flush=True)


def get_raw_property(oni, prop_id, size):
    """按给定字节数读原始属性，返回 (status, bytes)"""
    buf = ctypes.create_string_buffer(size)
    n = ctypes.c_int(size)
    st = oni.lib.oniDeviceGetProperty(oni.dev, prop_id, buf, ctypes.byref(n))
    return st, bytes(buf.raw[:size]), n.value


def parse_cam_params(raw):
    """30 个 float，按 OBCameraParams 布局拆"""
    if len(raw) < 120:
        return None
    f = struct.unpack("<30f", raw[:120])
    return {
        "l_intr": list(f[0:4]),     # 深度 fx,fy,cx,cy
        "r_intr": list(f[4:8]),     # 彩色 fx,fy,cx,cy
        "r2l_r": list(f[8:17]),
        "r2l_t": list(f[17:20]),
        "l_k": list(f[20:25]),
        "r_k": list(f[25:30]),
    }


def fov_from_intr(intr, w, h):
    """由 fx,fy 反推视场角（度）"""
    import math
    fx, fy = intr[0], intr[1]
    if fx <= 0 or fy <= 0:
        return None, None
    return (2 * math.degrees(math.atan(w / (2.0 * fx))),
            2 * math.degrees(math.atan(h / (2.0 * fy))))


def try_registration(oni, label, before=None, after=None):
    """在指定时机设 registration，返回 (status, readback)"""
    if before:
        before()
    st = oni.set_int_property(ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION, REG_D2C)
    time.sleep(0.2)
    back = oni.get_int_property(ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION)
    if after:
        after()
    return st, back


def main():
    line("=" * 68)
    line("  Astra Pro - CAM_PARAMS + registration timing")
    line("=" * 68)

    oni = OpenNI2()
    if oni.initialize() != 0:
        line("[X] init 失败: %s" % oni.err())
        return 1
    dev = oni.open_first()
    if not dev:
        line("[X] 无设备: %s" % oni.err())
        return 2
    line("\n设备 %s  VID:PID=%04X:%04X" % (dev["name"], dev["vid"], dev["pid"]))

    # ---------- Q1: 内参/外参 ----------
    line("\n[Q1] OBEXTENSION_ID_CAM_PARAMS (14)")
    line("    supports = %s" % oni.supports(CAM_PARAMS))
    got = None
    for size in (120, 128, 256, 512):
        st, raw, n = get_raw_property(oni, CAM_PARAMS, size)
        line("    请求 %4d 字节 -> status=%d  实际 %d 字节" % (size, st, n))
        if st == 0 and n >= 120:
            got = parse_cam_params(raw)
            if got:
                break

    if got:
        line("\n    深度内参 l_intr  fx=%.2f fy=%.2f cx=%.2f cy=%.2f"
             % tuple(got["l_intr"]))
        line("    彩色内参 r_intr  fx=%.2f fy=%.2f cx=%.2f cy=%.2f"
             % tuple(got["r_intr"]))
        line("    彩色->深度 t = [%.2f, %.2f, %.2f]  (单位应为 mm)"
             % tuple(got["r2l_t"]))
        line("    彩色->深度 R =")
        R = got["r2l_r"]
        for i in range(3):
            line("        [%9.5f %9.5f %9.5f]" % (R[3 * i], R[3 * i + 1], R[3 * i + 2]))
        line("    深度畸变 l_k = %s" % ["%.5f" % v for v in got["l_k"]])
        line("    彩色畸变 r_k = %s" % ["%.5f" % v for v in got["r_k"]])
        hf, vf = fov_from_intr(got["l_intr"], 640, 480)
        line("    => 深度 FOV  %.1f° x %.1f°  (@640x480)" % (hf, vf))
        hf, vf = fov_from_intr(got["r_intr"], 640, 480)
        line("    => 彩色 FOV  %.1f° x %.1f°  (@640x480)" % (hf, vf))
        line("    => 基线 |t| = %.1f mm"
             % (sum(v * v for v in got["r2l_t"]) ** 0.5))
    else:
        line("    [!] 读不出 CAM_PARAMS")

    # 顺带看看 device type / serial 扩展
    for pid, nm in ((DEVICETYPE, "DEVICETYPE"), (SERIALNUMBER, "SERIALNUMBER"),
                    (LASER_EN, "LASER_EN"), (LDP_EN, "LDP_EN")):
        st, raw, n = get_raw_property(oni, pid, 64)
        line("    %-13s status=%d n=%d  raw=%s"
             % (nm, st, n, raw[:16].hex() if st == 0 else "-"))

    # ---------- Q2: registration 时机 ----------
    line("\n[Q2] IMAGE_REGISTRATION 生效时机穷举")
    d_modes = oni.sensor_modes(ONI_SENSOR_DEPTH)
    c_modes = oni.sensor_modes(ONI_SENSOR_COLOR)
    d_mode = pick_mode(d_modes, 640, 480, 30, ONI_PIXEL_FORMAT_DEPTH_1_MM) or d_modes[0]
    c_mode = pick_mode(c_modes, 640, 480, 30, 200) or (c_modes[0] if c_modes else None)

    results = []

    # (a) 无任何流
    st, back = try_registration(oni, "无流")
    results.append(("(a) 没有任何流时", st, back))
    line("    (a) 无流            : status=%d readback=%s" % (st, back))

    # (b) 深度流已建已启
    dst = None
    try:
        dst = Stream(oni, ONI_SENSOR_DEPTH, d_mode)
        st, back = try_registration(oni, "深度流运行中")
        results.append(("(b) 深度流运行中", st, back))
        line("    (b) 深度流运行中    : status=%d readback=%s" % (st, back))
    except Exception as e:
        line("    (b) 深度流开失败: %s" % e)

    # (c) 再叠彩色流
    cst = None
    if c_mode:
        try:
            cst = Stream(oni, ONI_SENSOR_COLOR, c_mode)
            st, back = try_registration(oni, "深度+彩色流运行中")
            results.append(("(c) 深度+彩色运行中", st, back))
            line("    (c) 深度+彩色运行中: status=%d readback=%s" % (st, back))
        except Exception as e:
            line("    (c) 彩色流开失败: %s" % e)
    else:
        line("    (c) 无彩色模式，跳过")

    # (d) 彩色单独读帧（验证 OpenNI 的彩色到底出不出帧）
    line("\n[Q2b] 彩色流单独读帧（OpenNI 的 COLOR 是真能出帧，还是只是声明了）")
    if cst is not None:
        got_frames = 0
        for i in range(30):
            r = cst.read(1200)
            if r:
                got_frames += 1
                if got_frames == 1:
                    buf, w, h, meta = r
                    line("    首帧: %dx%d fmt=%s stride=%d"
                         % (w, h, meta.get("fmt"), meta.get("stride")))
        line("    30 次读尝试里拿到 %d 帧" % got_frames)
    else:
        line("    彩色流没建起来")

    # 收尾
    for st_ in (cst, dst):
        if st_:
            try:
                st_.stop()
            except Exception:
                pass
    oni.shutdown()

    # ---------- 结论 ----------
    line("\n" + "=" * 68)
    line("  结论")
    line("=" * 68)
    line("  CAM_PARAMS 可读   : %s" % ("是" if got else "否"))
    ok_timing = [r for r in results if r[2] == REG_D2C]
    if ok_timing:
        line("  registration 生效 : 是，时机 = %s" % ok_timing[0][0])
    else:
        line("  registration 生效 : 否（四种时机全试过）")
        if got:
            line("  => 走自算映射：用 r_intr/l_intr + r2l_R/t 把彩色像素投到深度图采样。")
        else:
            line("  => 内参也读不出，需要另外标定。")
    line("=" * 68)
    return 0


if __name__ == "__main__":
    sys.exit(main())
