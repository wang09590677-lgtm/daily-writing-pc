# -*- coding: utf-8 -*-
"""
真人数据引导抓取 —— 双击 4-抓取真人数据.bat 运行。

为什么要抓真人数据：
  此前所有体感调试都用"合成人形"（几何理想、零空洞）。真机实测发现
  真实深度有 14~19% 空洞、表面抖动。要判断引擎在真实条件下灵不灵，
  必须有一份真人的真实深度。

引导方式：**全程中文语音播报**（不是滴滴声）。
  你站在 2.5~3 米外、背对屏幕，滴滴声只能表达"有事发生"，表达不了
  "该做什么"；长音短音听错一次就白录一组。语音直接说
  "请把两只手向左右两边伸平，像飞机的翅膀一样"，不存在理解歧义。

  语音流程：
    开场说明 → 请离开画面(12秒) → 录空房基准
    → 请走到 2.5~3 米站好 → 倒计时 5-4-3-2-1
    → 第一组：垂下手臂 → "保持不动" → 采集 4 秒 → "第一组很好"
    → 第二组：两手向左右伸平 → 保持 → 采集 → 反馈
    → 第三组：再把手垂下 → 保持 → 采集 → 反馈
    → 请再离开画面(12秒) → 录第二份空房校验
    → 播报结果

姿态序列：
  ① 双臂自然下垂（基准）
  ② 双臂侧平举 T 字形（关键：验证张臂识别在真实条件下是否成立）
  ③ 双臂自然下垂（还原，检查前后一致性）

输出：
  real-depth-person.json      三组姿态的 96x72 深度网格 + 空房基准（引擎回放用）
  real-depth-person-*.png     每组一张可视化（可自己看有没有站全）

依赖：纯标准库 + 本目录 openni2bind.py；
      语音文件在 voices/（由 gen-guided-voices.py 预生成，运行时完全离线）。

自检：python capture-guided.py --check    （连相机 + 打印画面 ASCII 图）
"""

import sys
import os
import json
import time
import zlib
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from openni2bind import (OpenNI2, Stream, pick_mode, ONI_SENSOR_DEPTH,
                         ONI_PIXEL_FORMAT_DEPTH_1_MM)

GW, GH = 96, 72
NEAR_LIMIT = 1500      # 比这更近的有效深度 = 镜头前有障碍物
MAXMM = 8000           # 超过视为飞点


# ============================ 语音播报 ============================
VOICE_DIR = os.path.join(HERE, "voices")
_voice_cache = {}


def _voice_path(key):
    return os.path.join(VOICE_DIR, "%s.wav" % key)


def voice_duration(key):
    """取语音时长（决定流程等待），失败返回 0"""
    if key in _voice_cache:
        return _voice_cache[key]
    d = 0.0
    p = _voice_path(key)
    try:
        import wave
        w = wave.open(p, "rb")
        d = w.getnframes() / float(w.getframerate())
        w.close()
    except Exception:
        d = 0.0
    _voice_cache[key] = d
    return d


def say(key, wait=True, tail=0.35):
    """播一句语音。wait=True 时等它播完（再留 tail 秒余量）。

    为什么必须等：语音是异步播放的，若不等就往下走，
    "保持不动"还没说完就开始采集，或还没走到位倒计时就结束。
    没有语音文件时退化为终端提示 + 系统响铃，功能不消失。
    """
    p = _voice_path(key)
    played = False
    if os.path.isfile(p):
        try:
            import winsound
            # SND_FILENAME | SND_SYNC：同步播放，返回时已播完
            winsound.PlaySound(p, winsound.SND_FILENAME | winsound.SND_NODEFAULT)
            played = True
        except Exception as e:
            print("      [语音播放失败 %s: %s]" % (key, e))
    if not played:
        # 退回系统 TTS（若可用）
        try:
            import subprocess
            subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "Add-Type -AssemblyName System.Speech; "
                 "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; "
                 "$s.Speak('%s')" % key],
                timeout=15, capture_output=True)
            played = True
        except Exception:
            print("\a", end="", flush=True)
    if wait:
        d = voice_duration(key)
        if d <= 0:
            time.sleep(1.0)
        elif not played:
            time.sleep(d + tail)


