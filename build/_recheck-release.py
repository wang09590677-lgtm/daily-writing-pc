# -*- coding: utf-8 -*-
"""崩溃后复检：发行包在蓝屏重启后是否仍然完好。

为什么要单独跑一遍：蓝屏发生在打包/验收**之后**，理论上写盘已完成，
但"理论"不算证据 —— 崩溃时若有文件句柄没刷盘，可能留下**截断的文件**，
而截断的 .mp4/.jpg 在页面上只表现为"某个动作没视频/某张图裂了"，
**不看是发现不了的**。所以这里复跑一次出厂自检，并额外做**大小合理性**检查。
"""

import os
import sys
import json

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import importlib.util
spec = importlib.util.spec_from_file_location("mr", os.path.join(HERE, "make-release.py"))
mr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mr)

PKG = os.path.join(os.path.dirname(mr.ROOT), "release", "AI学习训练助手")

fails = []

# 1) 出厂自检（引用可达性）
problems = []
n_pic, n_img = mr.verify(PKG, problems)
print("出厂自检：配图 %d 张" % n_img)
if problems:
    for p in problems:
        print("  [X] %s" % p)
        fails.append(p)
else:
    print("  [OK] 引用全部可达")

# 2) 零字节文件（截断的典型特征）
zero = []
for r, _, fs in os.walk(PKG):
    for f in fs:
        fp = os.path.join(r, f)
        try:
            if os.path.getsize(fp) == 0:
                zero.append(os.path.relpath(fp, PKG))
        except OSError:
            zero.append(os.path.relpath(fp, PKG) + " (读不到)")
print("零字节/读不到的文件：%d" % len(zero))
for z in zero[:10]:
    print("  [X] %s" % z)
if zero:
    fails.append("存在 %d 个零字节文件" % len(zero))

# 3) 关键大文件的大小下限（截断会露馅）
MINS = {
    "体能训练动作演示/体感跟练模型.glb": 100 * 1024,
    "体能训练动作演示/开合跳.mp4": 100 * 1024,
    "体能训练动作演示/中场休息.mp4": 100 * 1024,
    "vendor/mediapipe/pose_landmark_lite.tflite": 100 * 1024,
    "assets/vendor/three.min.js": 100 * 1024,
    "index.html": 10 * 1024,
    "app.js": 100 * 1024,
    "styles.css": 50 * 1024,
    "data/tasks.js": 10 * 1024,
    "启动.bat": 3 * 1024,
}
for rel, mn in MINS.items():
    fp = os.path.join(PKG, rel.replace("/", os.sep))
    sz = os.path.getsize(fp) if os.path.isfile(fp) else -1
    ok = sz >= mn
    print("  [%s] %-45s %s" % ("OK" if ok else "X", rel, ("%d 字节" % sz) if sz >= 0 else "缺失"))
    if not ok:
        fails.append("文件过小或缺失：%s (%s)" % (rel, sz))

# 4) 汇总
total = sum(os.path.getsize(os.path.join(r, f))
            for r, _, fs in os.walk(PKG) for f in fs)
nfiles = sum(len(fs) for _, _, fs in os.walk(PKG))
print()
print("包：%d 个文件，%.1f MB" % (nfiles, total / 1024.0 / 1024.0))
if fails:
    print("!! 复检未通过：%d 项 !!" % len(fails))
    sys.exit(1)
print("[OK] 崩溃后复检通过：包完好")
sys.exit(0)
