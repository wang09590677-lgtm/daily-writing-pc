# -*- coding: utf-8 -*-
"""验证核心修法：给引擎加「房间结构基线（structure baseline）」，在按深度带取材时
把「与基线一致（=墙/地板/天花板）」的格子剔掉，只留下「与基线不同（=新出现的人）」。

关键设计（先在这里用真实数据验证，再落到引擎里）：
  structureBg[i]   = 预热窗口内该格深度的中位数
  structureVar[i]  = 预热窗口内该格深度的抖动（max-min）
  structureValid[i]= 抖动 < STABLE_TOL  → 这一格是"房间结构"（墙不动、人在动）
  剔除条件：structureValid 且 |dep - structureBg| < MATCH_TOL

为什么用"抖动"而不是"有没有人"来建基线：
  **人即使站在画面里，只要他在动，抖动就大 → 不会被误判成结构。**
  而墙/地板/天花板永远不动 → 抖动≈0 → 稳定被识别。这就避开了
  "录基准时人必须走开"的协作难题（正是之前 recorder 踩过的坑）。

本脚本对：空房基准(负) + 三组真人姿势(正) 逐一验证。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GW, GH = 96, 72
PIX = GW * GH
MAXMM = 8000


# ---------------- 引擎 stripBackgroundRows 的忠实复刻 ----------------
def strip_background_rows(mask, dep):
    WIDE = 0.82
    for p in range(2):
        down = (p == 0)
        refLo = refHi = -1
        refDepth = 0.0
        for k in range(GH):
            y = k if down else (GH - 1 - k)
            row = y * GW
            mn = mx = -1
            ds = 0.0
            dn = 0
            for x in range(GW):
                if not mask[row + x]:
                    continue
                if mn < 0:
                    mn = x
                mx = x
                ds += dep[row + x]
                dn += 1
            if mn < 0:
                continue
            if (mx - mn + 1) < GW * WIDE:
                refLo, refHi, refDepth = mn, mx, ds / dn
                continue
            if refLo < 0:
                continue
            lo = max(0, refLo - 1)
            hi2 = min(GW - 1, refHi + 1)
            tol = max(140, refDepth * 0.06)
            for x in range(GW):
                i = row + x
                if not mask[i]:
                    continue
                if x < lo or x > hi2 or abs(dep[i] - refDepth) > tol:
                    mask[i] = 0


def largest_cc(mask):
    seen = [False] * PIX
    best = []
    for start in range(PIX):
        if not mask[start] or seen[start]:
            continue
        stack = [start]
        seen[start] = True
        comp = []
        while stack:
            i = stack.pop()
            comp.append(i)
            x = i % GW
            y = i // GW
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < GW and 0 <= ny < GH:
                        j = ny * GW + nx
                        if mask[j] and not seen[j]:
                            seen[j] = True
                            stack.append(j)
        if len(comp) > len(best):
            best = comp
    return best


def bbox_of(comp):
    if not comp:
        return None
    xs = [i % GW for i in comp]
    ys = [i // GW for i in comp]
    return (len(comp), min(xs), max(xs), min(ys), max(ys))


def analyze(dep, band_lo, band_hi, struct_bg=None, struct_ok=None, match_tol=160):
    """返回最大连通块的信息。给了 struct 就先剔结构。"""
    mask = [0] * PIX
    for i in range(PIX):
        v = dep[i]
        if not (band_lo <= v <= band_hi):
            continue
        if struct_ok is not None and struct_ok[i]:
            if abs(v - struct_bg[i]) < match_tol:
                continue          # 与房间结构一致 → 是墙/地板，不是人
        mask[i] = 1
    strip_background_rows(mask, dep)
    bb = bbox_of(largest_cc(mask))
    if not bb:
        return None
    area, x0, x1, y0, y1 = bb
    return {
        "area": area,
        "bw": round((x1 - x0 + 1) / GW, 3),
        "bh": round((y1 - y0 + 1) / GH, 3),
        "cx": round((x0 + x1 + 1) / 2.0 / GW, 3),
    }


def build_structure(frames, stable_tol=130):
    """用若干帧建结构基线。返回 (bg, ok, 稳定格占比)"""
    bg = [0.0] * PIX
    ok = [0] * PIX
    stable = 0
    valid = 0
    for i in range(PIX):
        vs = []
        for f in frames:
            v = f[i]
            if 0 < v < MAXMM:
                vs.append(v)
        if len(vs) < 2:
            continue
        valid += 1
        vs.sort()
        med = vs[len(vs) // 2]
        if vs[-1] - vs[0] < stable_tol:
            bg[i] = med
            ok[i] = 1
            stable += 1
    return bg, ok, (stable / float(max(1, valid)))


def flat(grid):
    return [v for row in grid for v in row]


def main():
    d = json.load(open(os.path.join(HERE, "real-depth-person.json"), encoding="utf-8"))
    bg_frames = [flat(d["bg"]), flat(d["bg2"])]
    P = {p["name"]: [flat(f["grid"]) for f in p["frames"]] for p in d["poses"]}

    print("=== 建结构基线（用两份空房帧）===")
    sbg, sok, ratio = build_structure(bg_frames)
    print("  稳定格 %d / 有效格，占比 %.1f%%" % (sum(sok), ratio * 100))
    print("  （墙/地板/天花板应当稳定；人在动 → 不稳定，不会被误认成结构）")

    # 引擎为"人"选中的带（已由 depthDebug 确认）
    for band_lo, band_hi, tag in ((2578, 3145, "引擎选人带 2578-3145"), (2906, 3545, "幻影人带 2906-3545")):
        print("\n=== 深度带 %s ===" % tag)
        # 空房：应该没人
        a_old = analyze(bg_frames[0], band_lo, band_hi)
        a_new = analyze(bg_frames[0], band_lo, band_hi, sbg, sok)
        print("  空房间   旧: %s" % (("有人 bw=%.3f bh=%.3f" % (a_old["bw"], a_old["bh"])) if a_old else "没人 ✅"))
        print("  空房间   新: %s" % (("有人 bw=%.3f bh=%.3f" % (a_new["bw"], a_new["bh"])) if a_new else "没人 ✅"))

        ws_old = {}
        ws_new = {}
        for name, frames in P.items():
            f0 = frames[0]
            o = analyze(f0, band_lo, band_hi)
            n = analyze(f0, band_lo, band_hi, sbg, sok)
            ws_old[name] = o["bw"] if o else 0
            ws_new[name] = n["bw"] if n else 0
            print("  %-11s 旧: %-22s 新: %s" % (
                name,
                ("bw=%.3f bh=%.3f" % (o["bw"], o["bh"])) if o else "没人",
                ("bw=%.3f bh=%.3f" % (n["bw"], n["bh"])) if n else "没人"))

        do = ws_old.get("arms_down", 0)
        dn = ws_new.get("arms_down", 0)
        to = ws_old.get("t_pose", 0)
        tn = ws_new.get("t_pose", 0)
        if dn > 0 and tn > 0:
            print("  → T/垂臂 宽度比  旧 %.2fx   新 %.2fx   (真人 ground truth 2.71x)" %
                  (to / do if do else 0, tn / dn))
        # 三帧一致性
        for name, frames in P.items():
            ns = [analyze(f, band_lo, band_hi, sbg, sok) for f in frames]
            bws = [x["bw"] for x in ns if x]
            if bws:
                print("  %-11s 12 帧 bw 范围 %.3f..%.3f 全部有人=%s" %
                      (name, min(bws), max(bws), len(bws) == len(frames)))


if __name__ == "__main__":
    main()