def say_text(text, wait=True):
    """临时文本（不在语音包里的，如计数）——退化为响铃+打印"""
    print("      >> %s" % text, flush=True)
    if wait:
        time.sleep(0.9)


# ====================== 纯标准库 PNG 写出 ======================
def _chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_depth_png(path, w, h, buf, max_mm=4000):
    """近=红 远=蓝 黑=没数据"""
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        base = y * w
        for x in range(w):
            v = buf[base + x]
            if v == 0 or v >= MAXMM:
                raw += b"\x00\x00\x00"
                continue
            t = min(1.0, v / float(max_mm))
            raw.append(int(255 * (1.0 - t)))
            raw.append(int(255 * (1.0 - abs(2.0 * t - 1.0))))
            raw.append(int(255 * t))
    png = (b"\x89PNG\r\n\x1a\n" +
           _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) +
           _chunk(b"IDAT", zlib.compress(bytes(raw), 6)) +
           _chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return path


# ====================== 降采样（与 depth-link.js 一致） ======================
def downsample(buf, w, h):
    """每格取最近的非零深度（不能用平均，平均会被人背后的墙稀释）"""
    best = [[1 << 30] * GW for _ in range(GH)]
    mapx = [min(GW - 1, x * GW // w) for x in range(w)]
    mapy = [min(GH - 1, y * GH // h) for y in range(h)]
    for y in range(h):
        gy = mapy[y]
        base = y * w
        row = best[gy]
        for x in range(w):
            v = buf[base + x]
            if not v or v >= MAXMM:
                continue
            gx = mapx[x]
            if v < row[gx]:
                row[gx] = v
    grid = [[0] * GW for _ in range(GH)]
    valid = 0
    for gy in range(GH):
        for gx in range(GW):
            v = best[gy][gx]
            if v < (1 << 30):
                grid[gy][gx] = v
                valid += 1
    return grid, valid


# ============================ 分析 ============================
def _largest_cc(cellset):
    """8 邻域最大连通块。人是一整块；噪声是散点——散点会把 bbox 撑到全屏。"""
    seen = set()
    best = ()
    for c in cellset:
        if c in seen:
            continue
        stack = [c]
        seen.add(c)
        comp = []
        while stack:
            x, y = stack.pop()
            comp.append((x, y))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    n = (x + dx, y + dy)
                    if n in cellset and n not in seen:
                        seen.add(n)
                        stack.append(n)
        if len(comp) > len(best):
            best = comp
    return best


def grid_stats(grid, bg=None):
    """统计一帧。给了 bg 就做背景差分找前景，并用最大连通块当人。

    判据（经过三次踩坑后定稿）：
      fg = |v - bg| >= 300mm  且  v 落在人体合理距离 1200~5000mm
    - 房间里的桌子/地板/墙：基准与实测深度相同 → 差≈0 → 不判前景（无害）；
    - 人站 2.5m 挡住远处的墙(7m)：v=2.5m 比背景近 → 差分大 → 判前景；
    - 人挡住近处的桌沿(0.45m)：v=2.5m 比背景**远** → 单向判据会漏！
      所以这里必须用**双向**差分。
    三次踩坑记录：
      1) "最近的一坨"当人 → 斜视房间里把斜墙当人（报横向 97%）；
      2) "所有比背景近的格"当人 → 噪声散点把 bbox 撑到 92%；
      3) 加过"基准无数据处出现人形距离就判前景"的兜底 → 基准若含人形
         空洞会大面积误判，已删除。
    """
    vals = []
    invalid = 0
    for row in grid:
        for v in row:
            if 0 < v < MAXMM:
                vals.append(v)
            else:
                invalid += 1
    if not vals:
        return None
    sv = sorted(vals)
    st = {
        "min_mm": sv[0], "max_mm": sv[-1], "median_mm": sv[len(sv) // 2],
        "invalid_ratio": round(invalid / float(GW * GH), 3),
        "body_cells": 0, "total_fg": 0, "is_person": False,
    }
    if not bg:
        return st

    fg = set()
    for y in range(GH):
        for x in range(GW):
            v = grid[y][x]
            b = bg[y][x]
            if not (0 < v < MAXMM):
                continue
            if not (0 < b < MAXMM):
                # 基准无数据：只有当 v 落在人体合理距离时才谨慎判为前景
                if 1300 <= v <= 4200:
                    fg.add((x, y))
                continue
            if abs(v - b) >= 300 and 1200 <= v <= 5000:
                fg.add((x, y))
    st["total_fg"] = len(fg)
    if not fg:
        return st

    cc = _largest_cc(fg)
    xs = [p[0] for p in cc]
    ys = [p[1] for p in cc]
    st.update({
        "body_cells": len(cc),
        "body_x0": min(xs), "body_x1": max(xs),
        "body_y0": min(ys), "body_y1": max(ys),
        "body_w_pct": round(100.0 * (max(xs) - min(xs) + 1) / GW, 1),
        "body_h_pct": round(100.0 * (max(ys) - min(ys) + 1) / GH, 1),
        "is_person": len(cc) >= 150 and (max(ys) - min(ys) + 1) >= GH * 0.35,
    })
    return st


def capture_background(st, seconds=3.0):
    """录空房基准：逐格取多帧中位数（0=该格一直没数据）"""
    from collections import defaultdict
    acc = defaultdict(list)
    t_end = time.time() + seconds
    n = 0
    while time.time() < t_end:
        r = st.read(500)
        if not r:
            continue
        buf, w, h, meta = r
        g, valid = downsample(buf, w, h)
        n += 1
        for y in range(GH):
            for x in range(GW):
                if 0 < g[y][x] < MAXMM:
                    acc[(y, x)].append(g[y][x])
    bg = [[0] * GW for _ in range(GH)]
    for (y, x), lst in acc.items():
        lst.sort()
        bg[y][x] = lst[len(lst) // 2]
    filled = sum(1 for y in range(GH) for x in range(GW) if bg[y][x] > 0)
    return bg, n, filled


def baseline_quality(bg):
    """空房基准是否可信。返回 (ok, 人站立区近物占比, 该区空洞率)

    只看"人站立时会占据的区域"（画面 8%~68% 高度、12%~88% 宽度）。

    判据只用「<1.5m 的近物」：那意味着有个东西贴着镜头（例如你还坐着）。
    不用空洞率，也不看画面底部的桌沿/地板——它们深度恒定，差分时天然抵消。
    """
    tot = 0
    near = 0
    inv = 0
    for y in range(GH):
        for x in range(GW):
            if not (GH * 0.08 < y < GH * 0.68 and GW * 0.12 < x < GW * 0.88):
                continue
            tot += 1
            v = bg[y][x]
            if 0 < v < NEAR_LIMIT:
                near += 1
            if not (0 < v < MAXMM):
                inv += 1
    nr = near / float(tot) if tot else 0.0
    ir = inv / float(tot) if tot else 0.0
    # 人站立区若明显出现贴脸近物，说明录基准时人没走开
    ok = nr < 0.06
    return ok, round(nr, 3), round(ir, 3)


def compare_frames(a, b, tol=400):
    """比较两帧（都应是空房）。返回 (不一致格数, 不一致比例, 中位差)

    用途：录第二份空房来验证第一份基准。若基准里其实有人站着，
    两份"空房"会明显不同 —— 这是唯一能自查基准污染的办法。
    """
    diff = 0
    tot = 0
    ds = []
    for y in range(GH):
        for x in range(GW):
            va, vb = a[y][x], b[y][x]
            if not (0 < va < MAXMM) or not (0 < vb < MAXMM):
                continue
            tot += 1
            d = abs(va - vb)
            ds.append(d)
            if d >= tol:
                diff += 1
    ds.sort()
    med = ds[len(ds) // 2] if ds else 0
    return diff, (diff / float(tot) if tot else 0.0), med


def ascii_map(grid):
    """粗看画面：.=无数据 0-9=深度带（0 最近 9 最远）"""
    vals = [v for row in grid for v in row if 0 < v < MAXMM]
    if not vals:
        return "(全空)"
    lo, hi = min(vals), max(vals)
    span = max(1, hi - lo)
    out = []
    for y in range(0, GH, 2):
        line = []
        for x in range(0, GW, 2):
            v = grid[y][x]
            if not (0 < v < MAXMM):
                line.append(".")
            else:
                line.append(str(min(9, int(9 * (v - lo) / span))))
        out.append("".join(line))
    return "\n".join(out)


# ============================ 主流程 ============================
POSES = [
    # (内部名, 屏幕标签, 语音key, 语音key的前缀 gotXX)
    ("arms_down", "双臂自然下垂，站直不动", "pose1", "got1"),
    ("t_pose", "双臂向左右两侧伸平（像飞机的翅膀）", "pose2", "got2"),
    ("arms_down2", "再把双臂放下来，自然下垂", "pose3", "got3"),
]
HOLD_SEC = 4.0
MAX_TRY = 3


def sample_pose(st, bg, seconds):
    """采 seconds 秒，返回 (帧列表, 最佳帧)"""
    grids = []
    best_stat = None
    best_grid = None
    best_buf = None
    t_end = time.time() + seconds
    while time.time() < t_end:
        r = st.read(500)
        if not r:
            continue
        buf, w, h, meta = r
        g, valid = downsample(buf, w, h)
        s = grid_stats(g, bg)
        if s and (best_stat is None or s["body_cells"] > best_stat["body_cells"]):
            best_stat = s
            best_grid = g
            best_buf = (bytes(buf), w, h)
        if len(grids) < 12:
            grids.append({"grid": g, "validCells": valid})
    return grids, best_stat, best_grid, best_buf


def main():
    import argparse
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--check", action="store_true",
                    help="只自检：连相机、打印画面，不抓取")
    ap.add_argument("--extra", type=int, default=0,
                    help="语音报完到开始采集之间额外等待的秒数（默认 0）")
    args = ap.parse_args()

    oni = OpenNI2()
    if oni.initialize() != 0:
        print("[X] OpenNI 初始化失败：%s" % oni.err())
        say("fail")
        return 1
    dev = oni.open_first()
    if not dev:
        print("[X] 没找到设备（Astra 插好了吗？）")
        say("fail")
        return 2
    print("设备: %s  序列号: %s" % (dev["name"], oni.get_string_property(3)))

    modes = oni.sensor_modes(ONI_SENSOR_DEPTH)
    mode = pick_mode(modes, 640, 480, 30, ONI_PIXEL_FORMAT_DEPTH_1_MM)
    if not mode:
        print("[X] 没有 640x480 深度模式")
        say("fail")
        return 3
    st = Stream(oni, ONI_SENSOR_DEPTH, mode)
    print("深度流 %dx%d@%d" % (mode["w"], mode["h"], mode["fps"]))

    # ---------------- 自检 ----------------
    if args.check:
        print("\n  自检：录 3 秒基准（请离开画面）")
        bg, nbg, filled = capture_background(st, 3.0)
        ok, nr, ir = baseline_quality(bg)
        print("  基准 %d 帧  有效格 %d/%d" % (nbg, filled, GW * GH))
        print("  人站立区空洞 %.1f%%  该区近物 %.1f%%" % (ir * 100, nr * 100))
        print("  基准判定: %s" % ("干净可用" if ok else "不可信（录基准时人还在画面里？）"))
        t_end = time.time() + 3.0
        last = last_grid = None
        while time.time() < t_end:
            r = st.read(500)
            if not r:
                continue
            buf, w, h, meta = r
            g, valid = downsample(buf, w, h)
            s = grid_stats(g, bg)
            if s:
                last, last_grid = s, g
        st.stop(); oni.shutdown()
        if last:
            print("\n  比背景近的格 %d，最大连通块 %d -> %s"
                  % (last["total_fg"], last["body_cells"],
                     "有人" if last.get("is_person") else "没人"))
            print("  当前一帧（.=无数据，0 近 9 远）：")
            print(ascii_map(last_grid))
        return 0

    # ---------------- 第 1 步：空房基准 ----------------
    print("")
    print("=" * 62)
    print("  第 1 步：录「空房间」基准")
    print("  >>> 语音会请你离开画面（走到相机看不到的地方）")
    print("=" * 62)
    say("leave1")          # "现在请你离开画面…你有十二秒。"
    print("  请离开画面…… 12 秒后开始录制")
    for i in range(12, 0, -1):
        print("    %2d 秒" % i, flush=True)
        if i <= 3:
            say_text("%d" % i, wait=False)
        time.sleep(1.0)
    bg, nbg, filled = capture_background(st, 3.0)
    ok_bg, nr, ir = baseline_quality(bg)
    print("  基准 %d 帧  有效格 %d/%d" % (nbg, filled, GW * GH))
    print("  人站立区近物 %.1f%%  空洞 %.1f%%" % (nr * 100, ir * 100))
    if not ok_bg:
        print("  [i] 提示：基准里检出贴脸近物，可能你还没完全走开。")
        print("      若接下来每组都测不到人，重跑一次并在第 1 步走远些即可。")
        say("baseline_bad")
    else:
        print("  [OK] 基准看起来干净")
        say("baseline_ok")

    # ---------------- 第 2 步：站位 ----------------
    print("")
    print("=" * 62)
    print("  第 2 步：走到离摄像头 2.5~3 米处（约 3 大步）")
    print("  全身进画面：头顶留一点空，脚看得见")
    print("=" * 62)
    say("go_stand")        # "现在请走到离镜头两米半到三米的地方…"
    # 语音念 五 四 三 二 一（每声独立、时长自洽，节奏稳定）
    print("  倒计时……")
    for i in (5, 4, 3, 2, 1):
        print("    %d" % i, flush=True)
        say("c%d" % i, wait=True)
    time.sleep(0.4 + args.extra)

    # ---------------- 三组姿势 ----------------
    results = []
    for name, label, vpose, vgot in POSES:
        print("")
        print("  ── %s" % label)
        best_stat = best_grid = best_buf = None
        grids = []
        for attempt in range(MAX_TRY):
            if attempt > 0:
                print("     这组没录到人，重来一次")
                say("retry")            # "刚才没有拍到你…我们再来一次。"
                time.sleep(0.5)
            # 1) 说清楚要做什么
            say(vpose, wait=False)      # 例:"第二组。请把两只手向左右两边伸平…"
            vdur = voice_duration(vpose)
            # 2) 给足摆姿势的时间：语音长度 + 1.8 秒缓冲
            time.sleep(max(2.5, vdur + 1.8) + args.extra)
            # 3) 说"保持不动"，然后再开始采集
            say("hold", wait=False)     # "保持不动。"
            time.sleep(max(0.9, voice_duration("hold") + 0.35))
            print("     （开始采集，保持姿势约 %d 秒）" % int(HOLD_SEC))
            grids, best_stat, best_grid, best_buf = sample_pose(st, bg, HOLD_SEC)
            if best_stat and best_stat.get("is_person"):
                break
        if best_stat and best_stat.get("is_person"):
            print("     采样 %d 帧  人在画面里：横向 %.0f%%  高度 %.0f%%  连通 %d 格"
                  % (len(grids), best_stat["body_w_pct"],
                     best_stat["body_h_pct"], best_stat["body_cells"]))
            say(vgot)                   # 例:"第二组很好。"
        else:
            print("     采样 %d 帧  [!] 没测到人" % len(grids))
            if attempt >= MAX_TRY - 1:
                say("retry")

        rec = {"name": name, "label": label, "frames": grids,
               "stats": best_stat, "attempts": attempt + 1}
        if best_buf is not None:
            p = os.path.join(HERE, "real-depth-person-%s.png" % name)
            write_depth_png(p, best_buf[1], best_buf[2], best_buf[0])
            rec["png"] = os.path.basename(p)
        results.append(rec)

    # ---------------- 第 4 步：再录一次空房，校验基准 ----------------
    print("")
    print("=" * 62)
    print("  第 4 步：最后再录一次空房间，用来校验前面的基准")
    print("=" * 62)
    say("leave2")            # "最后一步，请你再离开画面一次…你有十二秒。"
    print("  请离开画面…… 12 秒后开始录制")
    for i in range(12, 0, -1):
        print("    %2d 秒" % i, flush=True)
        if i <= 3:
            say_text("%d" % i, wait=False)
        time.sleep(1.0)
    say("checking", wait=False)
    bg2, nb2, _ = capture_background(st, 3.0)

    st.stop()
    oni.shutdown()

    diff_n, diff_r, diff_med = compare_frames(bg, bg2)
    print("  两次空房对比：不一致 %d 格（%.1f%%），中位差 %dmm"
          % (diff_n, diff_r * 100, diff_med))
    bg_clean = diff_r < 0.12
    if not bg_clean:
        print("  [!] 两次空房差异过大 → 录制基准时画面里很可能有人。")
        print("      本次数据不建议使用，请重跑一次并在第 1、4 步都离开画面。")

    # ---------------- 汇总 ----------------
    def stat_of(n):
        return next((r["stats"] for r in results if r["name"] == n), None)

    down, tpose, down2 = stat_of("arms_down"), stat_of("t_pose"), stat_of("arms_down2")
    valid_all = all(s and s.get("is_person") for s in (down, tpose, down2))
    # T字宽度应明显大于垂臂（真实人张臂约 1.4~2.0 倍）
    ratio = None
    if down and tpose and down.get("body_w_pct"):
        ratio = tpose.get("body_w_pct", 0) / down.get("body_w_pct")
    ok = bool(valid_all and bg_clean and ratio and ratio > 1.25)

    out = {
        "device": dev["name"],
        "srcW": mode["w"], "srcH": mode["h"], "gw": GW, "gh": GH,
        "capturedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "mode": "guided", "bg": bg, "bg2": bg2,
        "baseline": {"stand_zone_near": nr, "stand_zone_invalid": ir,
                     "ok": ok_bg,
                     "bg_cross_check": {"diff_cells": diff_n,
                                        "diff_ratio": round(diff_r, 3),
                                        "median_diff_mm": diff_med,
                                        "clean": bg_clean}},
        "poses": results,
        "summary": {
            "arms_down_w_pct": down.get("body_w_pct") if down else None,
            "t_pose_w_pct": tpose.get("body_w_pct") if tpose else None,
            "arms_down_h_pct": down.get("body_h_pct") if down else None,
            "t_pose_h_pct": tpose.get("body_h_pct") if tpose else None,
            "tpose_over_down_ratio": round(ratio, 2) if ratio else None,
            "looks_valid": ok,
        },
    }
    path = os.path.join(HERE, "real-depth-person.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f)

    print("")
    print("=" * 62)
    if down and tpose:
        print("  垂臂：横向 %s%%  高度 %s%%" % (down.get("body_w_pct"), down.get("body_h_pct")))
        print("  T字 ：横向 %s%%  高度 %s%%" % (tpose.get("body_w_pct"), tpose.get("body_h_pct")))
        if ratio:
            print("  T字/垂臂 宽度比：%.2f 倍（真人张臂一般 1.4~2.0）" % ratio)
    print("  已保存 real-depth-person.json 与 real-depth-person-*.png")
    print("=" * 62)
    if ok:
        print("  [OK] 数据有效（基准干净，且 T字明显比垂臂宽）")
        say("success")     # "全部完成，数据有效。…告诉助手一声，好了。"
    else:
        if not bg_clean:
            print("  [!] 基准可能被污染（两次空房不一致）")
        if not valid_all:
            print("  [!] 有姿势组没测到人")
        if ratio and ratio <= 1.25:
            print("  [!] T字没有明显比垂臂宽（%.2f 倍）" % ratio)
        print("      请回到电脑前，跟助手说一声即可。")
        say("fail")        # "数据不完整，需要重来。…告诉助手一声。"
    print("")
    return 0


if __name__ == "__main__":
    sys.exit(main())
