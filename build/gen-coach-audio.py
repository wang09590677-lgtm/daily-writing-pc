# -*- coding: utf-8 -*-
"""生成体能训练计时器用的教练音频素材。

产物（落到 assets/coach/）：
  tick-tock.wav   2 秒无缝循环的钟表滴答声（第 0 秒"滴"，第 1 秒"答"）
  half.mp3        「坚持，还剩一半」
  finish.mp3      「完美结束」

为什么走"预生成文件 + <audio> 播放"而不是 Web Audio 现场合成：
  单机版是 file:// 双击打开的。实测这种环境下 AudioContext 的
  createMediaElementSource 输出会被静音，而 <audio> 元素播本地 mp3 正常
  （听音撰文模块整套就是这么做的）。所以音频一律预生成为文件。

滴答声为什么用纯 stdlib 合成：
  一声"滴"本质是极短的宽带瞬态 + 快速指数衰减，用几个高频正弦叠加
  一段白噪声就够了，不需要任何音频库。滴（高）答（低）交替才是钟表。
"""
import math
import os
import random
import struct
import subprocess
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(HERE), "assets", "coach")

SR = 44100
LOOP_SECONDS = 2.0          # 1 声"滴" + 1 声"答"，正好一秒一下
TICK_AT = 0.0
TOCK_AT = 1.0


def click(partials, noise_amp, decay, dur=0.07):
    """合成一声短促的敲击。partials=[(频率, 振幅)]，decay 是指数衰减时间常数。"""
    n = int(SR * dur)
    rnd = random.Random(20260928)
    out = [0.0] * n
    two_pi = 2.0 * math.pi
    for i in range(n):
        t = i / SR
        env = math.exp(-t / decay)
        s = 0.0
        for freq, amp in partials:
            s += amp * math.sin(two_pi * freq * t)
        s += noise_amp * (rnd.random() * 2.0 - 1.0)
        out[i] = s * env
    return out


def mix_into(buf, clip, at_seconds, gain=1.0):
    start = int(at_seconds * SR)
    for i, v in enumerate(clip):
        idx = start + i
        if 0 <= idx < len(buf):
            buf[idx] += v * gain


def make_tick_tock():
    total = int(SR * LOOP_SECONDS)
    buf = [0.0] * total

    # "滴"：偏高、干脆；"答"：偏低、稍闷 —— 高低交替才像钟表
    tick = click([(2600.0, 1.0), (3900.0, 0.55), (5600.0, 0.25)], noise_amp=0.85, decay=0.010)
    tock = click([(1900.0, 1.0), (2850.0, 0.55), (4100.0, 0.22)], noise_amp=0.75, decay=0.013)

    mix_into(buf, tick, TICK_AT, 1.0)
    mix_into(buf, tock, TOCK_AT, 0.92)

    peak = max(abs(v) for v in buf) or 1.0
    scale = 0.82 / peak
    frames = bytearray()
    for v in buf:
        s = v * scale
        if s > 1.0:
            s = 1.0
        elif s < -1.0:
            s = -1.0
        frames += struct.pack("<h", int(s * 32767))
    return bytes(frames)


def write_wav(path, frames):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(frames)


def has_ffmpeg():
    try:
        subprocess.run(["ffmpeg", "-version"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=True)
        return True
    except Exception:
        return False


# 教练语气：偏快、偏高，才有"激昂"的劲头
VOICE_LINES = [
    ("half.mp3", "坚持，还剩一半", "+18%", "+25Hz"),
    ("finish.mp3", "完美结束", "+18%", "+25Hz"),
]

# 优先用体育解说风格的男声，其次备选
VOICE_PREFERENCE = [
    "zh-CN-YunjianNeural",
    "zh-CN-YunxiNeural",
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-YunyangNeural",
]


def gen_voices():
    import asyncio
    import edge_tts

    async def pick_voice():
        voices = await edge_tts.list_voices()
        zh = {v["ShortName"] for v in voices if str(v.get("Locale", "")).startswith("zh-CN")}
        for name in VOICE_PREFERENCE:
            if name in zh:
                return name
        for name in sorted(zh):
            return name
        return None

    async def run():
        voice = await pick_voice()
        if not voice:
            print("!! 没有找到 zh-CN 语音，跳过语音生成")
            return False
        print("使用语音:", voice)
        for filename, text, rate, pitch in VOICE_LINES:
            out = os.path.join(OUT_DIR, filename)
            comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
            await comm.save(out)
            size = os.path.getsize(out)
            print("  写出 %s  (%d 字节)  文本=%s" % (filename, size, text))
        return True

    return asyncio.run(run())


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    frames = make_tick_tock()
    wav_path = os.path.join(OUT_DIR, "tick-tock.wav")
    write_wav(wav_path, frames)
    print("写出 tick-tock.wav (%d 字节, %.1f 秒)" % (os.path.getsize(wav_path), LOOP_SECONDS))

    if has_ffmpeg():
        mp3_path = os.path.join(OUT_DIR, "tick-tock.mp3")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path,
                        "-codec:a", "libmp3lame", "-b:a", "128k", mp3_path], check=True)
        print("转出 tick-tock.mp3 (%d 字节)" % os.path.getsize(mp3_path))
    else:
        print("（没有 ffmpeg，滴答声保留 wav，Chrome 可以直接播）")

    try:
        gen_voices()
    except Exception as exc:                       # 网络/接口问题不该让整个脚本失败
        print("!! 语音生成失败:", exc)
        return 1

    print("\n完成，产物在", OUT_DIR)
    return 0


if __name__ == "__main__":
    sys.exit(main())
