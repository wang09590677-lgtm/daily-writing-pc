# 掩码链路离线参照：在**同一批真实动作帧**上，复刻 motion-engine.js 的
# 背景差前景框（中值背景 + 亮度阈值 + 包围盒），量出 width/height/centroidY，
# 与姿态链路（MediaPipe bbox）逐帧对比。
#
# 只读，不碰生产文件。输出 build/_maskchain.json
import cv2, os, json
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FR = os.path.join(ROOT, "build", "_frames2")

ACTIONS = ["jumpingJacks", "squat", "jumpRope", "highKnees", "burpee"]
# 每个动作对应的计次信号 + profile（data/fitness-plan.js）
PROF = {
    "jumpingJacks": {"cn": "开合跳", "signal": "width", "ea": 0.18},
    "squat":        {"cn": "深蹲",   "signal": "height", "ea": 0.12},
    "jumpRope":     {"cn": "跳绳",   "signal": "width", "ea": 0.045},
    "highKnees":    {"cn": "原地高抬腿跑", "signal": "width", "ea": 0.20},
    "burpee":       {"cn": "波比跳", "signal": "height", "ea": 0.16},
}

W, H = 96, 72          # 引擎内部采样网格
out = {}

def stat(a):
    a = [v for v in a if np.isfinite(v)]
    if not a:
        return None
    a = np.array(a)
    return {"min": round(float(a.min()), 4), "max": round(float(a.max()), 4),
            "mean": round(float(a.mean()), 4), "std": round(float(a.std()), 4),
            "range": round(float(a.max() - a.min()), 4)}

for act in ACTIONS:
    d = os.path.join(FR, act)
    if not os.path.isdir(d):
        continue
    files = sorted(f for f in os.listdir(d) if f.startswith("f") and f.endswith(".jpg"))
    # 第一遍：采样帧（下采样到 96x72）算中值背景（= 静止背景基线）
    grays = []
    for f in files:
        im = cv2.imread(os.path.join(d, f))
        g = cv2.cvtColor(cv2.resize(im, (W, H), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        grays.append(g.astype(np.float32))
    bg = np.median(np.stack(grays), axis=0)   # 中值背景

    widths, heights, cys, areas = [], [], [], []
    for g in grays:
        diff = np.abs(g - bg)
        # 阈值：与引擎同量级（引擎用 noise*2.6，下限 11）；这里取固定 22 作保守前景判据
        mask = diff > 22
        ys, xs = np.where(mask)
        if len(xs) < W * H * 0.004:
            widths.append(np.nan); heights.append(np.nan); cys.append(np.nan); areas.append(0)
            continue
        x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
        widths.append((x1 - x0 + 1) / W)
        heights.append((y1 - y0 + 1) / H)
        cys.append(float(ys.mean() / H))
        areas.append(len(xs) / (W * H))

    res = {"total": len(files), "width": stat(widths), "height": stat(heights),
           "centroidY": stat(cys), "area": stat(areas)}
    # 3.5s 窗峰峰值（24fps）
    def win_spread(a, wf):
        a = np.array(a, dtype=float)
        n = len(a); w = min(wf, n)
        if w < 10:
            return None
        sp = []
        for i in range(w - 1, n):
            seg = a[i - w + 1:i + 1]
            seg = seg[np.isfinite(seg)]
            if len(seg) >= 10:
                sp.append(seg.max() - seg.min())
        sp = sorted(sp)
        if not sp:
            return None
        return {"min": round(sp[0], 4), "med": round(sp[len(sp) // 2], 4), "max": round(sp[-1], 4)}
    wf = int(24 * 3.5)
    res["widthWin"] = win_spread(widths, wf)
    res["heightWin"] = win_spread(heights, wf)
    res["centroidYWin"] = win_spread(cys, wf)
    out[act] = res
    p = PROF[act]
    sig = p["signal"]
    key = "width" if sig == "width" else ("height" if sig == "height" else "centroidY")
    sp = res[key + "Win"]["med"] if res.get(key + "Win") else None
    print("【%s】帧 %d  掩码链路 width 均值=%s 峰峰=%s | height 均值=%s | centroidY 均值=%s" % (
        p["cn"], len(files), res["width"]["mean"], res["width"]["range"],
        res["height"]["mean"], res["centroidY"]["mean"]))
    print("    该信号=%s 3.5s窗峰峰中位=%s" % (key, sp))

json.dump(out, open(os.path.join(ROOT, "build", "_maskchain.json"), "w"), ensure_ascii=False, indent=1)
print("done -> build/_maskchain.json")
