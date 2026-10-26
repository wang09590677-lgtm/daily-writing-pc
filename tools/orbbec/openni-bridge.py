# -*- coding: utf-8 -*-
"""
Astra Pro 深度桥接服务
======================

浏览器（哪怕是 file:// 打开的页面）拿不到 USB 深度设备，只能拿到 UVC 彩色流。
所以这里起一个小服务：Python 用 OpenNI2 读深度 → 通过 WebSocket 推给页面，
motion-engine.js 就能拿到每像素的真实距离（毫米），做人形分割和动作判断。

协议
----
服务端监听 ws://127.0.0.1:8765

1) 连上先收到一条 JSON 文本：
   {"type":"hello","device":"Astra","serial":"...","width":640,"height":480,"fps":15,
    "registered":true}

   ★ registered 的含义很重要：
     true  = 深度帧已经过 D2C 重映射，落在**彩色相机坐标系**里。
             页面才能拿 MediaPipe 关键点的归一化 (x,y) 直接到深度图上采样。
     false = 深度还在自己的镜头坐标系里（视场角、内参都不同，还有基线视差），
             按 (x,y) 采样会取到错误位置的深度。

   ★★ registration 有个非常反直觉的时机要求（实测确认，别再踩）：
     * 深度流**还没创建**时去 setProperty(5, 1) -> status=4 (BAD_PARAMETER)，不生效；
     * 深度流**已经启动**之后再 set -> status=0，读回 1，真的重映射了；
     * 但**重启深度流会把 registration 重置回 OFF**。
     所以本服务把设 registration 放在"流启动之后、开始推帧之前"，
     并且一旦重启流就重新设一次（见 _run_once 里 apply_registration 的调用点）。

   ⚠️ 顺带记录两条实测结论，免得后人再花时间：
     * OBEXTENSION_ID_CAM_PARAMS(14) 在本机**读得出来但全是 NaN**
       （supports()=False），所以"自己用内参算映射"这条退路不存在；
     * OpenNI 的 COLOR 传感器**列得出模式但读 0 帧**（幽灵传感器），
       彩色只能走浏览器 UVC。这两点决定了 D2C 是唯一可行路径。

2) 之后每条都是 **二进制** 帧，小端：
   偏移   类型      含义
   0      uint32   宽
   4      uint32   高
   8      uint32   帧序号
   12     uint32   有效像素数（深度 > 0 的）
   16     uint32   最近距离 mm
   20     uint32   最远距离 mm
   24     uint16[] 深度图，行优先，单位毫米，0 表示没数据

3) 设备被重开时发一条 JSON：{"type":"reopen","reason":"..."}

用法
----
    python openni-bridge.py                  # 默认 640x480 @15fps，端口 8765
    python openni-bridge.py --res 320x240 --fps 30
    python openni-bridge.py --port 9000
    python openni-bridge.py --no-register    # 关掉 D2C（排查用）

需要：pip install websockets
"""

import sys
import os
import json
import time
import array
import struct
import asyncio
import argparse
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from openni2bind import (OpenNI2, Stream, pick_mode, ONI_SENSOR_DEPTH,
                         ONI_PIXEL_FORMAT_DEPTH_1_MM,
                         ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION)

try:
    import websockets
except ImportError:
    print("[X] 缺 websockets，先装：pip install websockets")
    sys.exit(1)

HEADER = struct.Struct("<6I")   # w, h, index, valid, minMM, maxMM
MAX_EMPTY = 45                  # 连续这么多帧全是 0 就认为设备卡了，重开


