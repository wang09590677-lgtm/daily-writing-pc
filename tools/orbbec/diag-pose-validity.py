# -*- coding: utf-8 -*-
"""判定 guided 抓取的每一帧"那块人"到底是真人还是静止伪影。

自证思路（三重证据）：
  E1 该帧 blob 与空房基准 bg 的逐格差分：若 blob 区域绝大多数格在 bg 里本来就是
     同样的深度（|d|<300），说明"这块东西"基准里早就有 → 静止物，不是人。
  E2 反向：blob 里有多少格是"基准无数据 / 基准深度差很大" → 真正新出现的东西。
  E3 姿势间对比：arms_down vs t_pose vs arms_down2 的形状/位置变化。真人换姿势
     一定会变；静止伪影三帧几乎逐格相同。

用法: python diag-pose-validity.py [json路径]
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GW, GH = 96, 72
MAXMM = 8000


def largest_cc(cellset):
    seen = set()
    best = []
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


def fg_cells(grid, bg):
    fg = set()
    for y in range(GH):
        for x in range(GW):
            v = grid[y][x]
            if not (0 < v < MAXMM):
                continue
            b = bg[y][x] if bg else 0
            if not (0 < b < MAXMM):
                if 1300 <= v <= 4200:
                    fg.add((x, y))
                continue
            if abs(v - b) >= 300 and 1200 <= v <= 5000:
                fg.add((x, y))
    return fg


def blob_info(grid, bg):
    fg = fg_cells(grid, bg)
    cc = largest_cc(fg)
    if not cc:
        return {"fcells": len(fg), "blob": 0, "bbox": None,
                "w_pct": 0.0, "h_pct": 0.0, "cx": None, "med": 0,
                "static_ratio": None, "new_ratio": None}
    xs = [p[0] for p in cc]
    ys = [p[1] for p in cc]
    ds = [grid[y][x] for (x, y) in cc if 0 < grid[y][x] < MAXMM]
    ds.sort()
    # E1/E2: blob 区域在 bg 里是不是本来就有同样的东西
    static_n = new_n = 0
    for (x, y) in cc:
        v = grid[y][x]
        b = bg[y][x]
        if 0 < v < MAXMM and 0 < b < MAXMM and abs(v - b) < 300:
            static_n += 1
        else:
            new_n += 1
    return {
        "fcells": len(fg),
        "blob": len(cc),
        "bbox": (min(xs), min(ys), max(xs), max(ys)),
        "w_pct": round((max(xs) - min(xs) + 1) / float(GW), 3),
        "h_pct": round((max(ys) - min(ys) + 1) / float(GH), 3),
        "cx": round((min(xs) + max(xs)) / 2.0 / GW, 3),
        "cy": round(min(ys) / float(GH), 3),
        "med": ds[len(ds) // 2] if ds else 0,
        "static_ratio": round(static_n / float(len(cc)), 3),
        "new_ratio": round(new_n / float(len(cc)), 3),
    }


def frame_to_grid(fr):
    """frame 可能是 {'grid':[[...]]} 或直接 [[...]]。"""
    if isinstance(fr, dict):
        return fr.get("grid")
    return fr


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        HERE, "real-depth-person.json")
    d = json.load(open(path, encoding="utf-8"))
    bg = d["bg"]
    bg2 = d.get("bg2")

    # 基准自检
    b1 = blob_info(bg, bg)
    print("=== 基准自检 ===")
    print("  bg  vs bg  :", b1["blob"], "格, static=%.3f" % (b1["static_ratio"] or 0))
    if bg2:
        b2 = blob_info(bg2, bg)
        print("  bg2 vs bg  :", b2["blob"], "格 (应≈0)")

    print("\n=== 各姿势逐帧 ===")
    pose_blobs = []
    for pi, po in enumerate(d["poses"]):
        print("\n[%d] %s  (%s)  frames=%d" %
              (pi, po["name"], po.get("label", ""), len(po["frames"])))
        for fi, fr in enumerate(po["frames"]):
            g = frame_to_grid(fr)
            if not g:
                continue
            info = blob_info(g, bg)
            print("   f%-2d blob=%-4d bbox=%-22s w=%.3f h=%.3f cx=%.3f med=%4d "
                  "static=%.3f new=%.3f" %
                  (fi, info["blob"], str(info["bbox"]), info["w_pct"],
                   info["h_pct"], info["cx"] or 0, info["med"],
                   info["static_ratio"] or 0, info["new_ratio"] or 0))
            pose_blobs.append((po["name"], fi, g, info))

    # E3: 同一姿势内逐帧差异 + 姿势间差异（只比 blob 区域的深度）
    print("\n=== 帧间稳定性（真人换姿势会变；静止伪影几乎不变）===")

    def diff(a, b, region=None):
        n = 0
        tot = 0
        for y in range(GH):
            for x in range(GW):
                if region and (x, y) not in region:
                    continue
                va, vb = a[y][x], b[y][x]
                if 0 < va < MAXMM and 0 < vb < MAXMM:
                    tot += 1
                    if abs(va - vb) >= 300:
                        n += 1
        return n, (n / float(tot) if tot else 0)

    by_name = {}
    for name, fi, g, info in pose_blobs:
        by_name.setdefault(name, []).append(g)

    for name, gs in by_name.items():
        if len(gs) >= 2:
            n, r = diff(gs[0], gs[-1])
            print("  %-11s 首末帧差异: %d 格 (%.1f%%)" % (name, n, r * 100))

    names = list(by_name.keys())
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            n, r = diff(by_name[names[i]][0], by_name[names[j]][0])
            print("  %-11s vs %-11s: %d 格 (%.1f%%)" %
                  (names[i], names[j], n, r * 100))


if __name__ == "__main__":
    main()
