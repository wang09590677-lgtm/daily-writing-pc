# -*- coding: utf-8 -*-
"""
Astra Pro —— registration 对齐目标是不是彩色相机（定量互相关）
============================================================

思路
----
深度图里的"物体边界"和彩色图里的"亮度边界"在同一物理边缘上会重合。
把两者各自压成一维剖面（沿 x 求和），做互相关，峰值位置 = 两图之间的水平位移。

  * 位移 ≈ 0  => 深度已经落在彩色坐标系里 => registration 有效
  * 位移明显 != 0 => 没对齐（或对齐到别的相机）

同时比三态，互为对照：
  OFF / ON(流运行中设) / ON(重启流后)
如果 ON(重启后) 又退回 OFF 的位移，说明 registration 随流重启被重置。

⚠️ 这只能抓"整体错位"这类粗差，不能证明逐像素精确。
   精确验收仍要真人上场（R2）。

    python probe-d2c-align.py
"""

import sys
import os
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from openni2bind import (OpenNI2, Stream, pick_mode, LIB_DIR,
                         ONI_SENSOR_DEPTH, ONI_PIXEL_FORMAT_DEPTH_1_MM,
                         ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION)

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.normpath(os.path.join(HERE, "..", "..", "build", "shots"))
REG = ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION
COLOR_IDX = 1          # cv2 索引 1 = Astra Pro HD Camera（0 是 IR/黑的那个）


def line(t=""):
    print(t, flush=True)


def grab_depth(st, want=25, timeout=2000):
    best, nz_best = None, -1
    for _ in range(want):
        r = st.read(timeout)
        if not r:
            continue
        buf, w, h, meta = r
        a = np.frombuffer(bytes(buf), dtype="<u2")
        if a.size != w * h:
            continue
        img = a.reshape(h, w).astype(np.uint16)
        nz = int(np.count_nonzero(img))
        if nz > nz_best:
            best, nz_best = img, nz
    return best


def depth_xprofile(img, max_mm=6000):
    """深度图的"深度跳变"沿 x 的剖面（只用有效像素，避免空洞造出假边缘）"""
    v = img.astype(np.float32)
    v[v == 0] = np.nan
    v[v > max_mm] = np.nan
    # 沿 x 的梯度（跳过无效）
    dx = np.abs(np.diff(v, axis=1))
    dx[~np.isfinite(dx)] = 0.0
    prof = np.nansum(dx, axis=0)
    return prof


def color_xprofile(gray):
    """彩色图的亮度梯度沿 x 的剖面"""
    g = gray.astype(np.float32)
    dx = np.abs(np.diff(g, axis=1))
    return np.sum(dx, axis=0)


def best_shift(a, b, max_shift=120):
    """在 [-max_shift, max_shift] 里找让 a 与 b 最相关的位移。
    返回 (shift, 相关系数, 全部得分数组)"""
    a = a - a.mean()
    b = b - b.mean()
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0, 0.0, None
    a = a / na
    b = b / nb
    scores = []
    for s in range(-max_shift, max_shift + 1):
        if s >= 0:
            x, y = a[s:], b[:len(b) - s] if s else b
        else:
            x, y = a[:len(a) + s], b[-s:]
        n = min(len(x), len(y))
        if n < 100:
            scores.append(-1.0)
            continue
        scores.append(float(np.dot(x[:n], y[:n]) / n))
    scores = np.array(scores)
    i = int(np.argmax(scores))
    return i - max_shift, float(scores[i]), scores


def norm_png(img):
    v = img.astype(np.float32)
    m = v > 0
    if not m.any():
        return None
    lo, hi = float(v[m].min()), float(v[m].max())
    out = np.zeros_like(v)
    out[m] = 255.0 * (1.0 - (v[m] - lo) / max(1.0, hi - lo))
    return out.astype(np.uint8)