def apply_registration(oni, want):
    """把深度流对齐到彩色相机坐标系（D2C）。

    返回 True/False —— 是否**确认**生效（写成功且读回 1）。

    ⚠️ 时机是这里唯一容易搞错的地方（实测）：
       * 深度流还没创建时调用 -> status=4 BAD_PARAMETER，不生效；
       * 深度流已启动后调用   -> status=0，读回 1，画面真的被重映射了；
       * 重启深度流           -> registration 被重置回 OFF，必须重设。
    所以调用点必须放在 Stream(...) 之后。
    """
    if not want:
        return False
    try:
        st = oni.set_int_property(ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION, 1)
    except Exception as e:
        print("   [!] 设 D2C 异常: %s" % e, flush=True)
        return False
    time.sleep(0.2)
    try:
        back = oni.get_int_property(ONI_DEVICE_PROPERTY_IMAGE_REGISTRATION)
    except Exception:
        back = None
    if st == 0 and back == 1:
        print("   D2C 已开启：深度帧对齐到彩色相机坐标系", flush=True)
        return True
    print("   [!] D2C 未生效 status=%s readback=%s（按未对齐处理）" % (st, back),
          flush=True)
    return False


class DepthReader(threading.Thread):
    """后台线程：读深度 → 打包 → 交给 asyncio 队列"""

    def __init__(self, frame_q, loop, width, height, fps, want_register=True):
        super().__init__(daemon=True)
        self.q = frame_q
        self.loop = loop
        self.width = width
        self.height = height
        self.fps = fps
        self.want_register = want_register
        self.stop_flag = False
        self._last = 0.0
        self.state = {"fps": 0.0, "valid": 0, "reopen": 0, "note": "启动中",
                      "registered": False}

    # ---------- 线程主循环 ----------
    def run(self):
        while not self.stop_flag:
            try:
                self._run_once()
            except Exception as e:
                self.state["note"] = "异常: %s" % e
                print("   [!] 读深度异常: %s" % e, flush=True)
                time.sleep(1.5)

    def _run_once(self):
        oni = OpenNI2()
        if oni.initialize() != 0:
            self.state["note"] = "OpenNI 初始化失败"
            time.sleep(2)
            return
        dev = oni.open_first()
        if not dev:
            self.state["note"] = "没找到设备"
            oni.shutdown()
            time.sleep(2)
            return

        modes = oni.sensor_modes(ONI_SENSOR_DEPTH)
        mode = pick_mode(modes, self.width, self.height, 30,
                         ONI_PIXEL_FORMAT_DEPTH_1_MM)
        if not mode:
            mode = pick_mode(modes, 640, 480, 30, ONI_PIXEL_FORMAT_DEPTH_1_MM)
        try:
            st = Stream(oni, ONI_SENSOR_DEPTH, mode)
        except Exception as e:
            self.state["note"] = "开流失败: %s" % e
            oni.shutdown()
            time.sleep(2)
            return

        self.width = mode["w"]
        self.height = mode["h"]
        self.state["note"] = "运行中 %dx%d" % (self.width, self.height)
        self.state["device"] = dev["name"]
        self.state["serial"] = oni.get_string_property(3) or ""
        print("   深度流已启动 %dx%d@%d" % (mode["w"], mode["h"], mode["fps"]),
              flush=True)

        # ★ 必须在流启动**之后**设 D2C（见 apply_registration 的说明）。
        #   放在这里还有第二个好处：流被重开时这个分支会再走一遍，registration
        #   跟着重新设上——否则重开一次就悄悄退回未对齐状态了。
        self.state["registered"] = apply_registration(oni, self.want_register)

        gap = 1.0 / max(1, self.fps)
        empty = 0
        sent = 0
        t_mark = time.time()
        index = 0

        try:
            while not self.stop_flag:
                r = st.read(500)
                if not r:
                    continue
                now = time.time()
                if now - self._last < gap:
                    continue
                self._last = now

                buf, w, h, meta = r
                raw = bytes(buf)
                a = array.array("H")
                a.frombytes(raw)
                valid = len(a) - a.count(0) if sys.byteorder == "little" else 0

                mn = mx = 0
                if valid:
                    sample = a[::13]
                    nz = [v for v in sample if v]
                    if nz:
                        mn, mx = min(nz), max(nz)

                if valid == 0:
                    empty += 1
                else:
                    empty = 0

                index += 1
                payload = HEADER.pack(w, h, index, valid, mn, mx) + raw
                self._push(payload)

                sent += 1
                if now - t_mark >= 1.0:
                    self.state["fps"] = round(sent / (now - t_mark), 1)
                    self.state["valid"] = valid
                    sent = 0
                    t_mark = now

                if empty >= MAX_EMPTY:
                    self.state["reopen"] = self.state.get("reopen", 0) + 1
                    self.state["note"] = "连续 %d 帧无深度，重开设备" % empty
                    print("   [!] %s" % self.state["note"], flush=True)
                    self._push_json({"type": "reopen",
                                     "reason": "连续 %d 帧全空" % empty})
                    break
        finally:
            try:
                st.stop()
            except Exception:
                pass
            try:
                oni.shutdown()
            except Exception:
                pass
            time.sleep(0.6)

    # ---------- 把数据交给 asyncio ----------
    def _push(self, payload):
        def put():
            if self.q.full():
                try:
                    self.q.get_nowait()
                except Exception:
                    pass
            try:
                self.q.put_nowait(payload)
            except Exception:
                pass
        try:
            self.loop.call_soon_threadsafe(put)
        except Exception:
            pass

    def _push_json(self, obj):
        self._push(("__json__" + json.dumps(obj)).encode("utf-8"))


