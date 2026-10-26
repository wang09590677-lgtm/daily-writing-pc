# -*- coding: utf-8 -*-
"""生成「今日训练」开练前的语音素材。

需求原文：
  每个运动开始前需要说"准备开始进行***动作，请就位"，然后人声倒数数 1、2、3 再开始。

产物（落到 assets/coach/）：
  ready-<exId>.mp3   每个动作一句「准备开始进行XX，请就位」
  count-1/2/3.mp3    人声「一」「二」「三」
  count-go.mp3       人声「开始」
  guide-wrong.mp3    训练中动作没做到位（幅度不够、没达标）时的一句「动作不正确」

为什么要预生成 mp3 而不是 speechSynthesis：
  单机版是 file:// 双击打开的，浏览器语音合成在不同机器上音色差别极大，
  有的机器根本没装中文语音。这与 voice-guide.js / coach-timer.js 走的是同一条路子。

为什么不把「1、2、3」合成到一句里：
  倒计时必须和计时器同步（每秒一声、屏幕上数字同步跳），
  合成一整句就没法在数字变化的那一刻精确对齐了。
"""
import asyncio
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "assets", "coach")

# 动作 id -> 播报用名称。从 data/fitness-plan.js 里抄出来，
# 只为了播报时能读得顺口（"关节绕环"比 exId 好看，也不能有 emoji）。
EX_NAMES = {
    "jointCircle": "关节绕环",
    "marchInPlace": "原地踏步",
    "dynamicKick": "动态踢腿",
    "halfSquatWarm": "半蹲热身",
    "jumpingJacks": "开合跳",
    "fastFeet": "原地小步跑",
    "highKnees": "原地高抬腿跑",
    "buttKicks": "后踢腿跑",
    "jumpRope": "跳绳",
    "wallSit": "靠墙静蹲",
    "squat": "徒手深蹲",
    "lunge": "弓步蹲",
    "calfRaise": "提踵",
    "gluteBridge": "臀桥",
    "stepUp": "台阶踏步",
    "plank": "平板支撑",
    "abWheel": "跪姿健腹轮",
    "mountainClimber": "登山跑",
    "deadBug": "死虫式",
    "burpee": "波比跳",
    "lateralHop": "侧向跳",
    "sideShuffle": "侧滑步",
    "singleLegBalance": "单腿站立",
    "sitReach": "坐姿体前屈",
    "calfStretch": "小腿拉伸",
    "quadStretch": "大腿前侧拉伸",
    "hamStretch": "大腿后侧拉伸",
    "hipStretch": "髋部拉伸",
    "backStretch": "腰背拉伸",
    "breathe": "深呼吸放松",
    "fullStretch": "全身拉伸",
    # 循环块（周六"综合挑战日"）不是单一动作，没有 ex 字段。
    # 不给它一个 id 的话口令文件名会变成 ready-.mp3（不存在）→ 孩子只听到数数。
    # 播报名称要和浮层标题（fitTimer.name = "循环训练"）一致，孩子听到和看到的是同一个词。
    "circuit": "循环训练"
}

# 倒计时：中文单字读出来最干脆，孩子听得清是哪一下
COUNT_LINES = [
    ("count-1.mp3", "一", "+10%", "+40Hz"),
    ("count-2.mp3", "二", "+10%", "+40Hz"),
    ("count-3.mp3", "三", "+10%", "+40Hz"),
    ("count-go.mp3", "开始", "+22%", "+45Hz"),
]

# 「达标完成 / 项间休息 / 全套完成」三句。
# 需求原文：「当次数或时间达标后自动提醒项目完成，然后这个项目就算完了，自动开始下一项」
# 原素材里只有 finish.mp3（"完美结束"），是**整套**结束时用的，
# 单项目达标时播它会误导孩子以为今天就练完了，所以单独做了这三句。
#
# ⚠️ 文件名必须带 `guide-` 前缀：这几句走 VoiceGuide 播放（voice-guide.js
#    里 PREFIX="guide-" 是写死的），不带前缀会变成 404 无声 —— 实测踩过，
#    motion-browser-test 的"无控制台报错"那条会直接抓到 15 条 ERR_FILE_NOT_FOUND。
DONE_LINES = [
    ("guide-doneitem.mp3", "项目完成，休息一下", "+2%", "+30Hz"),
    ("guide-donerest.mp3", "休息一下，准备进行下一个项目", "-2%", "+20Hz"),
    ("guide-doneall.mp3", "太棒了，今天的训练全部完成", "+10%", "+40Hz"),
]

