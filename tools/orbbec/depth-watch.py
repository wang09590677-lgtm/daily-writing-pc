# -*- coding: utf-8 -*-
"""
实时盯着深度看：有没有人、离多远、占画面多少。

专门用来回答"我要一直在摄像头前吗"这类问题：
跑起来之后你正常活动 —— 走开、喝水、再回来 —— 每行输出都会告诉你
系统当下的判断，能亲眼看到"走开→消失、回来→立刻出现"到底多快。

判据和 motion-engine.js 里的 depthPersonMask() 完全一致：
  比背景近 250mm 以上 + 距离在 700~6000mm 之间 = 人

用法：先跑 start-depth-bridge.bat，再：
    python depth-watch.py            # 一直看，Ctrl+C 停
    python depth-watch.py 40         # 只看 40 秒
"""

import sys
import os
import time
import array
import struct
import asyncio

import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
URL = "ws://127.0.0.1:8765"
HEADER = struct.Struct("<6I")

NEAR_MM = 250
MIN_PERSON_MM = 700
MAX_PERSON_MM = 6000


class Watcher(object):
    """判据与 motion-engine.js 的 depthPersonMask() 完全一致：
    找离相机最近的那一片，不用学背景。"""

    def feed(self, depth, w, h):
        """depth: list[int]，单位 mm。返回 (面积%, 最近距离mm, 提示)"""
        self.w, self.h = w, h
        n = len(depth)
        alive = [d for d in depth if d > 0]
        if len(alive) < n * 0.05:
            return 0.0, 0, "深度画面基本是空的 —— 摄像头被挡住了？"
        closest = min(alive)

        # 参考距离 d0 = 人可能距离范围里的 5% 分位数（不用最小值，怕噪点）
        cand = sorted(d for d in alive if MIN_PERSON_MM <= d <= MAX_PERSON_MM)
        if len(cand) < 40:
            return 0.0, 0, "太近了（最近的东西 %.2f 米）→ 往后退到 1.5~3 米" % (closest / 1000.0)
        d0 = cand[int(len(cand) * 0.05)]
        hi = d0 + max(500, d0 * 0.30)

        hits = 0
        near = 0
        for d in alive:
            if d0 <= d <= hi:
                hits += 1
                if not near or d < near:
                    near = d

        area = 100.0 * hits / n
        if hits < n * 0.01:
            if closest < MIN_PERSON_MM:
                return area, 0, "太近了（最近的东西 %.2f 米）→ 往后退到 1.5~3 米" % (closest / 1000.0)
            return area, 0, "没看到人 → 站到镜头前 1.5~3 米"
        if hits > n * 0.62:
            return area, 0, "分出来的东西太大了（%.0f%%）→ 多半把墙算进来了" % area
        return area, near, "看到你了"


async def main(seconds):
    w = Watcher()
    try:
        async with websockets.connect(URL, max_size=None) as ws:
            print("已连上 %s —— 你正常活动就行，看下面的变化（Ctrl+C 停）\n" % URL)
            print("  时间   有效%   人形面积%   距离      判断")
            print("  " + "-" * 56)
            t0 = time.time()
            last = ""
            last_print = 0.0
            while True:
                if seconds and time.time() - t0 > seconds:
                    break
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=3)
                except asyncio.TimeoutError:
                    continue
                if isinstance(msg, str) or len(msg) < 24:
                    continue
                dw, dh, idx, valid, mn, mx = HEADER.unpack_from(msg, 0)
                if len(msg) < 24 + dw * dh * 2:
                    continue
                a = array.array("H")
                a.frombytes(msg[24:24 + dw * dh * 2])

                # 降采样到 96x72：每格取最近值（和 depth-link.js 一样）
                GW, GH = 96, 72
                grid = [0] * (GW * GH)
                step = 2 if dw * dh > 200000 else 1
                for y in range(0, dh, step):
                    gy = min(GH - 1, y * GH // dh) * GW
                    row = y * dw
                    for x in range(0, dw, step):
                        v = a[row + x]
                        if not v:
                            continue
                        gi = gy + min(GW - 1, x * GW // dw)
                        if not grid[gi] or v < grid[gi]:
                            grid[gi] = v

                # 每一帧都要喂给 Watcher（背景是按帧学的，漏喂会把校准期拉长），
                # 只是打印按 0.4 秒节流，免得刷屏。
                area, near, note = w.feed(grid, GW, GH)
                now = time.time()
                if now - last_print < 0.4 and note == last:
                    continue
                last_print = now
                cov = 100.0 * sum(1 for v in grid if v) / len(grid)
                line = "  %5.1fs  %5.1f%%   %6.2f%%   %6s  %s" % (
                    now - t0, cov, area,
                    ("%.2f 米" % (near / 1000.0)) if near else "—", note)
                if note != last:
                    print(line + "   ← 状态变了")
                    last = note
                else:
                    print(line)
    except KeyboardInterrupt:
        print("\n停了")
    except Exception as e:
        print("[X] %s" % e)
        print("    先跑 start-depth-bridge.bat")
        return 1
    return 0


if __name__ == "__main__":
    secs = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    sys.exit(asyncio.run(main(secs)))
