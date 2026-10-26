# -*- coding: utf-8 -*-
"""精确复刻 motion-engine.js 的 depthPersonMask，喂入真实**空房间**基准，
找出"幻影人"到底是被哪个候选深度带、哪一块连通域赢下的。

对应引擎代码：
  stripBackgroundRows  = L470
  labelComponents 选择  = L1356-1405（含 w0<=1 && w1>=W-2 排除、fill>0.88、bh/bw<1.10）
  score                = L1397
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
GW, GH = 96, 72
PIX = GW * GH
MAXMM = 8000
MIN_PERSON_MM, MAX_PERSON_MM = 600, 5000


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
            wide = (mx - mn + 1) >= GW * WIDE
            if not wide:
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


def comps(mask):
    """返回 [(root_area, minx, maxx, miny, maxy)]。8 连通。"""
    lab = [0] * PIX
    parent = {}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    nxt = 0
    for y in range(GH):
        row = y * GW
        for x in range(GW):
            i = row + x
            if not mask[i]:
                continue
            lb = 0
            if x > 0 and lab[i - 1]:
                lb = lab[i - 1]
            if y > 0:
                for dx in (-1, 0, 1):
                    xx = x + dx
                    if 0 <= xx < GW and lab[i - GW + dx] and (not lb or lab[i - GW + dx] < lb):
                        lb = lab[i - GW + dx]
            if not lb:
                nxt += 1
                parent[nxt] = nxt
                lb = nxt
            lab[i] = lb
            if x > 0 and lab[i - 1]:
                union(lb, lab[i - 1])
            if y > 0:
                for dx in (-1, 0, 1):
                    xx = x + dx
                    if 0 <= xx < GW and lab[i - GW + dx]:
                        union(lb, lab[i - GW + dx])
    stats = {}
    for y in range(GH):
        for x in range(GW):
            i = y * GW + x
            if not lab[i]:
                continue
            r = find(lab[i])
            if r not in stats:
                stats[r] = [1, x, x, y, y]
            else:
                s = stats[r]
                s[0] += 1
                s[1] = min(s[1], x)
                s[2] = max(s[2], x)
                s[3] = min(s[3], y)
                s[4] = max(s[4], y)
    return [(v[0], v[1], v[2], v[3], v[4]) for v in stats.values()]


def select_comp(cs):
    """复刻 L1356-1405 的选法（无 lastSkeletonCenter）。返回 (best, fallback, sideFB)"""
    best = None
    bestScore = -1e18
    fallback = None
    fallbackArea = 0
    sideFB = None
    sideFBArea = 0
    for (area, w0, w1, h0, h1) in cs:
        if area < PIX * 0.005 or area > PIX * 0.60:
            continue
        if w0 <= 1 and w1 >= GW - 2:
            continue
        if area > fallbackArea:
            fallbackArea = area
            fallback = (area, w0, w1, h0, h1)
        bw = (w1 - w0 + 1) / GW
        bh = (h1 - h0 + 1) / GH
        cx = (w0 + w1 + 1) / (2.0 * GW)
        cy = (h0 + h1 + 1) / (2.0 * GH)
        if bh < 0.22 or bw < 0.025 or bh / bw < 1.10:
            continue
        fill = area / float(max(1, (w1 - w0 + 1) * (h1 - h0 + 1)))
        if fill > 0.88:
            if (w0 <= 1 or w1 >= GW - 2) and area > sideFBArea:
                sideFBArea = area
                sideFB = (area, w0, w1, h0, h1)
            continue
        offCenter = max(0.0, abs(cx - 0.5) - 0.36)
        touchSide = (w0 <= 1 or w1 >= GW - 2)
        score = (min(2.6, bh / bw) * 1.6 + min(0.9, bh) * 1.2
                 + (1 - min(1, abs(cx - 0.5) * 2)) * 2.4
                 - abs(fill - 0.5) * 2.2 + min(4, __import__("math").log1p(area) * 0.35)
                 - (1.2 if touchSide else 0) - offCenter * 8)
        if score > bestScore:
            bestScore = score
            best = (area, w0, w1, h0, h1, score, bw, bh, fill)
    return best, fallback, sideFB


def main():
    d = json.load(open(os.path.join(HERE, "real-depth-person.json"), encoding="utf-8"))
    bg = d["bg"]
    dep = [v for row in bg for v in row]

    cand = [v for v in dep if MIN_PERSON_MM <= v <= MAX_PERSON_MM]
    cand.sort()
    print("候选深度数 %d" % len(cand))
    TRIES = [0, 0.005, 0.02, 0.05, 0.10, 0.20, 0.35]
    tList = []
    for q in TRIES:
        tList.append(cand[min(len(cand) - 1, int(len(cand) * q))])
    print("分位候选 t =", [round(t) for t in tList])

    print("\n%-9s %6s %7s %8s  %s" % ("档", "t", "hi", "占比", "选中的连通域"))
    winners = []
    for t in tList:
        thicks = [min(900, max(450, t * 0.22)), max(260, min(430, t * 0.09))]
        for wi, th in enumerate(thicks):
            hi = t + th
            c = sum(1 for v in dep if t <= v <= hi)
            r = c / float(PIX)
            if r < 0.005 or r > 0.85:
                print("%-9s %6d %7d %8.3f  面积闸" % (str(round(t)) + ("" if wi == 0 else "窄"), t, hi, r))
                continue
            mask = [1 if t <= v <= hi else 0 for v in dep]
            strip_background_rows(mask, dep)
            best, fb, sfb = select_comp(comps(mask))
            tag = "t=%d hi=%d%s" % (t, hi, "" if wi == 0 else " 窄")
            if best:
                a, w0, w1, h0, h1, sc, bw, bh, fill = best
                print("%-9s %6d %7d %8.3f  胜 %d格 x[%d..%d] y[%d..%d] bw=%.2f bh=%.2f "
                      "fill=%.2f score=%.2f" % (tag, t, hi, r, a, w0, w1, h0, h1, bw, bh, fill, sc))
                winners.append((sc, t, hi, a, w0, w1, h0, h1))
            else:
                s = "无可选块"
                if fb:
                    s += " fallback=%d格 x[%d..%d] y[%d..%d]" % (fb[0], fb[1], fb[2], fb[3], fb[4])
                print("%-9s %6d %7d %8.3f  %s" % (tag, t, hi, r, s))

    winners.sort(reverse=True)
    print("\n★ 最高分的那一档就是引擎会选中的：")
    if winners:
        sc, t, hi, a, w0, w1, h0, h1 = winners[0]
        print("   t=%d hi=%d  块 %d格  x[%d..%d] y[%d..%d]  score=%.2f" %
              (t, hi, a, w0, w1, h0, h1, sc))
        print("   → 空房间里这块被判成 '人'（幻影人）")


if __name__ == "__main__":
    main()
