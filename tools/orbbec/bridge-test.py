# -*- coding: utf-8 -*-
"""
桥接服务自检：连上去收几帧，确认协议和深度数据都对。
用法：先跑 openni-bridge.py，再跑 python bridge-test.py
"""

import sys
import asyncio
import struct

import websockets

URL = "ws://127.0.0.1:8765"
HEADER = struct.Struct("<6I")


async def main():
    try:
        async with websockets.connect(URL, max_size=None) as ws:
            print("已连上 %s" % URL)
            hello = await asyncio.wait_for(ws.recv(), timeout=5)
            print("hello: %s" % hello)

            got = 0
            for _ in range(40):
                msg = await asyncio.wait_for(ws.recv(), timeout=6)
                if isinstance(msg, str):
                    print("文本消息: %s" % msg)
                    continue
                if len(msg) < 24:
                    print("[X] 帧太短：%d 字节" % len(msg))
                    return 1
                w, h, idx, valid, mn, mx = HEADER.unpack_from(msg, 0)
                body = len(msg) - 24
                ok_size = body == w * h * 2
                got += 1
                print("  帧#%-4d %dx%d 有效 %6d (%.1f%%) 距离 %d~%d mm  载荷 %d 字节 %s"
                      % (idx, w, h, valid, 100.0 * valid / (w * h), mn, mx,
                         body, "OK" if ok_size else "[X] 尺寸不符"))
                if got >= 5:
                    break

            if got == 0:
                print("[X] 一帧都没收到")
                return 1
            print("\n桥接服务正常 ✅")
            return 0
    except Exception as e:
        print("[X] 连不上或出错：%s" % e)
        print("   确认 openni-bridge.py 已经在跑")
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