# 动作纠正：孩子做动作时幅度不够、这一下不算数，播一句「动作不正确」。
#
# 为什么归到本脚本（而不是开场校准那 15 句所在的 gen-guide-audio.py）：
#   这句是在**训练中**响的，此刻孩子耳朵里一直是本脚本这套 Yunjian 教练腔
#   （ready-* / count-* / guide-done*）；换成开场校准那套 Xiaoxiao 女声，
#   会像做动作做到一半突然换了个人在说话。所以音色必须跟训练口令一致。
#
# rate/pitch 直接沿用上面 guide-doneitem 的值：同为"训练中随口提醒"的语气，
#   既不抢拍子也不拖沓，听起来和「项目完成」是同一个人在同一个状态下说的。
WRONG_LINES = [
    ("guide-wrong.mp3", "动作不正确。", "+2%", "+30Hz"),
]

VOICE_PREFERENCE = [
    "zh-CN-YunjianNeural",     # 体育解说风格，最贴合"教练口令"
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-YunyangNeural",
    "zh-CN-YunxiNeural",
]


async def pick_voice():
    import edge_tts
    # list_voices 需要联网，网络抖动时不该让整个生成失败 —— 直接退回首选语音名，
    # edge-tts 在真正合成时会自己校验名字是否存在。
    try:
        voices = await edge_tts.list_voices()
    except Exception as exc:
        print("!! 取语音列表失败(%s)，直接使用 %s" % (exc.__class__.__name__, VOICE_PREFERENCE[0]))
        return VOICE_PREFERENCE[0]
    zh = {v["ShortName"] for v in voices if str(v.get("Locale", "")).startswith("zh-CN")}
    for name in VOICE_PREFERENCE:
        if name in zh:
            return name
    for name in sorted(zh):
        return name
    return None


async def synth(filename, text, rate, pitch, voice, tries=4):
    """合成一句，失败自动重试。

    为什么要重试：edge-tts 走的是 wss://speech.platform.bing.com，
    部分网络（公司代理、跨境线路）会间歇性握手超时；一旦失败还会留下
    0 字节的残缺文件，被后续的"已存在就跳过"逻辑误当成已完成。
    所以这里失败时先删残file再重试，最后仍失败就明确报错，不静默成功。
    """
    import edge_tts
    out = os.path.join(OUT_DIR, filename)
    for attempt in range(1, tries + 1):
        if os.path.exists(out):
            os.remove(out)
        try:
            comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
            await comm.save(out)
        except Exception as exc:
            print("    第 %d/%d 次失败: %s" % (attempt, tries, exc.__class__.__name__))
            await asyncio.sleep(2.0)
            continue
        size = os.path.getsize(out) if os.path.exists(out) else 0
        if size > 1000:
            print("  写出 %s  (%d 字节)  文本=%s" % (filename, size, text))
            return True
        print("    第 %d/%d 次拿到空文件" % (attempt, tries))
        await asyncio.sleep(2.0)
    print("  !! 多次重试仍失败: %s" % filename)
    return False


async def run(only=None, force=False):
    voice = await pick_voice()
    if not voice:
        print("!! 没有找到 zh-CN 语音")
        return False
    print("使用语音:", voice)

    # 口令偏慢一点、清楚一点，孩子才来得及反应（倒计时更是不能快）
    jobs = []
    if not only or only == "ready":
        for ex_id, name in EX_NAMES.items():
            jobs.append(("ready-%s.mp3" % ex_id,
                         "准备开始进行%s，请就位" % name, "-4%", "+18Hz"))
    if not only or only == "count":
        jobs.extend(COUNT_LINES)
    if not only or only == "done":
        jobs.extend(DONE_LINES)
    if not only or only == "wrong":
        jobs.extend(WRONG_LINES)

    failed = []
    for filename, text, rate, pitch in jobs:
        out = os.path.join(OUT_DIR, filename)
        if os.path.exists(out) and os.path.getsize(out) > 1000 and not force:
            print("  跳过（已存在） %s" % filename)
            continue
        if not await synth(filename, text, rate, pitch, voice):
            failed.append(filename)

    if failed:
        print("\n!! 以下文件生成失败：%s" % ", ".join(failed))
        return False
    return True


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    only = sys.argv[1] if len(sys.argv) > 1 else None
    force = "--force" in sys.argv
    try:
        ok = asyncio.run(run(only, force))
    except Exception as exc:
        print("!! 生成失败:", exc)
        return 1
    if not ok:
        return 1
    print("\n完成，产物在", OUT_DIR)
    return 0


if __name__ == "__main__":
    sys.exit(main())
