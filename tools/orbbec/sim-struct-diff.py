# 选项1 的离线验证：用「房间结构基线差分」选人，彻底不用深度分位数/带宽。
#
# 动机（D2 实测）：
#   引擎当前先按深度分位数取 t，再取 hi = t + 厚度。
#   T-pose 的躯干在 3035mm、右手指尖在 3176mm；选中带的 hi=3145 把指尖切掉，
#   于是含臂整块 bw 从 0.469 掉到 0.14。
#   而"含双臂"的那条带（t=2882 hi=3516, bw=0.46 fill=0.22）确实存在，
#   只是被"居中分"打败了 0.08 分。
# → 根因不是切开、也不是没候选，而是**选带机制本身**把手臂切在带外。
#
# 结构基线差分做法：
#   预热时逐格记 min/max/均值；抖动小 = 房间结构（墙/地板/家具）。
#   运行时 mask = |dep - 结构均值| >= tol  →  "和空房间不一样的地方"就是人。
#   没有带 → 没有 hi 截断 → 手臂天生在内。
import json
import statistics
from collections import deque

d = json.load(open('tools/orbbec/real-depth-person.json', encoding='utf-8'))
W, H = d['gw'], d['gh']
PIX = W * H
bg = d['bg']
bg2 = d['bg2']
poses = {p['name']: p for p in d['poses']}


def largest_cc_area(m):
    seen = [[False] * W for _ in range(H)]
    best, best_n = None, 0
    for sy in range(H):
        for sx in range(W):
            if not m[sy][sx] or seen[sy][sx]:
                continue
            q = deque([(sy, sx)])
            seen[sy][sx] = True
            cells = []
            while q:
                y, x = q.popleft()
                cells.append((y, x))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < H and 0 <= nx < W and m[ny][nx] and not seen[ny][nx]:
                            seen[ny][nx] = True
                            q.append((ny, nx))
            if len(cells) > best_n:
                best_n, best = len(cells), cells
    out = [[0] * W for _ in range(H)]
    for y, x in best or []:
        out[y][x] = 1
    return out, (best_n if best else 0)


def measure(m):
    """返回 (躯干列宽, 含臂总跨, 倍率, 空间图)"""
    tc = [x for x in range(W) if sum(m[y][x] for y in range(46, H)) >= 15]
    if not tc:
        return None
    t0, t1 = min(tc), max(tc)
    lcol, rcol = t0, t1
    for x in range(t0 - 1, -1, -1):
        if sum(m[y][x] for y in range(28, 48)) >= 2:
            lcol = x
    for x in range(t1 + 1, W):
        if sum(m[y][x] for y in range(28, 48)) >= 2:
            rcol = x
    return dict(torso=t1 - t0 + 1, span=rcol - lcol + 1,
                ratio=(rcol - lcol + 1) / (t1 - t0 + 1),
                lcol=lcol, rcol=rcol, t0=t0, t1=t1)


def struct_diff_mask(grid, base, tol):
    """结构差分掩码：与空房基线差 >= tol 的格"""
    m = [[0] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            v, b = grid[y][x], base[y][x]
            if v > 0 and b > 0 and abs(v - b) >= tol:
                m[y][x] = 1
    return m


print("=" * 78)
print("方案对比：张臂倍率（含臂总跨 / 自身躯干宽）")
print("=" * 78)

print("\n【基线法 A】前景 = 比空房近 thr=350mm（阈值法，等价'有东西'）")
for name in ('arms_down', 't_pose', 'arms_down2'):
    grid = poses[name]['frames'][-1]['grid']
    m = [[0] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            v, b = grid[y][x], bg[y][x]
            if v > 0 and b > 0 and (b - v) >= 350:
                m[y][x] = 1
    cc, n = largest_cc_area(m)
    r = measure(cc)
    print("  %-11s 最大块 %3d  ->  %s" % (
        name, n, ("躯干 %2d / 含臂 %2d / %.2fx" % (r['torso'], r['span'], r['ratio'])) if r else "无"))

print("\n【基线法 B】结构差分 |dep - bg| >= tol，tol 扫描")
for tol in (250, 350, 450, 550, 700):
    line = "  tol=%4d  " % tol
    for name in ('arms_down', 't_pose', 'arms_down2'):
        grid = poses[name]['frames'][-1]['grid']
        m = struct_diff_mask(grid, bg, tol)
        cc, n = largest_cc_area(m)
        r = measure(cc)
        line += "%-11s %s   " % (name, ("%2d->%2d %.2fx" % (r['torso'], r['span'], r['ratio'])) if r else "无块")
    print(line)

print("\n【空房自检】空房帧套用同样准则，必须判没人")
for tol in (250, 350, 450, 550, 700):
    m = struct_diff_mask(bg2, bg, tol)
    cc, n = largest_cc_area(m)
    # 结构残差通常只有零星格
    print("  tol=%4d  最大块 %3d 像素 (%.2f%% PIX)  %s"
          % (tol, n, n / PIX * 100, "OK 判没人" if n < PIX * 0.005 else "!! 仍报有人"))

print("\n【关键：手臂是否在掩码里】t_pose 结构差分 (tol=450) 空间图")
m = struct_diff_mask(poses['t_pose']['frames'][-1]['grid'], bg, 450)
cc, n = largest_cc_area(m)
r = measure(cc)
for y in range(28, 50):
    s = ""
    for x in range(W):
        if cc[y][x]:
            s += "T" if (r and r['t0'] <= x <= r['t1']) else "#"
        else:
            s += "."
    if "#" in s or "T" in s:
        print("   %2d %s" % (y, s))
print("  => 躯干 %d / 含臂 %d / %.2fx" % (r['torso'], r['span'], r['ratio']))
