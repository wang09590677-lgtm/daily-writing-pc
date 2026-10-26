# -*- coding: utf-8 -*-
"""生成「体感跟练 · 开场骨骼识别」用的中文引导语音。

产物（落到 assets/coach/）：
  guide-welcome.mp3  开场：请站到摄像头前面
  guide-nobody.mp3   画面里没人
  guide-left.mp3     往左移
  guide-right.mp3    往右移
  guide-closer.mp3   往前走近
  guide-back.mp3     往后退
  guide-head.mp3     头没进画面
  guide-feet.mp3     脚没进画面
  guide-arms.mp3     把手张开
  guide-bright.mp3   画面太暗
  guide-hold.mp3     很好，保持不动
  guide-good.mp3     识别成功
  guide-lost.mp3     中途跟丢

为什么必须预生成为 mp3 文件：
  单机版是 file:// 双击打开的，fetch / XHR 读本地文件会被 CORS 拦死，
  AudioContext.createMediaElementSource 的输出也会被静音。唯一稳的路是
  <audio> 元素直接播本地 mp3（听音撰文、教练计时器都是这么做的）。

为什么用 edge-tts：
  免费、免 API Key，中文女声自然度足够。文件缺失时的兜底仍然是
  speechSynthesis（见 voice-guide.js），所以生成失败也不会让功能消失。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(HERE), "assets", "coach")

# 引导语要温柔、清楚、短——孩子站错了要立刻知道往哪边挪，
# 一句话超过 10 个字就来不及反应了。
VOICE_LINES = [
    ("guide-welcome.mp3", "欢迎来到体感跟练，请站到摄像头前面，让我看看你。", "+12%", "+12Hz"),
    ("guide-nobody.mp3", "还没有看到你，请走到摄像头前面，站到画面中间。", "+10%", "+10Hz"),
    # 画面是镜像的（孩子抬右手，画面里也是右手）。说"你的左边"孩子要反应一下，
    # 说"屏幕的左边"直接照着做就行，不用换算。
    ("guide-left.mp3", "请往屏幕的左边移动一点。", "+12%", "+12Hz"),
    ("guide-right.mp3", "请往屏幕的右边移动一点。", "+12%", "+12Hz"),
    ("guide-closer.mp3", "请往前走近一点。", "+12%", "+12Hz"),
    ("guide-back.mp3", "请往后退一点，让全身都进画面。", "+12%", "+12Hz"),
    ("guide-head.mp3", "看不到你的头，请往后退一点。", "+12%", "+12Hz"),
    ("guide-feet.mp3", "看不到你的脚，请往后退一点。", "+12%", "+12Hz"),
    ("guide-arms.mp3", "请把双手张开一点，举到肩膀那么高。", "+12%", "+12Hz"),
    ("guide-bright.mp3", "画面有点暗，请把房间的灯打开。", "+10%", "+10Hz"),
    ("guide-hold.mp3", "很好，保持不动，正在锁定你的骨骼。", "+12%", "+12Hz"),
    ("guide-good.mp3", "识别成功，我们开始吧！", "+16%", "+18Hz"),
    ("guide-lost.mp3", "跟丢你了，请回到画面中间。", "+10%", "+10Hz"),
    # —— 空房扫描（房间结构基线）用的两句 ——
    # 引擎要先在没有人的时候量一遍房间（墙/地板/家具的深度），
    # 之后才能用"和空房不一样的地方"来认人。
    ("guide-roomscan.mp3", "我要先记一下房间的样子，请你先退到画面外面，不要被拍到。", "+8%", "+8Hz"),
    ("guide-roomok.mp3", "好了，我记住房间了。请站到摄像头前面，让我看看你。", "+12%", "+12Hz"),
]

# 优先用亲切的女声；Yunjian 是体育解说腔，放引导语里太硬
VOICE_PREFERENCE = [
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-XiaoyiNeural",
    "zh-CN-YunxiNeural",
    "zh-CN-YunjianNeural",
]


def gen():
    import asyncio
    import edge_tts

    async def pick_voice():
        voices = await edge_tts.list_voices()
        zh = {v["ShortName"] for v in voices if str(v.get("Locale", "")).startswith("zh-CN")}
        for name in VOICE_PREFERENCE:
            if name in zh:
                return name
        return sorted(zh)[0] if zh else None

    async def run():
        voice = await pick_voice()
        if not voice:
            print("!! 没有找到 zh-CN 语音")
            return False
        print("使用语音:", voice)
        ok = 0
        for filename, text, rate, pitch in VOICE_LINES:
            out = os.path.join(OUT_DIR, filename)
            try:
                comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
                await comm.save(out)
                print("  写出 %-20s %6d 字节  %s" % (filename, os.path.getsize(out), text))
                ok += 1
            except Exception as exc:
                print("  !! %s 失败: %s" % (filename, exc))
        print("完成 %d/%d" % (ok, len(VOICE_LINES)))
        return ok == len(VOICE_LINES)

    return asyncio.run(run())


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    try:
        return 0 if gen() else 1
    except Exception as exc:
        print("!! 语音生成失败:", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