def main():
    os.makedirs(SHOTS, exist_ok=True)
    line("=" * 68)
    line("  registration 对齐目标验证（互相关）")
    line("=" * 68)

    # ---------- 彩色（真值） ----------
    import cv2
    cap = cv2.VideoCapture(COLOR_IDX, cv2.CAP_DSHOW)
    if not cap.isOpened():
        line("[X] cv2 打不开彩色设备 idx=%d" % COLOR_IDX)
        return 1
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    color = None
    for _ in range(20):
        ok, f = cap.read()
        if ok and f is not None and float(np.mean(f)) > 5:
            color = f
            break
    cap.release()
    if color is None:
        line("[X] 彩色读不到有效帧")
        return 2
    gray = cv2.cvtColor(color, cv2.COLOR_BGR2GRAY)
    cp = color_xprofile(gray)
    cv2.imwrite(os.path.join(SHOTS, "align-color.png"), color)
    line("彩色: %s  mean=%.1f" % (color.shape, float(np.mean(color))))

    # ---------- 深度三态 ----------
    oni = OpenNI2()
    if oni.initialize() != 0:
        line("[X] init 失败")
        return 3
    dev = oni.open_first()
    if not dev:
        line("[X] 无设备")
        return 4
    d_modes = oni.sensor_modes(ONI_SENSOR_DEPTH)
    d_mode = pick_mode(d_modes, 640, 480, 30, ONI_PIXEL_FORMAT_DEPTH_1_MM) or d_modes[0]

    states = []

    st = Stream(oni, ONI_SENSOR_DEPTH, d_mode)
    time.sleep(0.8)
    img = grab_depth(st)
    states.append(("OFF", img))

    s = oni.set_int_property(REG, 1)
    time.sleep(1.0)
    img2 = grab_depth(st)
    states.append(("ON(流运行中设)", img2))
    line("set status=%d readback=%s" % (s, oni.get_int_property(REG)))

    st.stop()
    time.sleep(0.5)
    st2 = Stream(oni, ONI_SENSOR_DEPTH, d_mode)
    time.sleep(0.8)
    img3 = grab_depth(st2)
    states.append(("ON(重启流后)", img3))
    st2.stop()
    oni.shutdown()

    # ---------- 互相关 ----------
    line("\n剖面互相关（峰值位移，越接近 0 越说明与彩色对齐）")
    line("  %-16s %8s %10s   %s" % ("状态", "位移px", "相关峰", "备注"))
    results = {}
    for name, img in states:
        if img is None:
            line("  %-16s 帧缺失" % name)
            continue
        p = depth_xprofile(img)
        sh, sc, _ = best_shift(p, cp)
        results[name] = (sh, sc)
        png = norm_png(img)
        if png is not None:
            cv2.imwrite(os.path.join(SHOTS, "align-depth-%s.png"
                                     % name.replace("(", "_").replace(")", "")
                                     .replace(" ", "")), png)
        line("  %-16s %8d %10.4f" % (name, sh, sc))

    # ---------- 结论 ----------
    line("\n" + "=" * 68)
    off = results.get("OFF")
    on = results.get("ON(流运行中设)")
    rs = results.get("ON(重启流后)")
    if off and on and rs:
        line("  OFF         位移 %+d px" % off[0])
        line("  ON(运行中)   位移 %+d px" % on[0])
        line("  ON(重启后)   位移 %+d px" % rs[0])
        if abs(on[0]) < abs(off[0]) - 3:
            line("  => ON 把位移拉近了 => registration 朝彩色坐标系对齐，方向正确。")
        elif abs(on[0]) > abs(off[0]) + 3:
            line("  => ON 反而把位移拉远了 => 对齐目标可能不是这颗彩色相机。")
        else:
            line("  => ON 与 OFF 位移相近 => 互相关分辨不出来，需要真人/标志物验证。")
        if abs(rs[0] - off[0]) <= 3 and abs(rs[0] - on[0]) > 3:
            line("  => 重启流后退回 OFF 的位移 => registration 随流重启被重置，")
            line("     所以桥必须在**流启动之后**再设 registration。")
    line("=" * 68)
    return 0


if __name__ == "__main__":
    sys.exit(main())
