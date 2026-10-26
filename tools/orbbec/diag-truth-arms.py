# 真值测量（去噪版）：只保留最大连通域（人），再量躯干/剪影宽度。
# 上一版按"行内最左/最右"量，被零星噪点（画面顶行、边角）污染，
# 导致 arms_down 也报出 24 列"右延伸"。这次先做 8-连通取最大块。
import json
from collections import deque

d = json.load(open('tools/orbbec/real-depth-person.json', encoding='utf-8'))
bg = d['bg']
W, H = d['gw'], d['gh']
poses = {p['name']: p for p in d['poses']}


def fg_mask(grid, thr=350):
    m = [[0] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            v, b = grid[y][x], bg[y][x]
            if v > 0 and b > 0 and (b - v) >= thr:
                m[y][x] = 1
    return m


def largest_cc(m):
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


def torso_cols(m):
    """躯干列 = 下半段（y>=46）该列像素 >= 15（即躯干级高度）"""
    return [x for x in range(W) if sum(m[y][x] for y in range(46, H)) >= 15]


def measure(name, grid):
    raw = fg_mask(grid)
    m, n = largest_cc(raw)

    # 上半段（y<46）才是手臂区；躯干列用下半段量
    tc = torso_cols(m)
    if not tc:
        print("%-11s 最大块 %d 像素，但下半段无躯干列（取不到基准）" % (name, n))
        return None
    t0, t1 = min(tc), max(tc)

    # 手臂区（y 30..46）逐列的像素数，看在躯干两侧各伸出多少列
    def ext(side, minpx=2):
        cnt = 0
        rng = range(t0 - 1, -1, -1) if side == 'L' else range(t1 + 1, W)
        for x in rng:
            px = sum(m[y][x] for y in range(28, 48))
            if px >= minpx:
                cnt += 1
            elif cnt > 0 and px == 0:
                pass  # 允许中间 1 列空隙，继续数
        return cnt

    # 更稳的度量：手臂区里"离躯干最远且 >=2 像素"的列
    lcol = t0
    for x in range(t0 - 1, -1, -1):
        if sum(m[y][x] for y in range(28, 48)) >= 2:
            lcol = x
    rcol = t1
    for x in range(t1 + 1, W):
        if sum(m[y][x] for y in range(28, 48)) >= 2:
            rcol = x

    print("\n--- %s ---" % name)
    print("  最大连通域 %d 像素 (%.1f%% PIX)" % (n, n / (W * H) * 100))
    print("  躯干列 %d-%d  宽 %d (%.3f)" % (t0, t1, t1 - t0 + 1, (t1 - t0 + 1) / W))
    print("  手臂区最远 左=%d(-%d列)  右=%d(+%d列)" % (lcol, t0 - lcol, rcol, rcol - t1))
    print("  含臂总跨 %d 列 (%.3f)  张臂倍率 %.2fx"
          % (rcol - lcol + 1, (rcol - lcol + 1) / W, (rcol - lcol + 1) / (t1 - t0 + 1)))
    # 手臂区的空间图
    print("  手臂区空间图（y28-47, 躯干列标 T）:")
    for y in range(28, 48):
        s = ""
        for x in range(W):
            if m[y][x]:
                s += "T" if t0 <= x <= t1 else "#"
            else:
                s += "."
        if "#" in s or "T" in s:
            print("   %2d %s" % (y, s))
    return dict(torso=t1 - t0 + 1, span=rcol - lcol + 1,
                ratio=(rcol - lcol + 1) / (t1 - t0 + 1), n=n)


print("=" * 78)
print("真人深度几何真值（最大连通域，阈值 350mm）")
print("=" * 78)
res = {}
for name in ('arms_down', 't_pose', 'arms_down2'):
    res[name] = measure(name, poses[name]['frames'][-1]['grid'])

print("\n" + "=" * 78)
print("汇总：张臂倍率 = 含臂总跨 / 自身躯干宽")
print("=" * 78)
for k, v in res.items():
    if v:
        print("  %-11s 躯干 %2d 列 -> 含臂 %2d 列   倍率 %.2fx"
              % (k, v['torso'], v['span'], v['ratio']))
