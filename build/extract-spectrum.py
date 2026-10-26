#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从真实录音里提取频谱包络，供前端绘制波形。

背景：直接双击打开（file://）时，浏览器会拦掉 fetch/XHR，并且把 Web Audio 的
AnalyserNode 静音（实测 peak=0），所以不能靠实时频谱分析。改为构建期预计算：
每个音效存 28 段频带形状 + 按 0.2 秒一帧的能量包络，运行时按播放进度取帧。

产物：assets/audio/spectrum.js  ->  window.AUDIO_SPECTRUM = {...}
"""
import os, io, json, shutil, subprocess, glob
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
AUDIO = os.path.join(ROOT, "assets", "audio")
OUT = os.path.join(AUDIO, "spectrum.js")
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"

SR = 8000            # 降采样到 8k，足够覆盖语音/环境声主要能量
FRAME = 512
HOP = 256
BANDS = 28
FRAME_SEC = 0.2      # 包络帧间隔
F_LO, F_HI = 60.0, 3600.0

def decode(path):
    cmd = [FFMPEG, "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR),
           "-f", "s16le", "-"]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0 or len(r.stdout) < SR:
        return None
    return np.frombuffer(r.stdout, dtype="<i2").astype(np.float32) / 32768.0

def analyse(x):
    if len(x) < FRAME * 2:
        return None, None
    n_frames = 1 + (len(x) - FRAME) // HOP
    idx = np.arange(FRAME)[None, :] + HOP * np.arange(n_frames)[:, None]
    seg = x[idx] * np.hanning(FRAME)[None, :]
    spec = np.abs(np.fft.rfft(seg, axis=1))            # (frames, bins)
    freqs = np.fft.rfftfreq(FRAME, 1.0 / SR)

    edges = np.geomspace(F_LO, min(F_HI, SR / 2 - 1), BANDS + 1)
    bands = np.zeros(BANDS, dtype=np.float64)
    for i in range(BANDS):
        m = (freqs >= edges[i]) & (freqs < edges[i + 1])
        if m.any():
            bands[i] = spec[:, m].mean()
    if bands.max() > 0:
        bands = bands / bands.max()

    rms = np.sqrt((seg ** 2).mean(axis=1))
    per = max(1, int(round(FRAME_SEC * SR / HOP)))
    k = len(rms) // per
    env = rms[:k * per].reshape(k, per).mean(axis=1) if k else rms
    if env.max() > 0:
        env = env / env.max()
    # 轻微平滑，避免闪烁
    if len(env) > 2:
        env = np.convolve(env, np.array([0.25, 0.5, 0.25]), mode="same")
        env = env / max(env.max(), 1e-6)

    dur = len(x) / SR
    return (np.clip(bands * 255, 0, 255).astype(int).tolist(),
            np.clip(env * 255, 0, 255).astype(int).tolist(), round(dur, 2))

def main():
    files = sorted(glob.glob(os.path.join(AUDIO, "*.mp3")))
    out = {}
    for p in files:
        pid = os.path.splitext(os.path.basename(p))[0]
        x = decode(p)
        if x is None:
            print("skip (decode fail):", pid, flush=True)
            continue
        bands, env, dur = analyse(x)
        if bands is None:
            print("skip (too short):", pid, flush=True)
            continue
        out[pid] = {"bands": bands, "env": env, "dur": dur, "frameSec": FRAME_SEC}
        print("%-15s dur=%5.2fs bands=%2d env=%3d frames" % (pid, dur, len(bands), len(env)), flush=True)

    body = json.dumps(out, separators=(",", ":"), ensure_ascii=False)
    js = ("/* 听音撰文 · 频谱包络（由 build/extract-spectrum.py 从真实录音预计算）\n"
          " * 每项：bands[28] 频带形状、env[n] 每 0.2 秒一帧的能量、dur 时长\n"
          " * 直接双击打开（file://）时浏览器会静音 AnalyserNode，因此波形靠这份数据驱动。\n"
          " */\nwindow.AUDIO_SPECTRUM = " + body + ";\n")
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(js)
    print("\n写出 %s  (%d 个音效, %.1f KB)" % (OUT, len(out), os.path.getsize(OUT) / 1024))

if __name__ == "__main__":
    main()
