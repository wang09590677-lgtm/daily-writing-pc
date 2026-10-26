/* 听音撰文 · 离线音频合成引擎
 * 纯 Web Audio API 实时合成，不需要任何音频文件，完全离线可用。
 * 用法：
 *   AudioSceneEngine.play(scene)   // scene = { layers: [[primitive, gain, pan], ...], seconds }
 *   AudioSceneEngine.stop()
 *   AudioSceneEngine.getAnalyser()
 *   AudioSceneEngine.onstate = fn
 */
(function () {
  const PRIMITIVES = [
    "bird", "insect", "frog", "wind", "leaves", "water", "waterfall", "sea", "rain", "thunder",
    "engine", "traffic", "horn", "sirenPolice", "sirenAmbulance", "train", "plane", "rocket",
    "crowd", "market", "children", "applause", "schoolbell", "phone", "bell",
    "cat", "dog", "bee",
    "strings", "piano", "flute", "drum", "whistle",
    "clock", "footsteps", "door", "fire", "machine", "radio", "heartbeat", "kitchen", "room"
  ];

  let ctx = null;
  let master = null;
  let analyser = null;
  let noiseBuf = null;
  const liveSources = [];
  const liveNodes = [];
  let tickId = null;
  let endTimer = null;
  let playing = false;
  let currentScene = null;
  let stateCb = null;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;
    master.connect(analyser);
    analyser.connect(ctx.destination);
    return ctx;
  }

  function noiseBuffer() {
    if (!noiseBuf) {
      const len = Math.floor(ctx.sampleRate * 2);
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02; // 轻微粉噪化，听感更自然
        d[i] = white * 0.7 + last * 3;
      }
    }
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    return s;
  }

  function src(node) { liveSources.push(node); return node; }
  function node(n) { liveNodes.push(n); return n; }

  function out(gainVal, pan) {
    const gn = ctx.createGain();
    gn.gain.value = Math.max(0, gainVal == null ? 1 : gainVal);
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      gn.connect(p);
      p.connect(master);
      node(p);
    } else {
      gn.connect(master);
    }
    return node(gn);
  }

  function osc(type, freq, t0) {
    const o = ctx.createOscillator();
    o.type = type;
    if (freq) o.frequency.setValueAtTime(freq, t0);
    return o;
  }

  function filt(type, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q != null) f.Q.value = q;
    return node(f);
  }

  function lfo(rate, depth, target, t0) {
    const l = osc("sine", rate, t0);
    const lg = ctx.createGain();
    lg.gain.value = depth;
    l.connect(lg);
    lg.connect(target);
    l.start(t0);
    src(l);
    node(lg);
    return l;
  }

  // 包络：在 t0 开始，持续 dur 秒
  function env(t0, dur, peak, attack, release) {
    const gn = ctx.createGain();
    const a = attack == null ? 0.02 : attack;
    const r = release == null ? Math.min(0.25, dur * 0.4) : release;
    gn.gain.setValueAtTime(0.0001, t0);
    gn.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
    gn.gain.setValueAtTime(Math.max(0.0002, peak), Math.max(t0 + a, t0 + dur - r));
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    return node(gn);
  }

  const R = (a, b) => a + Math.random() * (b - a);

  /* ================= 声音基元 ================= */

  const P = {};

  // —— 自然 ——
  P.bird = (t0, dur, gain, pan) => {
    const o = out(gain * 0.55, pan);
    const n = 3 + Math.floor(R(0, 4));
    for (let i = 0; i < n; i++) {
      const st = t0 + i * R(0.13, 0.3);
      if (st > t0 + dur) break;
      const base = R(1900, 3600);
      const o1 = osc("sine", base, st);
      o1.frequency.exponentialRampToValueAtTime(base * R(1.35, 1.9), st + 0.03);
      o1.frequency.exponentialRampToValueAtTime(base * R(0.75, 0.95), st + 0.08);
      const e = env(st, 0.1, 0.6, 0.004, 0.06);
      o1.connect(e); e.connect(o);
      o1.start(st); o1.stop(st + 0.12); src(o1);
    }
  };

  P.insect = (t0, dur, gain, pan) => {
    const o = out(gain * 0.32, pan);
    for (let i = 0; i < Math.ceil(dur / 0.5); i++) {
      const st = t0 + i * 0.5 + R(0, 0.06);
      for (let k = 0; k < 4; k++) {
        const s2 = st + k * 0.035;
        const o1 = osc("square", R(3800, 4600), s2);
        const e = env(s2, 0.02, 0.22, 0.002, 0.01);
        o1.connect(e); e.connect(o);
        o1.start(s2); o1.stop(s2 + 0.03); src(o1);
      }
    }
  };

  P.frog = (t0, dur, gain, pan) => {
    const o = out(gain * 0.5, pan);
    for (let i = 0; i < Math.ceil(dur / R(0.7, 1.1)); i++) {
      const st = t0 + i * R(0.7, 1.1);
      const o1 = osc("sawtooth", R(110, 150), st);
      const am = osc("square", R(28, 38), st);
      const amg = ctx.createGain(); amg.gain.value = 0.9;
      const f = filt("bandpass", 700, 4);
      const e = env(st, 0.3, 0.5, 0.01, 0.12);
      am.connect(amg); amg.connect(e.gain);
      o1.connect(f); f.connect(e); e.connect(o);
      o1.start(st); am.start(st);
      o1.stop(st + 0.34); am.stop(st + 0.34);
      src(o1); src(am); node(amg);
    }
  };

  P.wind = (t0, dur, gain, pan) => {
    const o = out(gain * 0.4, pan);
    const s = noiseBuffer();
    const f = filt("lowpass", 420, 0.8);
    lfo(0.07, 260, f.frequency, t0);
    const e = env(t0, dur, 0.9, 1.2, 1.5);
    s.connect(f); f.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
  };

  P.leaves = (t0, dur, gain, pan) => {
    const o = out(gain * 0.3, pan);
    const s = noiseBuffer();
    const f = filt("highpass", 2400, 0.7);
    const f2 = filt("lowpass", 7000, 0.7);
    lfo(0.35, 0.35, f2.frequency, t0);
    const e = env(t0, dur, 0.7, 0.8, 1.2);
    s.connect(f); f.connect(f2); f2.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
  };

  P.water = (t0, dur, gain, pan) => {
    const o = out(gain * 0.42, pan);
    const s = noiseBuffer();
    const f = filt("bandpass", 900, 0.9);
    lfo(0.4, 420, f.frequency, t0);
    const f2 = filt("highpass", 300, 0.6);
    const e = env(t0, dur, 0.85, 0.9, 1.4);
    s.connect(f); f.connect(f2); f2.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
  };

  P.waterfall = (t0, dur, gain, pan) => {
    const o = out(gain * 0.5, pan);
    const s = noiseBuffer();
    const f = filt("lowpass", 2600, 0.7);
    lfo(0.2, 600, f.frequency, t0);
    const e = env(t0, dur, 1, 1.4, 1.8);
    s.connect(f); f.connect(e); e.connect(o);
    const s2 = noiseBuffer();
    const f2 = filt("lowpass", 120, 1.2);
    const e2 = env(t0, dur, 0.9, 2, 2);
    s2.connect(f2); f2.connect(e2); e2.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
    s2.start(t0); s2.stop(t0 + dur + 0.1); src(s2);
  };

  P.sea = (t0, dur, gain, pan) => {
    const o = out(gain * 0.5, pan);
    const s = noiseBuffer();
    const f = filt("lowpass", 1100, 0.6);
    lfo(0.09, 700, f.frequency, t0);
    const swell = ctx.createGain(); swell.gain.value = 0.6;
    lfo(0.09, 0.4, swell.gain, t0);
    const e = env(t0, dur, 0.95, 2, 2);
    s.connect(f); f.connect(swell); swell.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
    node(swell);
  };

  P.rain = (t0, dur, gain, pan) => {
    const o = out(gain * 0.36, pan);
    const s = noiseBuffer();
    const f = filt("highpass", 900, 0.6);
    const f2 = filt("lowpass", 6500, 0.6);
    const e = env(t0, dur, 0.8, 0.6, 1.2);
    s.connect(f); f.connect(f2); f2.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
    // 零星雨滴
    for (let i = 0; i < Math.floor(dur * 3); i++) {
      const st = t0 + R(0, dur);
      const o1 = osc("sine", R(2600, 5200), st);
      const e1 = env(st, 0.03, 0.12, 0.002, 0.02);
      o1.connect(e1); e1.connect(o);
      o1.start(st); o1.stop(st + 0.04); src(o1);
    }
  };

  P.thunder = (t0, dur, gain, pan) => {
    const o = out(gain * 0.6, pan);
    const s = noiseBuffer();
    const f = filt("lowpass", 140, 1.4);
    const e = env(t0, Math.min(2.6, dur), 1, 0.08, 2);
    s.connect(f); f.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + 2.7); src(s);
    const o1 = osc("sine", 44, t0);
    o1.frequency.exponentialRampToValueAtTime(28, t0 + 1.6);
    const e1 = env(t0, 1.8, 0.7, 0.06, 1.5);
    o1.connect(e1); e1.connect(o);
    o1.start(t0); o1.stop(t0 + 1.9); src(o1);
  };

  // —— 交通 / 机械 ——
  P.engine = (t0, dur, gain, pan) => {
    const o = out(gain * 0.4, pan);
    const o1 = osc("sawtooth", R(42, 68), t0);
    lfo(0.9, 6, o1.frequency, t0);
    const f = filt("lowpass", 340, 1.2);
    const s = noiseBuffer();
    const f2 = filt("lowpass", 600, 0.8);
    const e = env(t0, dur, 0.85, 0.5, 1);
    o1.connect(f); f.connect(e);
    s.connect(f2); f2.connect(e);
    e.connect(o);
    o1.start(t0); o1.stop(t0 + dur + 0.1); src(o1);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
  };

  P.horn = (t0, dur, gain, pan) => {
    const o = out(gain * 0.4, pan);
    const f1 = R(380, 460);
    [f1, f1 * 1.26].forEach(fr => {
      const o1 = osc("square", fr, t0);
      const f = filt("lowpass", 2200, 0.7);
      const e = env(t0, Math.min(0.45, dur), 0.4, 0.02, 0.1);
      o1.connect(f); f.connect(e); e.connect(o);
      o1.start(t0); o1.stop(t0 + Math.min(0.5, dur + 0.05)); src(o1);
    });
  };

  P.traffic = (t0, dur, gain, pan) => {
    const o = out(gain * 0.45, pan);
    const s = noiseBuffer();
    const f = filt("lowpass", 700, 0.7);
    const e = env(t0, dur, 0.6, 0.8, 1.2);
    s.connect(f); f.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
    // 断续的喇叭
    let t = t0 + R(0.5, 1.2);
    while (t < t0 + dur) {
      P.horn(t, 0.4, gain * R(0.35, 0.7), R(-0.8, 0.8));
      t += R(1.4, 3.4);
    }
    // 低频引擎底噪
    const o1 = osc("sawtooth", R(45, 60), t0);
    const f1 = filt("lowpass", 260, 1);
    const e1 = env(t0, dur, 0.35, 0.6, 1);
    o1.connect(f1); f1.connect(e1); e1.connect(o);
    o1.start(t0); o1.stop(t0 + dur + 0.1); src(o1);
  };

  P.sirenPolice = (t0, dur, gain, pan) => {
    const o = out(gain * 0.32, pan);
    const o1 = osc("square", 660, t0);
    const f = filt("bandpass", 1100, 1.2);
    const e = env(t0, dur, 0.5, 0.05, 0.2);
    const cycles = Math.ceil(dur / 0.5);
    for (let i = 0; i < cycles; i++) {
      const st = t0 + i * 0.5;
      o1.frequency.setValueAtTime(720, st);
      o1.frequency.setValueAtTime(940, st + 0.25);
    }
    o1.connect(f); f.connect(e); e.connect(o);
    o1.start(t0); o1.stop(t0 + dur + 0.1); src(o1);
  };

  P.sirenAmbulance = (t0, dur, gain, pan) => {
    const o = out(gain * 0.3, pan);
    const o1 = osc("sine", 620, t0);
    const o2 = osc("sine", 930, t0);
    const e = env(t0, dur, 0.45, 0.08, 0.3);
    const cycles = Math.ceil(dur / 1.4);
    for (let i = 0; i < cycles; i++) {
      const st = t0 + i * 1.4;
      o1.frequency.setValueAtTime(600, st);
      o1.frequency.linearRampToValueAtTime(1180, st + 0.7);
      o1.frequency.linearRampToValueAtTime(600, st + 1.4);
      o2.frequency.setValueAtTime(900, st);
      o2.frequency.linearRampToValueAtTime(1770, st + 0.7);
      o2.frequency.linearRampToValueAtTime(900, st + 1.4);
    }
    o1.connect(e); o2.connect(e); e.connect(o);
    o1.start(t0); o2.start(t0);
    o1.stop(t0 + dur + 0.1); o2.stop(t0 + dur + 0.1);
    src(o1); src(o2);
  };

  P.train = (t0, dur, gain, pan) => {
    const o = out(gain * 0.45, pan);
    const s = noiseBuffer();
    const f = filt("lowpass", 420, 1);
    const e = env(t0, dur, 0.7, 0.8, 1.2);
    s.connect(f); f.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
    const o1 = osc("sawtooth", 46, t0);
    lfo(0.7, 4, o1.frequency, t0);
    const f1 = filt("lowpass", 200, 1);
    const e1 = env(t0, dur, 0.5, 0.6, 1);
    o1.connect(f1); f1.connect(e1); e1.connect(o);
    o1.start(t0); o1.stop(t0 + dur + 0.1); src(o1);
    // 铁轨节奏
    let t = t0 + 0.2;
    while (t < t0 + dur) {
      const s2 = noiseBuffer();
      const f2 = filt("bandpass", R(700, 1400), 2);
      const e2 = env(t, 0.07, 0.3, 0.003, 0.05);
      s2.connect(f2); f2.connect(e2); e2.connect(o);
      s2.start(t); s2.stop(t + 0.09); src(s2);
      t += 0.42;
    }
  };

  P.plane = (t0, dur, gain, pan) => {
    const o = out(gain * 0.42, pan);
    const s = noiseBuffer();
    const f = filt("lowpass", 1600, 0.8);
    f.frequency.setValueAtTime(500, t0);
    f.frequency.linearRampToValueAtTime(2400, t0 + dur * 0.5);
    f.frequency.linearRampToValueAtTime(600, t0 + dur);
    const e = env(t0, dur, 0.9, 1.5, 1.5);
    s.connect(f); f.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
    const o1 = osc("sine", 1400, t0);
    const e1 = env(t0, dur, 0.12, 1.5, 1.5);
    o1.connect(e1); e1.connect(o);
    o1.start(t0); o1.stop(t0 + dur + 0.1); src(o1);
  };

  P.rocket = (t0, dur, gain, pan) => {
    const o = out(gain * 0.65, pan);
    const s = noiseBuffer();
    const f = filt("lowpass", 900, 0.9);
    lfo(3.5, 120, f.frequency, t0);
    const e = env(t0, dur, 1, 2.5, 2.5);
    s.connect(f); f.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
    const o1 = osc("sawtooth", 34, t0);
    o1.frequency.linearRampToValueAtTime(58, t0 + dur);
    const f1 = filt("lowpass", 180, 1.2);
    const e1 = env(t0, dur, 0.9, 2.5, 2.5);
    o1.connect(f1); f1.connect(e1); e1.connect(o);
    o1.start(t0); o1.stop(t0 + dur + 0.1); src(o1);
  };

  // —— 人声场景 ——
  function babble(o, t0, dur, gain, baseHi) {
    let t = t0;
    while (t < t0 + dur) {
      const len = R(0.1, 0.32);
      const o1 = osc("sawtooth", R(baseHi, baseHi * 1.7), t);
      const f = filt("bandpass", R(500, 1800), 3.5);
      const e = env(t, len, 0.28 * gain, 0.02, len * 0.6);
      o1.connect(f); f.connect(e); e.connect(o);
      o1.start(t); o1.stop(t + len + 0.02); src(o1);
      t += len + R(0.03, 0.2);
    }
  }

  P.crowd = (t0, dur, gain, pan) => {
    const o = out(gain * 0.45, pan);
    const s = noiseBuffer();
    const f = filt("bandpass", 900, 0.7);
    const e = env(t0, dur, 0.55, 0.8, 1.2);
    s.connect(f); f.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
    babble(o, t0, dur, 0.9, 170);
  };

  P.market = (t0, dur, gain, pan) => {
    const o = out(gain * 0.5, pan);
    const s = noiseBuffer();
    const f = filt("bandpass", 1100, 0.7);
    const e = env(t0, dur, 0.5, 0.8, 1.2);
    s.connect(f); f.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
    babble(o, t0, dur, 1, 190);
    // 偶尔的叫卖（拖长音）
    let t = t0 + R(0.6, 1.6);
    while (t < t0 + dur) {
      const len = R(0.5, 0.9);
      const o1 = osc("sawtooth", 240, t);
      o1.frequency.linearRampToValueAtTime(330, t + len * 0.4);
      o1.frequency.linearRampToValueAtTime(250, t + len);
      const f1 = filt("bandpass", 900, 4);
      const e1 = env(t, len, 0.5, 0.08, len * 0.5);
      o1.connect(f1); f1.connect(e1); e1.connect(o);
      o1.start(t); o1.stop(t + len + 0.05); src(o1);
      t += R(1.6, 3.2);
    }
  };

  P.children = (t0, dur, gain, pan) => {
    const o = out(gain * 0.45, pan);
    const s = noiseBuffer();
    const f = filt("bandpass", 1800, 0.7);
    const e = env(t0, dur, 0.4, 0.6, 1);
    s.connect(f); f.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
    babble(o, t0, dur, 1.1, 280);
    // 笑声：短促下行音
    let t = t0 + R(0.4, 1.2);
    while (t < t0 + dur) {
      for (let k = 0; k < 4; k++) {
        const st = t + k * 0.11;
        const o1 = osc("triangle", R(420, 560), st);
        o1.frequency.linearRampToValueAtTime(R(300, 380), st + 0.09);
        const e1 = env(st, 0.1, 0.3, 0.01, 0.06);
        o1.connect(e1); e1.connect(o);
        o1.start(st); o1.stop(st + 0.12); src(o1);
      }
      t += R(2.2, 4.5);
    }
  };

  P.applause = (t0, dur, gain, pan) => {
    const o = out(gain * 0.4, pan);
    for (let i = 0; i < Math.floor(dur * 45); i++) {
      const st = t0 + R(0, dur);
      const s = noiseBuffer();
      const f = filt("bandpass", R(1400, 4200), 1.4);
      const e = env(st, 0.05, 0.2, 0.002, 0.03);
      s.connect(f); f.connect(e); e.connect(o);
      s.start(st); s.stop(st + 0.06); src(s);
    }
  };

  P.schoolbell = (t0, dur, gain, pan) => {
    const o = out(gain * 0.42, pan);
    const cycles = Math.ceil(dur / 1.6);
    for (let i = 0; i < cycles; i++) {
      const st = t0 + i * 1.6;
      const base = R(780, 900);
      [1, 2.02, 3.1].forEach((m, k) => {
        const o1 = osc("sine", base * m, st);
        const e1 = env(st, 0.9, 0.3 / (k + 1), 0.005, 0.8);
        o1.connect(e1); e1.connect(o);
        o1.start(st); o1.stop(st + 0.95); src(o1);
      });
    }
  };

  P.phone = (t0, dur, gain, pan) => {
    const o = out(gain * 0.35, pan);
    const cycles = Math.ceil(dur / 3);
    for (let i = 0; i < cycles; i++) {
      const st = t0 + i * 3;
      [0, 0.45].forEach(off => {
        const s2 = st + off;
        if (s2 > t0 + dur) return;
        [440, 480].forEach(fr => {
          const o1 = osc("sine", fr, s2);
          const e1 = env(s2, 0.4, 0.28, 0.02, 0.1);
          o1.connect(e1); e1.connect(o);
          o1.start(s2); o1.stop(s2 + 0.42); src(o1);
        });
      });
    }
  };

  P.bell = (t0, dur, gain, pan) => {
    const o = out(gain * 0.4, pan);
    const base = R(520, 720);
    [1, 2.76, 5.4, 8.9].forEach((m, k) => {
      const o1 = osc("sine", base * m, t0);
      const e1 = env(t0, Math.min(2.4, dur), 0.32 / (k * 0.7 + 1), 0.004, 2);
      o1.connect(e1); e1.connect(o);
      o1.start(t0); o1.stop(t0 + 2.5); src(o1);
    });
  };

  P.cat = (t0, dur, gain, pan) => {
    const o = out(gain * 0.5, pan);
    let t = t0 + 0.1;
    while (t < t0 + dur) {
      const len = R(0.5, 0.8);
      const o1 = osc("sawtooth", R(420, 520), t);
      o1.frequency.linearRampToValueAtTime(R(640, 820), t + len * 0.3);
      o1.frequency.linearRampToValueAtTime(R(330, 420), t + len);
      const f = filt("bandpass", 1100, 5);
      const e = env(t, len, 0.55, 0.06, len * 0.5);
      const vib = osc("sine", 6, t);
      const vg = ctx.createGain(); vg.gain.value = 22;
      vib.connect(vg); vg.connect(o1.frequency);
      o1.connect(f); f.connect(e); e.connect(o);
      o1.start(t); vib.start(t);
      o1.stop(t + len + 0.05); vib.stop(t + len + 0.05);
      src(o1); src(vib); node(vg);
      t += len + R(0.35, 1.1);
    }
  };

  P.dog = (t0, dur, gain, pan) => {
    const o = out(gain * 0.5, pan);
    let t = t0 + 0.1;
    while (t < t0 + dur) {
      const o1 = osc("sawtooth", 210, t);
      o1.frequency.exponentialRampToValueAtTime(120, t + 0.14);
      const f = filt("bandpass", 800, 3);
      const e = env(t, 0.16, 0.5, 0.005, 0.08);
      const s = noiseBuffer();
      const f2 = filt("bandpass", 1500, 2);
      const e2 = env(t, 0.09, 0.3, 0.002, 0.05);
      o1.connect(f); f.connect(e); e.connect(o);
      s.connect(f2); f2.connect(e2); e2.connect(o);
      o1.start(t); o1.stop(t + 0.18); src(o1);
      s.start(t); s.stop(t + 0.1); src(s);
      t += R(0.35, 0.8);
    }
  };

  P.bee = (t0, dur, gain, pan) => {
    const o = out(gain * 0.28, pan);
    const o1 = osc("sawtooth", 210, t0);
    lfo(0.25, 30, o1.frequency, t0);
    const am = osc("sine", 28, t0);
    const amg = ctx.createGain(); amg.gain.value = 0.45;
    const f = filt("bandpass", 1200, 3);
    const e = env(t0, dur, 0.6, 0.4, 0.6);
    am.connect(amg); amg.connect(e.gain);
    o1.connect(f); f.connect(e); e.connect(o);
    o1.start(t0); am.start(t0);
    o1.stop(t0 + dur + 0.1); am.stop(t0 + dur + 0.1);
    src(o1); src(am); node(amg);
  };

  // —— 音乐 ——
  function chordNotes(root) {
    return [1, 1.26, 1.5, 2];
  }

  P.strings = (t0, dur, gain, pan) => {
    const o = out(gain * 0.3, pan);
    const root = R(160, 220);
    chordNotes(root).forEach((m, k) => {
      [0, 0.006, -0.008].forEach(det => {
        const o1 = osc("sawtooth", root * m * (1 + det), t0);
        const f = filt("lowpass", 1700, 0.8);
        const e = env(t0, dur, 0.16 / (k * 0.5 + 1), Math.min(1.2, dur * 0.25), Math.min(1.4, dur * 0.35));
        o1.connect(f); f.connect(e); e.connect(o);
        o1.start(t0); o1.stop(t0 + dur + 0.1); src(o1);
      });
    });
    const v = osc("sine", 5.2, t0);
    const vg = ctx.createGain(); vg.gain.value = 3;
    v.connect(vg); v.start(t0); v.stop(t0 + dur + 0.1); src(v); node(vg);
  };

  P.piano = (t0, dur, gain, pan) => {
    const o = out(gain * 0.4, pan);
    let t = t0;
    const scale = [1, 1.125, 1.26, 1.5, 1.68, 2];
    let i = 0;
    while (t < t0 + dur) {
      const fr = 220 * scale[i % scale.length];
      const carrier = osc("sine", fr, t);
      const mod = osc("sine", fr * 2.01, t);
      const mg = ctx.createGain(); mg.gain.value = fr * 1.4;
      mod.connect(mg); mg.connect(carrier.frequency);
      const e = env(t, R(0.7, 1.2), 0.32, 0.006, 0.9);
      carrier.connect(e); e.connect(o);
      carrier.start(t); mod.start(t);
      carrier.stop(t + 1.3); mod.stop(t + 1.3);
      src(carrier); src(mod); node(mg);
      t += R(0.32, 0.55);
      i++;
    }
  };

  P.flute = (t0, dur, gain, pan) => {
    const o = out(gain * 0.32, pan);
    let t = t0;
    const scale = [1, 1.125, 1.26, 1.5, 1.68];
    let i = 0;
    while (t < t0 + dur) {
      const len = R(0.5, 0.85);
      const fr = 520 * scale[i % scale.length];
      const o1 = osc("sine", fr, t);
      const s = noiseBuffer();
      const f = filt("bandpass", fr * 2, 1.2);
      const e = env(t, len, 0.34, 0.08, len * 0.4);
      const e2 = env(t, len, 0.05, 0.08, len * 0.4);
      const vib = osc("sine", 5.5, t);
      const vg = ctx.createGain(); vg.gain.value = 4;
      vib.connect(vg); vg.connect(o1.frequency);
      o1.connect(e); e.connect(o);
      s.connect(f); f.connect(e2); e2.connect(o);
      o1.start(t); vib.start(t); s.start(t);
      o1.stop(t + len + 0.05); vib.stop(t + len + 0.05); s.stop(t + len + 0.05);
      src(o1); src(vib); src(s); node(vg);
      t += len + R(0.1, 0.3);
      i++;
    }
  };

  P.drum = (t0, dur, gain, pan) => {
    const o = out(gain * 0.5, pan);
    let t = t0;
    let beat = 0;
    while (t < t0 + dur) {
      // 底鼓
      if (beat % 2 === 0) {
        const k = osc("sine", 120, t);
        k.frequency.exponentialRampToValueAtTime(42, t + 0.12);
        const e = env(t, 0.22, 0.8, 0.004, 0.14);
        k.connect(e); e.connect(o);
        k.start(t); k.stop(t + 0.24); src(k);
      }
      // 军鼓
      if (beat % 4 === 2) {
        const s = noiseBuffer();
        const f = filt("bandpass", 1800, 1);
        const e = env(t, 0.14, 0.4, 0.002, 0.08);
        s.connect(f); f.connect(e); e.connect(o);
        s.start(t); s.stop(t + 0.16); src(s);
      }
      // 踩镲
      const h = noiseBuffer();
      const hf = filt("highpass", 7000, 0.7);
      const he = env(t, 0.05, 0.16, 0.001, 0.03);
      h.connect(hf); hf.connect(he); he.connect(o);
      h.start(t); h.stop(t + 0.06); src(h);
      t += 0.3;
      beat++;
    }
  };

  P.whistle = (t0, dur, gain, pan) => {
    const o = out(gain * 0.3, pan);
    const o1 = osc("sine", R(1900, 2500), t0);
    const vib = osc("sine", 18, t0);
    const vg = ctx.createGain(); vg.gain.value = 60;
    vib.connect(vg); vg.connect(o1.frequency);
    const e = env(t0, Math.min(0.8, dur), 0.35, 0.03, 0.2);
    o1.connect(e); e.connect(o);
    o1.start(t0); vib.start(t0);
    o1.stop(t0 + Math.min(0.85, dur) + 0.05); vib.stop(t0 + Math.min(0.85, dur) + 0.05);
    src(o1); src(vib); node(vg);
  };

  // —— 生活 ——
  P.clock = (t0, dur, gain, pan) => {
    const o = out(gain * 0.4, pan);
    let t = t0;
    let i = 0;
    while (t < t0 + dur) {
      const s = noiseBuffer();
      const f = filt("bandpass", i % 2 ? 2600 : 1900, 6);
      const e = env(t, 0.06, 0.35, 0.001, 0.03);
      s.connect(f); f.connect(e); e.connect(o);
      s.start(t); s.stop(t + 0.07); src(s);
      t += 1;
      i++;
    }
  };

  P.footsteps = (t0, dur, gain, pan) => {
    const o = out(gain * 0.42, pan);
    let t = t0;
    while (t < t0 + dur) {
      const s = noiseBuffer();
      const f = filt("bandpass", R(700, 1600), 2.4);
      const e = env(t, 0.1, 0.35, 0.003, 0.06);
      s.connect(f); f.connect(e); e.connect(o);
      s.start(t); s.stop(t + 0.12); src(s);
      t += R(0.42, 0.56);
    }
  };

  P.door = (t0, dur, gain, pan) => {
    const o = out(gain * 0.4, pan);
    const o1 = osc("sawtooth", 180, t0);
    o1.frequency.linearRampToValueAtTime(420, t0 + 0.9);
    const f = filt("bandpass", 900, 6);
    const e = env(t0, 1, 0.35, 0.1, 0.3);
    o1.connect(f); f.connect(e); e.connect(o);
    o1.start(t0); o1.stop(t0 + 1.05); src(o1);
    const s = noiseBuffer();
    const f2 = filt("highpass", 2000, 0.7);
    const e2 = env(t0, 0.95, 0.16, 0.1, 0.3);
    s.connect(f2); f2.connect(e2); e2.connect(o);
    s.start(t0); s.stop(t0 + 1); src(s);
  };

  P.fire = (t0, dur, gain, pan) => {
    const o = out(gain * 0.4, pan);
    const s = noiseBuffer();
    const f = filt("lowpass", 900, 0.8);
    lfo(0.6, 400, f.frequency, t0);
    const e = env(t0, dur, 0.6, 0.6, 1);
    s.connect(f); f.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
    let t = t0;
    while (t < t0 + dur) {
      const s2 = noiseBuffer();
      const f2 = filt("bandpass", R(1200, 3800), 3);
      const e2 = env(t, 0.07, 0.3, 0.002, 0.04);
      s2.connect(f2); f2.connect(e2); e2.connect(o);
      s2.start(t); s2.stop(t + 0.08); src(s2);
      t += R(0.08, 0.5);
    }
  };

  P.machine = (t0, dur, gain, pan) => {
    const o = out(gain * 0.42, pan);
    const o1 = osc("square", 62, t0);
    const f = filt("lowpass", 320, 1.4);
    const e = env(t0, dur, 0.35, 0.4, 0.8);
    o1.connect(f); f.connect(e); e.connect(o);
    o1.start(t0); o1.stop(t0 + dur + 0.1); src(o1);
    let t = t0;
    while (t < t0 + dur) {
      const base = R(900, 1500);
      [1, 2.4, 4.1].forEach((m, k) => {
        const o2 = osc("sine", base * m, t);
        const e2 = env(t, 0.3, 0.2 / (k + 1), 0.002, 0.2);
        o2.connect(e2); e2.connect(o);
        o2.start(t); o2.stop(t + 0.32); src(o2);
      });
      t += 0.75;
    }
  };

  P.radio = (t0, dur, gain, pan) => {
    const o = out(gain * 0.32, pan);
    const s = noiseBuffer();
    const f = filt("bandpass", 1400, 0.6);
    const e = env(t0, dur, 0.4, 0.3, 0.6);
    s.connect(f); f.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
    let t = t0;
    while (t < t0 + dur) {
      const o1 = osc("triangle", R(300, 700), t);
      const f1 = filt("bandpass", 1000, 4);
      const e1 = env(t, R(0.15, 0.35), 0.28, 0.02, 0.15);
      o1.connect(f1); f1.connect(e1); e1.connect(o);
      o1.start(t); o1.stop(t + 0.4); src(o1);
      t += R(0.3, 0.7);
    }
  };

  P.heartbeat = (t0, dur, gain, pan) => {
    const o = out(gain * 0.55, pan);
    let t = t0;
    while (t < t0 + dur) {
      [0, 0.26].forEach((off, k) => {
        const st = t + off;
        const o1 = osc("sine", 62, st);
        o1.frequency.exponentialRampToValueAtTime(34, st + 0.18);
        const e = env(st, 0.24, k ? 0.4 : 0.7, 0.008, 0.16);
        o1.connect(e); e.connect(o);
        o1.start(st); o1.stop(st + 0.26); src(o1);
      });
      t += 1.05;
    }
  };

  P.kitchen = (t0, dur, gain, pan) => {
    const o = out(gain * 0.4, pan);
    const s = noiseBuffer();
    const f = filt("bandpass", 3200, 1);
    const e = env(t0, dur, 0.28, 0.3, 0.6);
    s.connect(f); f.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
    let t = t0;
    while (t < t0 + dur) {
      const base = R(700, 1400);
      [1, 2.9, 5.6].forEach((m, k) => {
        const o1 = osc("sine", base * m, t);
        const e1 = env(t, 0.5, 0.2 / (k + 1), 0.002, 0.4);
        o1.connect(e1); e1.connect(o);
        o1.start(t); o1.stop(t + 0.55); src(o1);
      });
      t += R(0.9, 1.9);
    }
  };

  P.room = (t0, dur, gain, pan) => {
    const o = out(gain * 0.3, pan);
    const s = noiseBuffer();
    const f = filt("lowpass", 500, 0.7);
    const e = env(t0, dur, 0.35, 1.2, 1.5);
    s.connect(f); f.connect(e); e.connect(o);
    s.start(t0); s.stop(t0 + dur + 0.1); src(s);
  };

  /* ================= 调度 ================= */

  // 连续型：一次启动，持续整段
  const CONTINUOUS = new Set(["wind", "leaves", "water", "waterfall", "sea", "rain", "engine", "traffic", "crowd", "market", "children", "strings", "plane", "rocket", "bee", "train", "radio", "fire", "machine", "room"]);

  function startLayer(id, gain, pan, t0, dur) {
    const fn = P[id];
    if (!fn) { console.warn("未知音效:", id); return; }
    try { fn(t0, dur, gain, pan); } catch (e) { console.warn("音效渲染失败:", id, e); }
  }

  function stopAllSources() {
    liveSources.forEach(s => { try { s.stop(); } catch (e) {} });
    liveSources.length = 0;
    liveNodes.forEach(n => { try { n.disconnect(); } catch (e) {} });
    liveNodes.length = 0;
  }

  function fadeOut(seconds) {
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), t);
    master.gain.linearRampToValueAtTime(0, t + (seconds || 0.4));
  }

  function play(scene) {
    if (!ensure()) { alert("当前浏览器不支持 Web Audio，无法播放音频。"); return false; }
    if (ctx.state === "suspended") ctx.resume();
    stop(true);
    currentScene = scene;
    const dur = Math.max(6, Math.min(90, scene.seconds || 30));
    const t0 = ctx.currentTime + 0.12;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(0.0001, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.9, t0 + 0.5);
    master.gain.setValueAtTime(0.9, t0 + dur - 0.8);
    master.gain.linearRampToValueAtTime(0.0001, t0 + dur);

    (scene.layers || []).forEach(layer => {
      const id = layer[0];
      const gain = layer[1] == null ? 0.6 : layer[1];
      const pan = layer[2] == null ? R(-0.45, 0.45) : layer[2];
      if (CONTINUOUS.has(id)) {
        startLayer(id, gain, pan, t0, dur + 0.4);
      } else {
        // 事件型：在整段内按随机间隔重复
        let t = t0 + R(0, 0.4);
        const gap = { bird: 0.5, insect: 0.5, frog: 0.8, cat: 1.4, dog: 0.9, bell: 1.6, piano: 0.35, flute: 0.6, drum: 0.3, whistle: 1.2, clock: 1, footsteps: 0.5, door: 3.5, heartbeat: 1.05, schoolbell: 1.6, phone: 3, applause: 0.1, horn: 1.8, sirenPolice: 2.5, sirenAmbulance: 3, thunder: 4, kitchen: 1.4, children: 2.4, market: 2 }[id] || 1.5;
        while (t < t0 + dur - 0.3) {
          startLayer(id, gain, pan, t, 1);
          t += gap * R(0.7, 1.4);
        }
      }
    });

    playing = true;
    if (stateCb) stateCb(true, scene);
    endTimer = setTimeout(() => stop(), (dur + 0.6) * 1000);
    return true;
  }

  function stop(silent) {
    if (endTimer) { clearTimeout(endTimer); endTimer = null; }
    if (!ctx) { playing = false; return; }
    if (silent) {
      // 立即清理：调用方（play）随后会建立新的音源，不能延迟清理，否则会误杀新声音
      stopAllSources();
    } else {
      fadeOut(0.35);
      const srcs = liveSources.slice();
      const nodes = liveNodes.slice();
      liveSources.length = 0;
      liveNodes.length = 0;
      setTimeout(() => {
        srcs.forEach(s => { try { s.stop(); } catch (e) {} });
        nodes.forEach(n => { try { n.disconnect(); } catch (e) {} });
      }, 380);
    }
    playing = false;
    if (stateCb) stateCb(false, currentScene);
  }

  window.AudioSceneEngine = {
    PRIMITIVES,
    play,
    stop,
    isPlaying: () => playing,
    current: () => currentScene,
    getAnalyser: () => analyser,
    getContextState: () => (ctx ? ctx.state : "none"),
    getSampleRate: () => (ctx ? ctx.sampleRate : 44100),
    onstate: fn => { stateCb = fn; },
    unlock: () => { if (ensure() && ctx.state === "suspended") ctx.resume(); }
  };
})();
