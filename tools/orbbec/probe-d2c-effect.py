# -*- coding: utf-8 -*-
"""
Astra Pro —— registration 到底有没有真的改变深度画面
==================================================

上一支探针发现：
    无流时 set registration -> status=4 (BAD_PARAMETER)
    深度流运行中 set        -> status=0，读回 = 1

但"读回 1"有可能只是驱动在回显我们写进去的值，实际没做任何处理。
**这一步就是来证伪的**：开/关两态各抓一批帧，逐字节比。

判据
----
  两态帧**逐字节相同**  => registration 是空操作，读回 1 是假的 => 此路不通
  两态帧**有结构性差异** => 真做了重映射 => 继续验证"映射到的是不是彩色坐标系"

顺带
----
  * 也测一次"设完 registration 后重启深度流"，看是否要重启才生效
  * 用 cv2 抓一张 UVC 彩色帧存下来（后面做对齐要用）
  * 存 PNG 到 build/shots/，便于人眼复核（R7）

    python probe-d2c-effect.py
"""

import sys
import os
import ctypes
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from openni2bind import (OpenNI2, Stream, pick_mode, LIB_DIR,
                         ONI_SENSOR_DEPTH, ONI_PIXEL_FORMAT_DEPTH_1_MM,
                         ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION)

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.normpath(os.path.join(HERE, "..", "..", "build", "shots"))
REG = ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION


def line(t=""):
    print(t, flush=True)


def frames_to_np(buf, w, h):
    a = np.frombuffer(bytes(buf), dtype="<u2")
    if a.size != w * h:
        return None
    return a.reshape(h, w).astype(np.uint16)


def grab(st, want=25, timeout=2000):
    """抓 want 帧，返回 (最优帧 ndarray, 有数据帧数, 尺寸)"""
    best = None
    ok = 0
    wh = None
    for _ in range(want):
        r = st.read(timeout)
        if not r:
            continue
        buf, w, h, meta = r
        img = frames_to_np(buf, w, h)
        if img is None:
            continue
        wh = (w, h)
        nz = int(np.count_nonzero(img))
        if nz:
            ok += 1
        if best is None or nz > int(np.count_nonzero(best)):
            best = img
    return best, ok, wh


def geo_stats(img):
    """几何摘要：有效区域 bbox / 最近点位置 / 近处团块的质心"""
    if img is None:
        return None
    valid = img > 0
    nz = int(valid.sum())
    if not nz:
        return {"valid": 0}
    ys, xs = np.nonzero(valid)
    near = int(img[valid].min())
    far = int(img[valid].max())
    # 取最近 15% 深度范围内的像素当"近处团块"
    thr = near + 0.15 * (far - near)
    m = valid & (img <= thr)
    if m.any():
        yy, xx = np.nonzero(m)
        cx, cy = float(xx.mean()), float(yy.mean())
    else:
        cx = cy = 0.0
    return {
        "valid": nz,
        "validRatio": round(nz / float(img.size), 4),
        "bbox": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
        "nearMM": near,
        "farMM": far,
        "meanMM": int(img[valid].mean()),
        "nearBlobCentroid": [round(cx, 1), round(cy, 1)],
        "nearBlobPx": int(m.sum()),
    }


def save_png(img, path):
    try:
        import cv2
    except ImportError:
        return False
    if img is None:
        return False
    v = img.astype(np.float32)
    m = v > 0
    if not m.any():
        return False
    lo, hi = float(v[m].min()), float(v[m].max())
    norm = np.zeros_like(v)
    norm[m] = 255.0 * (1.0 - (v[m] - lo) / max(1.0, hi - lo))   # 近 = 亮
    return bool(cv2.imwrite(path, norm.astype(np.uint8)))