def make_handler(q, reader):
    """每个连进来的页面的处理"""

    async def handler(ws):
        await ws.send(json.dumps({
            "type": "hello",
            "device": reader.state.get("device", ""),
            "serial": reader.state.get("serial", ""),
            "width": reader.width,
            "height": reader.height,
            "fps": reader.fps,
            "registered": bool(reader.state.get("registered", False)),
            "note": reader.state.get("note", ""),
        }))
        print("   页面已连接（%s）" % (ws.remote_address,), flush=True)
        try:
            while True:
                payload = await q.get()
                if payload[:9] == b"__json__":
                    await ws.send(payload[9:].decode("utf-8"))
                else:
                    await ws.send(payload)
        except Exception:
            pass
        finally:
            print("   页面断开", flush=True)

    return handler


async def main_async(args):
    w, h = (int(x) for x in args.res.lower().split("x"))
    loop = asyncio.get_running_loop()
    q = asyncio.Queue(maxsize=2)

    reader = DepthReader(q, loop, w, h, args.fps,
                         want_register=not args.no_register)
    reader.start()

    async with websockets.serve(make_handler(q, reader), args.host, args.port,
                                max_size=None, ping_interval=None):
        print("=" * 60)
        print("  Astra Pro 深度桥接服务")
        print("  监听 ws://%s:%d   分辨率 %dx%d  推送 %d fps"
              % (args.host, args.port, w, h, args.fps))
        print("  D2C 对齐：%s" % ("开（深度对齐到彩色坐标系）"
                                 if not args.no_register else "关（排查用）"))
        print("  页面里连它就能拿到每像素毫米级深度。Ctrl+C 退出。")
        print("=" * 60, flush=True)
        try:
            while True:
                await asyncio.sleep(1.0)
                if args.verbose:
                    print("   fps=%.1f 有效像素=%d D2C=%s [%s]"
                          % (reader.state.get("fps", 0),
                             reader.state.get("valid", 0),
                             "on" if reader.state.get("registered") else "off",
                             reader.state.get("note", "")), flush=True)
        except asyncio.CancelledError:
            pass
    reader.stop_flag = True


def main():
    ap = argparse.ArgumentParser(description="Astra Pro 深度 → WebSocket 桥接")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--res", default="640x480", help="深度分辨率，如 320x240")
    ap.add_argument("--fps", type=int, default=15, help="推给页面的帧率")
    ap.add_argument("--no-register", action="store_true",
                    help="不设 D2C（深度不对齐到彩色）；只用于排查")
    ap.add_argument("--verbose", action="store_true", help="每秒打印状态")
    args = ap.parse_args()

    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print("\n已退出")
    return 0


if __name__ == "__main__":
    sys.exit(main())
