# -*- coding: utf-8 -*-
"""
生成「真人数据抓取」的语音引导包（替代滴滴声）。

为什么改用语音：
  滴滴声只能表达"有事发生"，表达不了"该做什么"。站在 2.5~3 米外、
  背对屏幕时，长音和短音的区别很容易听错，一旦听错就白录一组。
  语音能直接说"请把两只手向左右两边伸平"，不存在理解歧义。

产物：tools/orbbec/voices/<key>.wav
  用 22050Hz 单声道 WAV（winsound.PlaySound 只认 WAV，且文件小、播得稳）

音色：zh-CN-YunyangNeural（播报腔，吐字清楚，适合下指令）
  不用激昂的 Yunjian——这是操作指令，清晰 > 有气势；语速也刻意放慢。

依赖（仅构建期需要，产物落地后完全离线）：edge-tts + ffmpeg
"""

import os
import subprocess
import asyncio
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "voices")

VOICE = "zh-CN-YunyangNeural"
RATE = "-4%"          # 比默认稍慢，指令要听得清
PITCH = "+0Hz"

# ---------------- 台词表 ----------------
# 设计原则：
#  1) 每条都自解释——不用记忆"几声"代表什么；
#  2) 动作描述带比喻（"像飞机的翅膀"），避免"平举"这种抽象词被误解；
#  3) 关键动作同时说"做什么"和"保持不动"。
LINES = [
    # 开场
    ("intro",
     "真人数据录制，现在开始。接下来每一步，我都会用说话告诉你该怎么做。"),

    # 第 1 步：空房基准
    ("leave1",
     "现在请你离开画面，走到镜头看不到的地方，让镜头只看房间。你有十二秒。"),
    ("leave_ok",
     "请离开画面。"),
    ("baseline_ok",
     "空房间基准录制完成。"),
    ("baseline_bad",
     "注意，基准里好像有人的影子。请回到电脑前，重新运行一次。"),

    # 第 2 步：站位
    ("go_stand",
     "现在请走到离镜头两米半到三米的地方，大约三大步。"
     "要让全身都进画面，头顶留一点空，脚也要看得见。站好以后就不要动了。"),

    # 倒数
    ("c5", "五"), ("c4", "四"), ("c3", "三"), ("c2", "二"), ("c1", "一"),

    # 姿势 1
    ("pose1",
     "第一组。请把两只手臂自然垂下来，贴在身体两边，站直。"),
    ("hold",
     "保持不动。"),
    ("got1", "第一组很好。"),

    # 姿势 2 —— 最容易理解错的一组，说得最细
    ("pose2",
     "第二组。请把两只手向左右两边伸平，像飞机的翅膀一样，"
     "手臂要伸直，举到跟肩膀一样高。"),
    ("got2", "第二组很好。"),

    # 姿势 3
    ("pose3",
     "第三组。请把两只手臂再放下来，自然垂在身体两边，站直。"),
    ("got3", "第三组很好。"),

    # 重试
    ("retry",
     "刚才没有拍到你。请回到画面中间，保持全身都在画面里，我们再来一次。"),

    # 第 4 步
    ("leave2",
     "最后一步，请你再离开画面一次，走到镜头看不到的地方。你有十二秒。"),
    ("checking", "正在核对空房间。"),

    # 收尾
    ("success",
     "全部完成，数据有效。你可以回到电脑前，告诉助手一声，好了。"),
    ("fail",
     "数据不完整，需要重来。请回到电脑前，告诉助手一声。"),
]


def trim_silence(path, thresh=220, lead_ms=60, trail_ms=200):
    """裁掉首尾静音。

    必须做：edge-tts 每条都带 ~0.24s 头部 + 最长 1.5s 尾部静音。
    实测"五"文件 1.87s，实际人声只有 0.22s（0.19~0.41s）——
    不裁的话倒计时每个数字空等 1.6 秒，而且"保持不动"要等 1.4 秒才出声，
    采集早就开始了。裁完只保留 60ms 头 + 200ms 尾，听起来自然。
    """
    import wave
    import array
    w = wave.open(path, "rb")
    sr = w.getframerate()
    ch = w.getnchannels()
    sw = w.getsampwidth()
    n = w.getnframes()
    raw = w.readframes(n)
    w.close()
    if sw != 2 or n == 0:
        return 0.0
    a = array.array("h")
    a.frombytes(raw)
    mono = a if ch == 1 else a[0::2]
    N = len(mono)
    s = 0
    while s < N and abs(mono[s]) < thresh:
        s += 1
    e = N - 1
    while e > s and abs(mono[e]) < thresh:
        e -= 1
    if s >= e:
        return 0.0
    lead = int(sr * lead_ms / 1000.0)
    trail = int(sr * trail_ms / 1000.0)
    seg = mono[max(0, s - lead):min(N, e + 1 + trail)]
    out = wave.open(path, "wb")
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(sr)
    out.writeframes(seg.tobytes())
    out.close()
    return len(seg) / float(sr)


async def synth(key, text, voice):
    import edge_tts
    mp3 = os.path.join(OUT, "_%s.mp3" % key)
    wav = os.path.join(OUT, "%s.wav" % key)
    comm = edge_tts.Communicate(text, voice, rate=RATE, pitch=PITCH)
    await comm.save(mp3)
    # 转成 22050Hz 单声道 WAV（winsound 只认 WAV）
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", mp3,
         "-ar", "22050", "-ac", "1", "-sample_fmt", "s16", wav],
        check=True)
    os.remove(mp3)
    dur = trim_silence(wav)
    return wav, dur


async def pick_voice():
    """按偏好挑第一个可用的中文音色；都不行就留空（跳过）"""
    import edge_tts
    try:
        voices = await edge_tts.list_voices()
    except Exception as e:
        print("  [!] 取音色列表失败，直接用 %s：%s" % (VOICE, e))
        return VOICE
    have = {v["ShortName"] for v in voices
            if str(v.get("Locale", "")).startswith("zh-CN")}
    for pref in (VOICE, "zh-CN-YunjianNeural", "zh-CN-XiaoxiaoNeural",
                 "zh-CN-YunxiNeural"):
        if pref in have:
            return pref
    return sorted(have)[0] if have else None


def main():
    if not os.path.isdir(OUT):
        os.makedirs(OUT)
    voice = asyncio.run(pick_voice())
    if not voice:
        print("[X] 没有任何 zh-CN 音色可用，无法生成")
        return 1
    print("音色: %s   语速: %s" % (voice, RATE))
    print("输出: %s" % OUT)
    print("")

    ok = 0
    for key, text in LINES:
        try:
            p, dur = asyncio.run(synth(key, text, voice))
            print("  [OK] %-12s %5.2fs  %s" % (key, dur, text[:30]))
            ok += 1
        except Exception as e:
            print("  [X]  %-12s 失败: %s" % (key, e))

    print("")
    print("完成 %d/%d" % (ok, len(LINES)))
    return 0 if ok == len(LINES) else 2


if __name__ == "__main__":
    sys.exit(main())
