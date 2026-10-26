# -*- coding: utf-8 -*-
"""空间可视化：把 blob 画成 ASCII，并把两姿势之间的差异格标出来。

用途：判断 t_pose 比 arms_down 多出来的那 175 格，是不是真的长在"肩膀高度、
水平向两侧延伸"——也就是真的手臂；还是杂乱散布（噪声/墙）。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GW, GH = 96, 72
MAXMM = 8000


def load(path):
    return json.load(open(path, encoding="utf-8"))


def fg_cells(grid, bg):
    fg = set()
    for y in range(GH):
        for x in range(GW):
            v = grid[y][x]
            if not (0 < v < MAXMM):
                continue
            b = bg[y][x]
            if not (0 < b < MAXMM):
                if 1300 <= v <= 4200:
                    fg.add((x, y))
                continue
            if abs(v - b) >= 300 and 1200 <= v <= 5000:
                fg.add((x, y))
    return fg


def render(g1, g2, bg, tag):
    """g1 = 基准姿势, g2 = 对比姿势。'#'=只在g1, '*'=只在g2, '@'=都有"""
    f1 = fg_cells(g1, bg)
    f2 = fg_cells(g2, bg)
    print("\n--- %s ---   (# 仅A / * 仅B / @ 两帧都有)" % tag)
    print("    " + "".join(str((x // 10) % 10) for x in range(GW)))
    for y in range(GH):
        row = []
        for x in range(GW):
            a = (x, y) in f1
            b = (x, y) in f2
            row.append("@" if (a and b) else ("#" if a else ("*" if b else ".")))
        print("%3d " % y + "".join(row))

    def ys(cs):
        return sorted(set(y for (_, y) in cs))

    def xs(cs):
        return sorted(set(x for (x, _) in cs))

    only2 = f2 - f1
    if only2:
        ys2 = [y for (_, y) in only2]
        xs2 = [x for (x, _) in only2]
        # 肩高参考：blob 顶部往下 15%~30% 处
        top = min(y for (_, y) in f1) if f1 else min(ys2)
        bot = max(y for (_, y) in f1) if f1 else max(ys2)
        h = max(1, bot - top)
        print("  仅B新增 %d 格；x范围 %d..%d，y范围 %d..%d" %
              (len(only2), min(xs2), max(xs2), min(ys2), max(ys2)))
        print("  A 的 y 范围 %d..%d (高%d)；新增格 y 落在顶部往下 %.0f%%~%.0f%% 处" %
              (top, bot, h,
               100.0 * (min(ys2) - top) / h, 100.0 * (max(ys2) - top) / h))


def main():
    p = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        HERE, "real-depth-person.json")
    d = load(p)
    bg = d["bg"]
    pose = {po["name"]: po["frames"][0]["grid"] for po in d["poses"]}
    names = list(pose.keys())
    print("姿势:", names)
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            render(pose[names[i]], pose[names[j]], bg,
                   "%s vs %s" % (names[i], names[j]))


if __name__ == "__main__":
    main()
