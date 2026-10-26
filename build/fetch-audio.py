#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从 Openverse 抓取 CC0 / 公有领域的真实录音，替换听音撰文原来的合成音。

- 免 API Key：https://api.openverse.org/v1/audio/
- 只要 cc0 / pdm 授权，避免署名义务
- 产物：assets/audio/<基元id>.mp3 + assets/audio/credits.json

用法:
  python fetch-audio.py            # 抓全部缺失的
  python fetch-audio.py --only bird,rain --force
"""
import os, sys, io, json, time, shutil, argparse, subprocess, tempfile, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUTDIR = os.path.join(ROOT, "assets", "audio")
os.makedirs(OUTDIR, exist_ok=True)
CREDITS = os.path.join(OUTDIR, "credits.json")
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"
MAX_SEC = 34          # 每段裁到最长 34 秒（场景最长 34s）
LEAD_IN = 2.0         # 默认从第 2 秒开始取，跳过起音/淡入（短素材会自动放弃前导裁剪）
MIN_SRC = 6.0         # 源素材短于该秒数时完全不裁前导，避免成品只剩 1~2 秒
MUSIC_IDS = {"piano", "flute", "strings", "drum", "radio", "bell", "schoolbell",
             "guzheng", "erhu", "dizi", "opera", "gong", "templebell", "windchime",
             "alarmclock", "doorbell"}

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
MAX_DL = 8 * 1024 * 1024    # 只下前 8MB —— 裁 34 秒足够，避免为一段声音拉 40MB

# 基元 -> (检索词, 最短秒, 最长秒, 允许音乐类结果[, 排除词])
SOUNDS = {
 "room":             ("room tone quiet indoor ambience", 10, 120, False),
 "crowd":            ("crowd talking people chatter ambience", 10, 120, False),
 "wind":             ("wind blowing ambience", 10, 180, False),
 "bird":             ("birds singing forest dawn", 10, 180, False),
 "water":            ("small stream water flowing", 10, 180, False),
 "footsteps":        ("footsteps walking floor", 4, 60, False),
 "machine":          ("electric motor hum", 8, 120, False,
                      ["scifi", "sci-fi", "space", "alien", "generator_lp", "lp loop"]),
 "traffic":          ("city traffic street ambience", 10, 180, False),
 "insect":           ("crickets insects night", 8, 180, False),
 "children":         ("children playing playground", 5, 120, False),
 "leaves":           ("forest trees wind ambience", 5, 120, False),
 "drum":             ("snare drum", 5, 90, True,
                      ["rattle", "toy", "djembe", "hand drum", "bongo",
                       "dubstep", "electronic", "analog", "kit"]),
 "rain":             ("rain falling", 10, 180, False),
 "whistle":          ("referee whistle", 2, 60, False,
                      ["wind", "reverb", "train", "steam", "kettle", "bird",
                       "creature", "machinery", "monster", "growl", "horror",
                       "football", "college", "crowd", "cheer", "stadium", "match",
                       "audience", "fans", "game"]),
 "radio":            ("radio static tuning", 3, 60, False),
 "engine":           ("car engine idle", 4, 90, False),
 "bell":             ("bell ringing", 2, 40, False),
 "clock":            ("clock ticking", 5, 120, False),
 "strings":          ("orchestra string section tuning", 5, 120, True),
 "kitchen":          ("kitchen cooking dishes", 5, 90, False),
 "applause":         ("applause clapping crowd", 3, 60, False),
 "market":           ("market street crowd vendor", 8, 120, False),
 "piano":            ("piano melody", 5, 120, True),
 "thunder":          ("thunder rumble storm", 3, 60, False),
 "flute":            ("flute play", 5, 90, True,
                      ["dizi", "bamboo", "native", "indian", "bansuri", "chinese",
                       "music box", "machine", "historic", "piano", "egypt",
                       "horror", "dark", "thriller", "ethno", "abstract",
                       "industrial", "train", "sample", "shakuhachi", "japan",
                       "drone", "champagne", "glass"]),
 "frog":             ("frogs croaking pond", 5, 120, False),
 "sea":              ("ocean waves beach", 10, 180, False),
 "horn":             ("car horn honk", 8, 20, False),
 "plane":            ("airplane flyover", 4, 60, False),
 "train":            ("train passing railway", 5, 90, False),
 "dog":              ("dog barking", 2, 40, False),
 "heartbeat":        ("heartbeat", 3, 60, False),
 "door":             ("door open close creak", 1, 30, False),
 "cat":              ("cat meowing", 1, 30, False),
 "rocket":           ("rocket engine thrust space launch", 3, 60, False),
 "schoolbell":       ("school bell ring", 2, 40, False),
 "waterfall":        ("waterfall", 8, 180, False),
 "sirenPolice":      ("police siren", 5, 60, False,
                      ["imitation", "mouth", "human", "voice",
                      "train", "traffic", "synth", "cartoonish", "city"]),
 "sirenAmbulance":   ("ambulance siren", 2, 60, False),
 "fire":             ("fire crackling campfire", 5, 120, False),
 "phone":            ("telephone ringing", 2, 40, False),
 "bee":              ("bees buzzing", 3, 90, False),
}

# 第二批：扩充音效库（更贴近中国孩子日常 / 校园 / 自然 / 节庆）
SOUNDS_EXT = {
 "rooster":          ("rooster crowing", 2, 30, False),
 "cicada":           ("cicada summer insects", 5, 120, False),
 "duck":             ("duck quacking", 8, 40, False),
 "chicken":          ("chicken clucking", 2, 40, False),
 "cow":              ("cow mooing", 8, 60, False,
                      ["gate", "squeak", "whine", "fence", "metal", "barn door",
                       "machine", "milking", "milker", "farm equipment",
                       "scream", "slaughter", "pain", "distress"]),
 "horse":            ("horse hooves walking", 3, 60, False),
 "sheep":            ("sheep bleating", 2, 40, False),
 "owl":              ("owl hooting", 8, 60, False,
                      ["park", "walk", "distant", "crowd", "people", "traffic",
                      "dog", "barking", "campfire"]),
 "seagull":          ("seagull calls", 2, 60, False),
 "magpie":           ("magpie crow bird call", 2, 60, False),
 "windchime":        ("wind chimes", 5, 120, True),
 "templebell":       ("temple bell", 8, 90, True,
                      ["ambience", "ambient", "atmosphere", "crowd", "street"]),
 "gong":             ("chinese gong crash", 8, 30, True,
                      ["bowl", "tibetan", "singing"]),
 "guzheng":          ("guzheng chinese zither", 5, 120, True),
 "erhu":             ("erhu music", 10, 120, True,
                      ["D4", "single note", "tuning", "sample",
                       "japanese", "menu", "dojo", "koto", "game"]),
 "dizi":             ("chinese bamboo flute", 5, 120, True),
 "firecracker":      ("firecrackers", 2, 40, False),
 "fireworks":        ("fireworks", 5, 60, False,
                      ["impact25", "single", "one shot"]),
 "templefair":       ("chinese street crowd market", 8, 120, False),
 "opera":            ("chinese opera", 5, 90, True),
 "mahjong":          ("mahjong tiles", 2, 40, False),
 "pingpong":         ("table tennis rally", 8, 40, False),
 "basketball":       ("basketball dribble bouncing", 2, 40, False),
 "jump_rope":        ("skipping rope", 2, 40, False),
 "swimming":         ("swimming water splash", 3, 60, False),
 "bicyclebell":      ("bicycle bell", 1, 20, False),
 "bus":              ("bus interior ride", 5, 90, False),
 "subway":           ("subway train interior", 5, 90, False),
 "shiphorn":         ("ship horn foghorn", 2, 40, False),
 "typing":           ("keyboard typing", 3, 60, False),
 "pageturn":         ("book page turning", 6, 20, False),
 "kettle":           ("kettle boiling water", 3, 60, False),
 "frying":           ("frying food sizzling", 3, 60, False),
 "chopping":         ("chopping vegetables knife", 2, 40, False),
 "dishes":           ("washing dishes water", 3, 60, False),
 "washingmachine":   ("washing machine", 5, 90, False),
 "vacuum":           ("vacuum cleaner", 5, 90, False),
 "alarmclock":       ("alarm clock ringing", 2, 30, True),
 "doorbell":         ("doorbell", 1, 20, True),
}

ALL_SOUNDS = dict(SOUNDS)
ALL_SOUNDS.update(SOUNDS_EXT)

def spec(pid):
    """归一化 (检索词, lo, hi, allow_music[, exclude]) -> 五元组"""
    v = ALL_SOUNDS[pid]
    return (v[0], v[1], v[2], v[3], list(v[4]) if len(v) > 4 else [])

BAD = ["remix", "karaoke", "cover version", "podcast", "interview", "tutorial",
       "asmr eating", "audiobook", "speech", "lyrics", "ringtone remix"]

def get(url, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()

def get_capped(url, timeout=90, cap=MAX_DL):
    """限流量下载：带 Range 只要前 cap 字节，够裁出 34 秒即可。

    源库里常有 20~30 分钟的整段录音（实测有个 1749 秒 / 40MB 的候选，
    下载能拖十几分钟），这是抓取慢的主因。裁剪只需要开头几十秒，
    所以直接截断下载；ffmpeg 对截断的 mp3/wav/ogg 仍能正常解码。
    """
    h = dict(UA)
    h["Range"] = "bytes=0-%d" % (cap - 1)
    r = urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout)
    return r.read(cap)

def search(query, pages=2):
    out = []
    for page in range(1, pages + 1):
        q = urllib.parse.urlencode({"q": query, "license": "cc0,pdm",
                                    "page_size": 20, "page": page})
        try:
            d = json.loads(get("https://api.openverse.org/v1/audio/?" + q))
        except Exception as e:
            print("      search err:", type(e).__name__, e, flush=True)
            break
        out += d.get("results", [])
        time.sleep(0.8)
    return out

def search_wide(query, min_n=8):
    """Openverse 是全文检索，词越多命中越少（实测 5 词查询常常只剩 1 条结果）。

    结果太少时逐步收窄成 2 词、1 词再搜一轮，合并去重，给打分更多候选。
    """
    cands = search(query)
    parts = query.split()
    for n in (2, 1):
        if len(cands) >= min_n or len(parts) <= n:
            break
        seen = {c.get("id") for c in cands}
        for c in search(" ".join(parts[:n])):
            if c.get("id") not in seen:
                cands.append(c)
                seen.add(c.get("id"))
    return cands

def score(c, lo, hi, allow_music, words, exclude):
    t = (c.get("title") or "").lower()
    u = (c.get("url") or "")
    tags = " ".join([(x.get("name") or "") for x in (c.get("tags") or [])]).lower()
    s = 0
    hit = 0
    for w in words:
        # 标题命中权重最高：实测"referee whistle"里，球场观众录音的 tags 也带
        # referee/whistle，只有标题才区分得出"Referee whistle sound.wav"这类真音效
        if w in t:
            s += 5
            hit += 1
        elif len(w) > 4 and w[:4] in t:
            s += 3
            hit += 1
        if w in tags:
            s += 3
            hit += 1
        elif len(w) > 4 and w[:4] in tags:
            s += 2
            hit += 1
    # 标题和 tags 都没命中任何检索词，基本可以判定不相关
    if words and hit == 0:
        s -= 10
    dur = (c.get("duration") or 0) / 1000.0
    if lo <= dur <= hi:
        s += 5
    elif dur < lo:
        s -= 7
    elif dur > hi * 2:
        s -= 8          # 远超上限的整段录音（实测有 300 秒的），主体常跑偏
    else:
        s -= 1
    if dur >= 15:
        s += 2
    for b in BAD:
        if b in t:
            s -= 8
    if not allow_music:
        for b in ["music", "song", "melody", "instrumental", "beat"]:
            if b in t:
                s -= 6
    # 排除词：标题或 tags 命中即重罚，避免"风哨混响"当裁判哨、"科幻发生器"当电机这类错配
    for b in exclude:
        if b in t or b in tags:
            s -= 14
    if c.get("source") == "freesound":
        s += 1
    if u.endswith((".mp3", ".ogg", ".wav", ".flac", ".m4a")):
        s += 2
    # 体积：优先中小文件，巨型整段录音既慢又没必要（我们只裁开头几十秒）
    fs = c.get("filesize") or 0
    if fs > 30 * 1024 * 1024:
        s -= 20
    elif fs > 15 * 1024 * 1024:
        s -= 8
    elif 0 < fs <= 8 * 1024 * 1024:
        s += 3
    if c.get("mature"):
        s -= 50
    return s

def is_audio(b):
    if b[:3] == b"ID3" or b[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"\xff\xfa"):
        return "mp3"
    if b[:4] == b"OggS":
        return "ogg"
    if b[:4] == b"RIFF" and b[8:12] == b"WAVE":
        return "wav"
    if b[:4] == b"fLaC":
        return "flac"
    if b[4:8] == b"ftyp":
        return "m4a"
    return None

def probe_duration(path):
    """用 ffprobe 读源素材真实时长（秒）；失败返回 0"""
    try:
        r = subprocess.run([FFPROBE, "-v", "error", "-show_entries",
                            "format=duration", "-of", "csv=p=0", path],
                           capture_output=True, text=True, timeout=30)
        return float((r.stdout or "").strip() or 0)
    except Exception:
        return 0.0

def transcode(src, dst, music):
    """裁到 MAX_SEC 秒并压到合适码率，控制体积（原始文件常有 8MB/6 分钟）。

    前导裁剪自适应：短素材（< MIN_SRC 秒）完全不裁，否则只裁 min(LEAD_IN, 时长8%)，
    这样 4~10 秒的一次性音效（哨声、拨球、喇叭）不会只剩一两秒。
    """
    dur = probe_duration(src)
    if dur <= 0:
        lead = LEAD_IN
    elif dur < MIN_SRC:
        lead = 0.0
    else:
        lead = min(LEAD_IN, dur * 0.08)
    take = MAX_SEC if dur <= 0 else max(1.0, min(MAX_SEC, dur - lead))

    cmd = [FFMPEG, "-y", "-loglevel", "error",
           "-ss", ("%.2f" % lead), "-i", src, "-t", ("%.2f" % take),
           "-ac", "2" if music else "1",
           "-ar", "44100",
           "-b:a", "128k" if music else "96k",
           "-acodec", "libmp3lame", dst]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0 or not os.path.exists(dst) or os.path.getsize(dst) < 8000:
        # 有些源本身短于 LEAD_IN，去掉 -ss 重试
        cmd[cmd.index("-ss") + 1] = "0"
        r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0 or not os.path.exists(dst) or os.path.getsize(dst) < 8000:
        return None, (r.stderr or b"").decode("utf-8", "ignore")[:200], 0.0
    return os.path.getsize(dst), None, lead

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    credits = {}
    if os.path.exists(CREDITS):
        try: credits = json.load(open(CREDITS, encoding="utf-8"))
        except Exception: credits = {}

    ids = [x.strip() for x in a.only.split(",") if x.strip()] or list(ALL_SOUNDS.keys())
    ok = fail = 0
    for i, pid in enumerate(ids, 1):
        query, lo, hi, am, exclude = spec(pid)
        path = os.path.join(OUTDIR, pid + ".mp3")
        if not a.force and os.path.exists(path) and os.path.getsize(path) > 20000:
            print("[%2d/%2d] %-15s 已存在，跳过" % (i, len(ids), pid), flush=True)
            continue
        words = [w for w in query.lower().split() if len(w) > 2]
        cands = search_wide(query)
        if not cands:
            print("[%2d/%2d] %-15s 无搜索结果" % (i, len(ids), pid), flush=True)
            fail += 1
            continue
        cands.sort(key=lambda c: score(c, lo, hi, am, words, exclude), reverse=True)
        # 按相关性顺序取**第一个**能成功转码的候选。
        # 曾经试过"成品不够长就继续找更长的"，结果把正确的 3.3 秒裁判哨换成了
        # 34 秒的球场观众录音 —— 长度不能压过相关性。长度问题已由自适应前导裁剪
        # 在 transcode() 里解决，这里只用一个硬下限剔除明显无意义的超短采样。
        best = None
        for c in cands[:8]:
            url = c.get("url") or ""
            if not url:
                continue
            # 2.5 秒以下的采样片段对"听场景"毫无意义，直接跳过，别浪费一次下载
            if (c.get("duration") or 0) < 2500:
                continue
            try:
                data = get_capped(url, timeout=90)
            except Exception as e:
                print("      dl err:", type(e).__name__, e, flush=True)
                continue
            kind = is_audio(data)
            if not kind or len(data) < 20000:
                print("      skip (%s, %d bytes)" % (kind, len(data)), flush=True)
                continue
            tmp = tempfile.NamedTemporaryFile(suffix="." + kind, delete=False)
            tmp.write(data)
            tmp.close()
            tmpout = tmp.name + ".mp3"
            size, err, lead = transcode(tmp.name, tmpout, pid in MUSIC_IDS)
            src_dur = probe_duration(tmp.name)
            os.unlink(tmp.name)
            if err:
                print("      ffmpeg err:", err, flush=True)
                if os.path.exists(tmpout):
                    os.unlink(tmpout)
                continue
            out_dur = probe_duration(tmpout)
            if out_dur <= 0:
                os.unlink(tmpout)
                continue
            best = {"dur": out_dur, "size": size, "lead": lead,
                    "src": src_dur, "c": c, "tmp": tmpout, "url": url}
            break

        if not best:
            print("[%2d/%2d] %-15s 全部候选下载失败" % (i, len(ids), pid), flush=True)
            fail += 1
            time.sleep(0.6)
            continue

        shutil.move(best["tmp"], path)
        c = best["c"]
        credits[pid] = {"file": os.path.basename(path), "title": c.get("title"),
                        "creator": c.get("creator"), "license": c.get("license"),
                        "license_url": c.get("license_url"), "source": c.get("source"),
                        "landing": c.get("foreign_landing_url"), "url": best["url"],
                        "source_duration_s": round((c.get("duration") or 0) / 1000.0, 1),
                        "measured_src_s": round(best["src"], 1),
                        "lead_in_s": round(best["lead"], 2),
                        "clipped_s": round(best["dur"], 2), "bytes": best["size"]}
        print("[%2d/%2d] %-15s ok  源%7.1fs (lead %.1f) -> %5.1fs  %6.1fKB  %s" % (
            i, len(ids), pid, best["src"], best["lead"], best["dur"], best["size"] / 1024,
            (c.get("title") or "")[:44]), flush=True)
        ok += 1
        time.sleep(0.6)

    json.dump(credits, open(CREDITS, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("\n完成: 成功 %d / 失败 %d" % (ok, fail), flush=True)

if __name__ == "__main__":
    main()