def main():
    os.makedirs(SHOTS, exist_ok=True)
    line("=" * 68)
    line("  registration 是否真的改变了深度画面")
    line("=" * 68)

    oni = OpenNI2()
    if oni.initialize() != 0:
        line("[X] init 失败: %s" % oni.err())
        return 1
    dev = oni.open_first()
    if not dev:
        line("[X] 无设备")
        return 2

    d_modes = oni.sensor_modes(ONI_SENSOR_DEPTH)
    d_mode = pick_mode(d_modes, 640, 480, 30, ONI_PIXEL_FORMAT_DEPTH_1_MM) or d_modes[0]

    # ---------- 状态 OFF ----------
    line("\n[A] registration = OFF")
    st = Stream(oni, ONI_SENSOR_DEPTH, d_mode)
    time.sleep(0.8)
    img_off, ok_off, wh = grab(st, want=30)
    g_off = geo_stats(img_off)
    line("    抓帧 %d 帧有数据，尺寸 %s" % (ok_off, wh))
    line("    %s" % g_off)
    save_png(img_off, os.path.join(SHOTS, "d2c-off.png"))

    # ---------- 设 ON（流仍在跑）----------
    line("\n[B] 流运行中 set registration = 1")
    s = oni.set_int_property(REG, 1)
    time.sleep(0.4)
    back = oni.get_int_property(REG)
    line("    status=%d readback=%s" % (s, back))
    time.sleep(1.0)
    img_on, ok_on, wh2 = grab(st, want=30)
    g_on = geo_stats(img_on)
    line("    抓帧 %d 帧有数据，尺寸 %s" % (ok_on, wh2))
    line("    %s" % g_on)
    save_png(img_on, os.path.join(SHOTS, "d2c-on-norestart.png"))

    # ---------- 重启流后再抓 ----------
    line("\n[C] 停止并重启深度流，再抓（有些驱动要重启才生效）")
    st.stop()
    time.sleep(0.5)
    st2 = Stream(oni, ONI_SENSOR_DEPTH, d_mode)
    time.sleep(0.8)
    img_rs, ok_rs, wh3 = grab(st2, want=30)
    g_rs = geo_stats(img_rs)
    line("    抓帧 %d 帧有数据，尺寸 %s" % (ok_rs, wh3))
    line("    %s" % g_rs)
    save_png(img_rs, os.path.join(SHOTS, "d2c-on-restart.png"))

    for x in (st2,):
        try:
            x.stop()
        except Exception:
            pass
    oni.shutdown()

    # ---------- 逐字节比对 ----------
    line("\n[D] 比对")
    pairs = [("OFF vs ON(不重启)", img_off, img_on),
             ("OFF vs ON(重启后)", img_off, img_rs),
             ("ON(不重启) vs ON(重启后)", img_on, img_rs)]
    for name, a, b in pairs:
        if a is None or b is None:
            line("    %-26s 有帧缺失，跳过" % name)
            continue
        if a.shape != b.shape:
            line("    %-26s 尺寸不同 %s vs %s" % (name, a.shape, b.shape))
            continue
        same = np.array_equal(a, b)
        diff = np.abs(a.astype(np.int32) - b.astype(np.int32))
        both = (a > 0) & (b > 0)
        md = float(diff[both].mean()) if both.any() else -1
        changed = int((diff > 0).sum())
        line("    %-26s 逐字节相同=%-5s 变化像素=%d/%d  共同有效区平均|Δ|=%s mm"
             % (name, same, changed, a.size,
                ("%.1f" % md) if md >= 0 else "n/a"))

    # ---------- 顺带抓一张 UVC 彩色 ----------
    line("\n[E] 用 cv2 抓 UVC 彩色帧（浏览器看到的就是它）")
    try:
        import cv2
        cap = None
        found = None
        for idx in range(4):
            c = cv2.VideoCapture(idx, cv2.CAP_DSHOW)
            if not c.isOpened():
                c.release()
                continue
            c.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            c.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            ok, f = c.read()
            if ok and f is not None:
                found = (idx, f)
                c.release()
                break
            c.release()
        if found:
            idx, f = found
            p = os.path.join(SHOTS, "uvc-color.png")
            cv2.imwrite(p, f)
            line("    彩色已抓到 idx=%d 尺寸=%s -> %s" % (idx, f.shape, p))
        else:
            line("    [!] cv2 打不开任何彩色设备（可能被别的进程占用）")
    except ImportError:
        line("    [!] 没有 cv2")

    line("\n" + "=" * 68)
    if img_off is not None and img_rs is not None and img_off.shape == img_rs.shape:
        if np.array_equal(img_off, img_rs):
            line("  结论：OFF 与 ON 逐字节相同 => registration 是空操作，读回 1 不可信。")
            line("        需要走自算映射（但本机 CAM_PARAMS 是 NaN，得另外标定）。")
        else:
            line("  结论：ON 改变了深度画面 => registration 真的做了重映射。")
            line("        下一步：验证映射目标是浏览器 UVC 彩色坐标系。")
    line("=" * 68)
    return 0


if __name__ == "__main__":
    sys.exit(main())
