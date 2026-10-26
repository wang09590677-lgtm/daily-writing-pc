/* ==================================================================
 * 体能训练 · 教练计时浮层（占屏幕 80% 的半透明大画面）
 *
 * 计时开始后弹出一块占屏幕 80% 的半透明浮层：
 *   左半 = 所选动作的人形演示（"教练带着做"），右半 = 巨大的计时数字。
 *   计时中循环播钟表滴答声；过半播「坚持，还剩一半」；结束播「完美结束」。
 *
 * ── 音频为什么走"预生成文件 + <audio>" ──────────────────────────
 * 单机版是 file:// 双击打开的。实测这种环境下 AudioContext 的
 * createMediaElementSource 输出会被静音，而 <audio> 播本地文件正常
 * （听音撰文整套就是这么做的）。所以音频一律预生成为文件，放在
 * assets/coach/，由 build/gen-coach-audio.py 生成。
 * 万一文件缺失，降级为 Web Audio 蜂鸣 + speechSynthesis 朗读。
 *
 * ── 人形演示怎么做的 ────────────────────────────────────────────
 * 没有姿态模型，也不需要。用一套"骨骼 + 角度"的木偶：
 *   每个动作 = 一个 t∈[0,1) → 关节角度 的函数；
 *   正运动学把角度算成 15 个关节的坐标；
 *   最后把整个人整体平移，让最低点落在 y=0（地面）。
 * 脚掌自动贴地这一条很关键：蹲下去身体会自然下沉、提踵时会自然升高、
 * 起跳时脚会离地，都不用手工调。
 *
 * 侧视 / 正视两套解算：
 *   侧视（深蹲、弓步、跑跳、拉伸）能看清关节屈伸，是默认视角；
 *   正视（开合跳、侧向跳、单腿站立）能看清左右张开，单独一套。
 * 侧视里远侧的手脚画暗一档，看起来有前后关系。
 *
 * 对外接口（window.CoachTimer）：
 *   open({exId, name, emoji, how, segments, seconds, label, onPause, onClose})
 *     segments = [{kind:"work"|"rest", seconds, setNo, setCount, exId, label, sides}, ...]
 *     给了 segments 就按分段跑（多组动作会自动串组间歇）；只给 seconds 也兼容。
 *   update(leftSeconds)   由 app.js 的计时循环每 250ms 调一次
 *   close()               关闭浮层并停掉音频
 *   setPaused(bool)       同步按钮文字与滴答声
 *   isOpen() / debug()    状态查询（debug 给测试用）
 * ================================================================== */

(function () {
  /* ================= 0. 常量 ================= */

  var AUDIO_BASE = "assets/coach/";

  // 木偶比例（单位是"身高 ≈ 1.2"的抽象单位）
  var TORSO = 0.46;
  var SHOULDER_DROP = 0.055;   // 肩比颈低一点
  var HEAD_R = 0.088;
  var NECK_GAP = 0.038;
  var UPPER_ARM = 0.185;
  var FORE_ARM = 0.185;
  var THIGH = 0.25;
  var SHIN = 0.25;
  var FOOT = 0.115;
  var SHOULDER_W = 0.085;
  var HIP_W = 0.055;

  // 取景窗口（世界坐标）：站立和躺下的姿势都落得进来
  var VIEW_W = 1.6;
  var VIEW_H = 1.38;
  var VIEW_CX = 0.02;
  var VIEW_CY = 0.60;

  var TAU = Math.PI * 2;
  var rad = function (d) { return (d * Math.PI) / 180; };

  /* ================= 1. 音频 ================= */

  var audio = {
    tick: null,
    half: null,
    finish: null,
    tickPlaying: false,
    failed: false,
    voice: null,          // 降级用的 SpeechSynthesisUtterance 配置
    duckTimer: null,
    ctx: null,            // 提示音用的 Web Audio 上下文
    cue: null,            // 当前正在播的"准备开始进行XX，请就位"
    cueKey: "",           // 它的动作 id，用来判断要不要重载音源
    counts: null,         // { "1":Audio, "2":Audio, "3":Audio, "go":Audio }
    countFailed: false,   // 数数文件缺失 → 退回系统 TTS

    init: function () {
      if (this.tick) return true;
      if (typeof Audio !== "function") { this.failed = true; return false; }
      var self = this;
      function mk(file, loop, vol) {
        var el = new Audio(AUDIO_BASE + file);
        el.loop = !!loop;
        el.volume = vol;
        el.preload = "auto";
        return el;
      }
      this.tick = mk("tick-tock.mp3", true, 0.34);
      // mp3 若缺失（例如只跑了 wav 那一半），退回 wav
      this.tick.onerror = function () {
        if (this.dataset && this.dataset.fallback) return;
        this.dataset.fallback = "1";
        this.src = AUDIO_BASE + "tick-tock.wav";
        try { this.load(); } catch (e) {}
      };
      this.half = mk("half.mp3", false, 0.95);
      this.finish = mk("finish.mp3", false, 1.0);
      [this.tick, this.half, this.finish].forEach(function (el) {
        el.addEventListener("error", function () { self.failed = true; });
      });
      return true;
    },

    /* ---- 开练前的"就位口令"与"人声数数" ----
     *
     * 目的：每个动作开始前先一句「准备开始进行XX，请就位」，让孩子有时间站好，
     * 然后人声数 1、2、3 再真正开始。没有这一步，倒计时是突然开始的，
     * 孩子往往前两秒还在调整姿势，白白浪费掉。
     */
    initCounts: function () {
      if (this.counts) return true;
      if (typeof Audio !== "function") { this.countFailed = true; return false; }
      var self = this;
      this.counts = {};
      [["1", "count-1.mp3"], ["2", "count-2.mp3"], ["3", "count-3.mp3"], ["go", "count-go.mp3"]]
        .forEach(function (pair) {
          var el = new Audio(AUDIO_BASE + pair[1]);
          el.volume = 1.0;
          el.preload = "auto";
          el.addEventListener("error", function () { self.countFailed = true; });
          self.counts[pair[0]] = el;
        });
      return true;
    },

    // 播「准备开始进行XX，请就位」。返回是否用上了预生成音频。
    //   有 exId → 播 assets/coach/ready-<exId>.mp3
    //   没有（循环块）→ 直接走系统 TTS，语音文案取 fallbackName
    // 文件缺失时靠 error 事件兜底转 TTS，避免"静默无声、孩子只听到数数"。
    ready: function (exId, fallbackName) {
      var text = "准备开始进行" + (fallbackName || "") + "，请就位";
      var ok = false;
      if (exId && typeof Audio === "function") {
        if (!this.cue || this.cueKey !== exId) {
          this.cueKey = exId;
          this.cue = new Audio(AUDIO_BASE + "ready-" + exId + ".mp3");
          this.cue.volume = 1.0;
          this.cue.preload = "auto";
          this.cueErrorBound = false;   // 换新音源要重新允许挂 error 兜底
          this.cueBroken = false;       // 也重新给这个音源一次机会
        }
        /* 关键：这个音源上次已经加载失败过，就**别再碰它**，直接读 TTS。
         * 否则会出现最难查的一种静默：第一次失败时 TTS 念了，第二次因为
         * 坏元素的 error 不会再触发、而 mp3 本来就不存在，于是既没 mp3 也没 TTS，
         * 孩子什么都听不到 —— 表现就是"这次没说口令，直接开始数数"。 */
        if (this.cueBroken) {
          this.duck(true);
          this.speakFallback(text);
          return false;
        }
        ok = this._play(this.cue);
        if (ok && !this.cueErrorBound) {
          // 只挂一次：cue 在同一动作内会被重复使用，逐次挂监听会越积越多
          this.cueErrorBound = true;
          var self = this;
          this.cue.addEventListener("error", function () {
            self.cueBroken = true;
            self.speakFallback(text);
          });
        }
      }
      this.duck(true);
      if (!ok) this.speakFallback(text);
      return ok;
    },

    /* 拿口令的**真实时长**（秒）。关键坑：
     * `new Audio()` 之后 duration 立刻是 NaN，要等元数据加载完才有值
     * （实测 play() 后约 50ms 才拿到）。之前调用方在同一 tick 直接读 duration，
     * 永远读到 NaN，于是永远走兜底值 2.9 秒 —— 而口令实际 3.4~4.5 秒，
     * 结果人声数 3、2、1 全压在口令尾巴上，听感就是"没念口令直接数数"。
     * 这里返回 Promise：能拿到就给真实值，超时/失败给 null（调用方用兜底值）。
     */
    cueDuration: function (timeoutMs) {
      var self = this;
      return new Promise(function (resolve) {
        var el = self.cue;
        if (!el) { resolve(null); return; }
        var dur = el.duration;
        if (isFinite(dur) && dur > 0.4) { resolve(dur); return; }
        var done = false;
        var finish = function (v) {
          if (done) return;
          done = true;
          el.removeEventListener("loadedmetadata", onMeta);
          el.removeEventListener("durationchange", onMeta);
          el.removeEventListener("canplaythrough", onMeta);
          clearTimeout(timer);
          resolve(v);
        };
        var onMeta = function () {
          var d = el.duration;
          if (isFinite(d) && d > 0.4) finish(d);
        };
        el.addEventListener("loadedmetadata", onMeta);
        el.addEventListener("durationchange", onMeta);
        el.addEventListener("canplaythrough", onMeta);
        var timer = setTimeout(function () {
          var d = el.duration;
          finish(isFinite(d) && d > 0.4 ? d : null);
        }, timeoutMs == null ? 1200 : timeoutMs);
        /* 千万不要在这里 el.load()。
         * 调用方是「先 audio.ready() 播口令、紧接着 cueDuration() 读时长」，
         * 此刻 readyState 往往还是 0，load() 会把刚起播的口令整个重置回 0，
         * 听感就是"口令没念完就断了"。事件可能错过也没关系 —— 超时会兜底。 */
      });
    },

    // 人声数一个数（n = 1/2/3），或 "go" 表示开始
    count: function (n) {
      if (!this.initCounts() || this.countFailed) { this._countFallback(n); return false; }
      var el = this.counts[String(n)];
      if (!el) return false;
      try {
        el.currentTime = 0;
        var p = el.play();
        if (p && p.catch) p.catch(function () {});
        this.duck(true);
        return true;
      } catch (e) { this._countFallback(n); return false; }
    },

    _countFallback: function (n) {
      this.speakFallback(n === "go" ? "开始" : String(n));
      this.duck(true);
    },

    stopCue: function () {
      [this.cue, this.counts && this.counts["1"], this.counts && this.counts["2"],
       this.counts && this.counts["3"], this.counts && this.counts["go"]]
        .forEach(function (el) {
          if (!el) return;
          try { el.pause(); } catch (e) {}
          try { el.currentTime = 0; } catch (e) {}
        });
    },

    _play: function (el) {
      if (!el) return false;
      try {
        el.currentTime = 0;
        var p = el.play();
        if (p && p.catch) p.catch(function () {});
        return true;
      } catch (e) { return false; }
    },

    startTick: function () {
      if (!this.init() || this.failed) return;
      if (this.tickPlaying) return;
      this.tickPlaying = true;
      this._play(this.tick);
    },

    stopTick: function () {
      if (!this.tick) return;
      this.tickPlaying = false;
      try { this.tick.pause(); } catch (e) {}
      try { this.tick.currentTime = 0; } catch (e) {}
    },

    // 段与段之间的提示音（"运动 → 组间歇"、"组间歇 → 下一组"）。
    // 这个用 Web Audio 现场合成就够了：file:// 下被静音的只有
    // createMediaElementSource 那条路，振荡器直连 destination 是正常的。
    beep: function (times, freq) {
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!this.ctx) this.ctx = new Ctx();
        if (this.ctx.state === "suspended") this.ctx.resume();
        var ctx = this.ctx;
        var n = Math.max(1, times || 1);
        for (var i = 0; i < n; i++) {
          var at = ctx.currentTime + i * 0.24;
          var osc = ctx.createOscillator();
          var g = ctx.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(freq || 880, at);
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, at + 0.19);
          osc.connect(g).connect(ctx.destination);
          osc.start(at);
          osc.stop(at + 0.21);
        }
      } catch (e) { /* 声音失败不影响计时 */ }
    },

    // 说话时把滴答声压下去，别盖住人声
    duck: function (on) {
      if (!this.tick) return;
      var self = this;
      if (this.duckTimer) { clearTimeout(this.duckTimer); this.duckTimer = null; }
      try { this.tick.volume = on ? 0.07 : 0.34; } catch (e) {}
      if (on) {
        this.duckTimer = setTimeout(function () { self.duck(false); }, 2600);
      }
    },

    say: function (which, text) {
      var el = which === "finish" ? this.finish : this.half;
      var ok = false;
      if (this.init() && !this.failed) {
        this.duck(true);
        ok = this._play(el);
      }
      if (!ok) this.speakFallback(text);
    },

    // 文件缺失时的兜底：让系统 TTS 念一遍
    speakFallback: function (text) {
      try {
        if (typeof speechSynthesis === "undefined" || !text) return;
        var u = new SpeechSynthesisUtterance(text);
        u.lang = "zh-CN";
        u.rate = 1.15;
        u.pitch = 1.25;
        u.volume = 1;
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      } catch (e) {}
    },

    stopAll: function () {
      this.stopTick();
      [this.half, this.finish].forEach(function (el) {
        if (!el) return;
        try { el.pause(); } catch (e) {}
        try { el.currentTime = 0; } catch (e) {}
      });
      this.stopCue();
      try {
        if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
      } catch (e) {}
    },

    status: function () {
      function st(el) {
        if (!el) return null;
        return {
          src: String(el.src || "").split("/").pop(),
          paused: el.paused,
          volume: Number((el.volume || 0).toFixed(3)),
          t: Number((el.currentTime || 0).toFixed(2)),
          ready: el.readyState,
          dur: isFinite(el.duration) ? Number(el.duration.toFixed(2)) : null
        };
      }
      return { tick: st(this.tick), half: st(this.half), finish: st(this.finish), failed: this.failed };
    }
  };

  /* ================= 2. 正运动学 ================= */

  // 侧视：0° = 朝下，正角度 = 朝前（画面右）
  function dirSide(deg) {
    var r = rad(deg);
    return { x: Math.sin(r), y: -Math.cos(r) };
  }

  // 躯干是朝上的，不能复用 dirSide —— 0° = 竖直向上，正角度 = 前倾
  function dirUp(deg) {
    var r = rad(deg);
    return { x: Math.sin(r), y: Math.cos(r) };
  }

  function add(p, d, len) {
    return { x: p.x + d.x * len, y: p.y + d.y * len };
  }

  // 把整组点绕 hip 旋转（躺姿用）
  function rotateAll(J, deg, pivot) {
    var r = rad(deg), c = Math.cos(r), s = Math.sin(r);
    var walk = function (p) {
      if (!p) return p;
      var dx = p.x - pivot.x, dy = p.y - pivot.y;
      return { x: pivot.x + dx * c - dy * s, y: pivot.y + dx * s + dy * c };
    };
    return {
      view: J.view,
      head: walk(J.head),
      headR: J.headR,
      neck: walk(J.neck),
      spine: J.spine.map(walk),
      arms: J.arms.map(function (a) { return { pts: a.pts.map(walk), near: a.near, z: a.z }; }),
      legs: J.legs.map(function (l) { return { pts: l.pts.map(walk), near: l.near, z: l.z }; }),
      wristSpin: J.wristSpin,
      hip: walk(J.hip)
    };
  }

  // 侧视解算。p: {lean, hipL, hipR, kneeL, kneeR, armL, armR, elbL, elbR,
  //               footL, footR, bodyY, rotate, wristSpin, bodyX}
  function solveSide(p) {
    var lean = p.lean || 0;
    var hip = { x: 0, y: 0 };
    var neck = add(hip, dirUp(lean), TORSO);
    var shoulder = add(hip, dirUp(lean), TORSO - SHOULDER_DROP);
    var head = add(neck, dirUp(lean), HEAD_R + NECK_GAP);

    var arms = [
      { side: "R", near: false, z: 0, a: p.armR || 0, e: p.elbR || 0 },
      { side: "L", near: true, z: 2, a: p.armL || 0, e: p.elbL || 0 }
    ].map(function (it) {
      var elbow = add(shoulder, dirSide(it.a), UPPER_ARM);
      var wrist = add(elbow, dirSide(it.a + it.e), FORE_ARM);
      return { pts: [shoulder, elbow, wrist], near: it.near, z: it.z };
    });

    var legs = [
      { side: "R", near: false, z: 1, h: p.hipR || 0, k: p.kneeR || 0, f: p.footR || 0 },
      { side: "L", near: true, z: 3, h: p.hipL || 0, k: p.kneeL || 0, f: p.footL || 0 }
    ].map(function (it) {
      var knee = add(hip, dirSide(it.h), THIGH);
      var shinAng = it.h - it.k;
      var ankle = add(knee, dirSide(shinAng), SHIN);
      // 脚掌大致垂直于小腿、朝前；脚跟抬起时脚尖往下压
      var toe = add(ankle, dirSide(shinAng + 78 - (it.f || 0) * 54), FOOT);
      return { pts: [hip, knee, ankle, toe], near: it.near, z: it.z };
    });

    return finalizePose({
      view: "side", head: head, headR: HEAD_R, hip: hip, neck: neck,
      spine: [hip, neck], arms: arms, legs: legs, wristSpin: p.wristSpin
    }, p);
  }

  // 正视解算。p: {lean, legSpread, kneeBend, armLift, armSpread, elbow, bodyY, bodyX, hop}
  function solveFront(p) {
    var lean = p.lean || 0;
    var hip = { x: 0, y: 0 };
    var neck = add(hip, dirUp(lean), TORSO);
    var shoulder = add(hip, dirUp(lean), TORSO - SHOULDER_DROP);
    var head = add(neck, dirUp(lean), HEAD_R + NECK_GAP);

    var spread = p.legSpread || 0;
    var kneeBend = p.kneeBend || 0;

    var legs = [
      { sign: -1, near: true, z: 1 },
      { sign: 1, near: false, z: 0 }
    ].map(function (it) {
      var s = it.sign;
      var hx = hip.x + s * HIP_W;
      var knee = { x: hx + s * Math.sin(rad(spread)) * THIGH, y: hip.y - Math.cos(rad(spread)) * THIGH };
      var shinAng = spread - kneeBend;                       // 屈膝时小腿往里收
      var ankle = { x: knee.x + s * Math.sin(rad(shinAng)) * SHIN, y: knee.y - Math.cos(rad(shinAng)) * SHIN };
      var toe = { x: ankle.x + s * FOOT * 0.85, y: ankle.y };
      return { pts: [{ x: hx, y: hip.y }, knee, ankle, toe], near: it.near, z: it.z };
    });

    var lift = p.armLift || 0;
    var elb = p.elbow || 0;
    var arms = [
      { sign: -1, near: true, z: 3 },
      { sign: 1, near: false, z: 2 }
    ].map(function (it) {
      var s = it.sign;
      var sx = shoulder.x + s * SHOULDER_W;
      var sh = { x: sx, y: shoulder.y };
      var a = rad(lift);
      var elbow = { x: sh.x + s * Math.sin(a) * UPPER_ARM, y: sh.y - Math.cos(a) * UPPER_ARM };
      var b = rad(lift + elb);
      var wrist = { x: elbow.x + s * Math.sin(b) * FORE_ARM, y: elbow.y - Math.cos(b) * FORE_ARM };
      return { pts: [sh, elbow, wrist], near: it.near, z: it.z };
    });

    return finalizePose({
      view: "front", head: head, headR: HEAD_R, hip: hip, neck: neck,
      spine: [hip, neck], arms: arms, legs: legs, wristSpin: p.wristSpin
    }, p);
  }

  // 旋转 → 贴地 → 加位移。脚掌自动对齐地面是"看起来像在做动作"的关键
  function finalizePose(J, p) {
    if (p.rotate) J = rotateAll(J, p.rotate, J.hip);

    var minY = Infinity;
    J.legs.forEach(function (l) {
      l.pts.forEach(function (pt) { if (pt.y < minY) minY = pt.y; });
    });
    if (!isFinite(minY)) minY = 0;

    var dy = -minY + (p.bodyY || 0);
    var dx = p.bodyX || 0;
    var shift = function (pt) { return { x: pt.x + dx, y: pt.y + dy }; };

    J.head = shift(J.head);
    J.hip = shift(J.hip);
    J.neck = shift(J.neck);
    J.spine = J.spine.map(shift);
    J.arms = J.arms.map(function (a) { return { pts: a.pts.map(shift), near: a.near, z: a.z }; });
    J.legs = J.legs.map(function (l) { return { pts: l.pts.map(shift), near: l.near, z: l.z }; });

    // 跳绳/绕环：手腕画小圈
    if (J.wristSpin != null) {
      var sp = rad(J.wristSpin * 360);
      J.arms.forEach(function (a) {
        var w = a.pts[a.pts.length - 1];
        a.pts[a.pts.length - 1] = { x: w.x + Math.cos(sp) * 0.035, y: w.y + Math.sin(sp) * 0.035 };
      });
    }
    return J;
  }

  /* ================= 3. 动作库 ================= */
  /* 每个动作：cycle = 一次重复几秒；view；fn(t) 返回关节角度。
     t 从 0 走到 1 表示做完一次动作。 */

  var ease = function (t) { return (1 - Math.cos(TAU * t)) / 2; };   // 0 → 1 → 0

  var ANIMS = {
    /* ---- 蹲 ---- */
    squat: { cycle: 2.4, view: "side", fn: function (t) {
      var e = ease(t);
      return { lean: 10 + 22 * e, hipL: 12 + 62 * e, hipR: 12 + 62 * e,
               kneeL: 16 + 88 * e, kneeR: 16 + 88 * e,
               armL: 8 + 62 * e, armR: 8 + 62 * e, elbL: 18 + 20 * e, elbR: 18 + 20 * e };
    } },
    halfSquat: { cycle: 2.2, view: "side", fn: function (t) {
      var e = ease(t);
      return { lean: 8 + 14 * e, hipL: 10 + 34 * e, hipR: 10 + 34 * e,
               kneeL: 14 + 48 * e, kneeR: 14 + 48 * e,
               armL: 6 + 40 * e, armR: 6 + 40 * e, elbL: 16, elbR: 16 };
    } },
    // 靠墙静蹲：大腿水平、小腿垂直、背贴墙，只有轻微呼吸起伏
    wallSit: { cycle: 5.5, view: "side", fn: function (t) {
      var b = Math.sin(TAU * t) * 0.5 + 0.5;
      return { lean: 4, hipL: 88, hipR: 88, kneeL: 90, kneeR: 90,
               armL: -6, armR: -6, elbL: 34, elbR: 34, bodyY: 0.006 * b };
    } },
    lunge: { cycle: 3.0, view: "side", fn: function (t) {
      var e = ease((t * 2) % 1);
      var first = t < 0.5;
      var fHip = 46 + 8 * e, fKnee = 44 + 46 * e;
      var bHip = -18 - 6 * e, bKnee = 26 + 44 * e;
      return { lean: 6,
               hipL: first ? fHip : bHip, kneeL: first ? fKnee : bKnee,
               hipR: first ? bHip : fHip, kneeR: first ? bKnee : fKnee,
               armL: -6, armR: -6, elbL: 20, elbR: 20 };
    } },

    /* ---- 开合 ---- */
    jack: { cycle: 1.05, view: "front", fn: function (t) {
      var e = ease(t);
      return { legSpread: 4 + 22 * e, kneeBend: 4 + 10 * e,
               armLift: 12 + 148 * e, elbow: 8,
               bodyY: 0.014 * Math.abs(Math.sin(TAU * t)) };
    } },

    /* ---- 跑跳 ---- */
    march: { cycle: 0.95, view: "side", fn: function (t) {
      var e = ease((t * 2) % 1), left = t < 0.5;
      var lh = 58 * e, lk = 72 * e;
      return { lean: 2,
               hipL: left ? lh : 0, kneeL: left ? lk : 6,
               hipR: left ? 0 : lh, kneeR: left ? 6 : lk,
               armL: left ? -22 * e : 22 * e, armR: left ? 22 * e : -22 * e,
               elbL: 34, elbR: 34 };
    } },
    highKnees: { cycle: 0.56, view: "side", fn: function (t) {
      var e = ease((t * 2) % 1), left = t < 0.5;
      var lh = 88 * e, lk = 96 * e;
      return { lean: 7,
               hipL: left ? lh : -4, kneeL: left ? lk : 8,
               hipR: left ? -4 : lh, kneeR: left ? 8 : lk,
               armL: left ? -34 * e : 30 * e, armR: left ? 30 * e : -34 * e,
               elbL: 62, elbR: 62 };
    } },
    fastFeet: { cycle: 0.42, view: "side", fn: function (t) {
      var e = ease((t * 2) % 1), left = t < 0.5;
      var lh = 26 * e, lk = 36 * e;
      return { lean: 5,
               hipL: left ? lh : -2, kneeL: left ? lk : 10,
               hipR: left ? -2 : lh, kneeR: left ? 10 : lk,
               armL: left ? -20 * e : 20 * e, armR: left ? 20 * e : -20 * e,
               elbL: 52, elbR: 52 };
    } },
    buttKicks: { cycle: 0.7, view: "side", fn: function (t) {
      var e = ease((t * 2) % 1), left = t < 0.5;
      var lk = 118 * e;
      return { lean: 4,
               hipL: left ? -10 * e : 0, kneeL: left ? lk : 8,
               hipR: left ? 0 : -10 * e, kneeR: left ? 8 : lk,
               armL: left ? -18 * e : 18 * e, armR: left ? 18 * e : -18 * e,
               elbL: 46, elbR: 46 };
    } },
    rope: { cycle: 0.52, view: "front", fn: function (t) {
      var hop = Math.abs(Math.sin(TAU * t));
      return { legSpread: 5, kneeBend: 10 + 24 * hop, armLift: 24, elbow: 76,
               bodyY: 0.052 * hop, wristSpin: t };
    } },
    burpee: { cycle: 2.6, view: "side", fn: function (t) {
      // 0 → 蹲下 0.3 → 起跳举手 0.55 → 落地 1
      var down = t < 0.3 ? t / 0.3 : (t < 0.55 ? 1 : Math.max(0, 1 - (t - 0.55) / 0.25));
      var jump = t >= 0.3 && t < 0.55 ? Math.sin(((t - 0.3) / 0.25) * Math.PI) : 0;
      var e = down;
      return { lean: 8 + 26 * e, hipL: 10 + 66 * e, hipR: 10 + 66 * e,
               kneeL: 14 + 92 * e, kneeR: 14 + 92 * e,
               armL: 10 + (140 - 10) * (jump > 0 ? jump : e * 0.5),
               armR: 10 + (140 - 10) * (jump > 0 ? jump : e * 0.5),
               elbL: 16, elbR: 16, bodyY: 0.11 * jump };
    } },
    lateralHop: { cycle: 0.62, view: "front", fn: function (t) {
      var hop = Math.abs(Math.sin(TAU * t));
      return { legSpread: 8, kneeBend: 8 + 26 * hop, armLift: 30, elbow: 30,
               bodyX: Math.sin(TAU * t) * 0.17, bodyY: 0.045 * hop };
    } },
    sideShuffle: { cycle: 0.7, view: "front", fn: function (t) {
      var e = ease((t * 2) % 1), left = t < 0.5;
      return { legSpread: 14, kneeBend: 12 + 16 * e, armLift: 26, elbow: 52,
               bodyX: (left ? -1 : 1) * 0.1 * e, bodyY: 0.02 * e };
    } },

    /* ---- 小腿 / 臀 / 台阶 ---- */
    calf: { cycle: 1.5, view: "side", fn: function (t) {
      var e = ease(t);
      return { lean: 2, hipL: 0, hipR: 0, kneeL: 6, kneeR: 6,
               armL: -6, armR: -6, elbL: 16, elbR: 16,
               footL: e, footR: e };
    } },
    // 臀桥：仰卧，肩与脚在地上，髋部抬起
    bridge: { cycle: 2.4, view: "side", fn: function (t) {
      var e = ease(t);
      return { rotate: 90, lean: -8 - 22 * e,
               hipL: 30 + 45 * e, hipR: 30 + 45 * e,
               kneeL: 70 + 35 * e, kneeR: 70 + 35 * e,
               armL: -84, armR: -84, elbL: 8, elbR: 8 };
    } },
    stepUp: { cycle: 1.9, view: "side", fn: function (t) {
      var e = ease((t * 2) % 1), left = t < 0.5;
      var lift = left ? e : 0;
      return { lean: 8,
               hipL: left ? 18 + 62 * lift : 6, kneeL: left ? 20 + 74 * lift : 8,
               hipR: left ? 6 : 18 + 62 * lift, kneeR: left ? 8 : 20 + 74 * lift,
               armL: left ? -16 * lift : 16 * lift, armR: left ? 16 * lift : -16 * lift,
               elbL: 40, elbR: 40, bodyY: 0.055 * e };
    } },

    /* ---- 核心 ---- */
    // 平板支撑：身体一条直线，小臂撑地，只有呼吸起伏
    plank: { cycle: 5.0, view: "side", fn: function (t) {
      var b = Math.sin(TAU * t) * 0.5 + 0.5;
      return { rotate: 74, lean: 0, hipL: 0, hipR: 0, kneeL: 4, kneeR: 4,
               armL: -74, armR: -74, elbL: 88, elbR: 88, bodyY: 0.004 * b };
    } },
    mountainClimber: { cycle: 0.66, view: "side", fn: function (t) {
      var e = ease((t * 2) % 1), left = t < 0.5;
      return { rotate: 74, lean: 0,
               hipL: left ? 78 * e : 0, kneeL: left ? 88 * e : 4,
               hipR: left ? 0 : 78 * e, kneeR: left ? 4 : 88 * e,
               armL: -74, armR: -74, elbL: 88, elbR: 88 };
    } },
    // 死虫式：仰卧，对侧手脚伸出
    deadBug: { cycle: 2.6, view: "side", fn: function (t) {
      var e = ease(t);
      return { rotate: 90, lean: 0,
               hipL: 90 - 84 * e, kneeL: 90 - 30 * e,
               hipR: 90, kneeR: 90,
               armL: 90 + 62 * e, armR: 90, elbL: 6, elbR: 6 };
    } },

    /* ---- 平衡 / 绕环 / 踢腿 ---- */
    // 单腿站立：侧视才看得见抬起来的那条腿
    balance: { cycle: 4.2, view: "side", fn: function (t) {
      var b = Math.sin(TAU * t);
      return { lean: 2,
               hipL: 62, kneeL: 76,          // 抬起的腿
               hipR: 0, kneeR: 4,            // 支撑腿
               armL: 56 + 5 * b, armR: -56 - 5 * b,   // 两臂张开找平衡
               elbL: 6, elbR: 6,
               bodyY: 0.004 * (0.5 + 0.5 * b) };
    } },
    jointCircle: { cycle: 3.0, view: "front", fn: function (t) {
      var e = ease(t);
      // 幅度收到 150°，再高手腕就顶出取景窗了
      return { legSpread: 6, kneeBend: 4, armLift: 14 + 136 * e, elbow: 12, wristSpin: t * 2 };
    } },
    kick: { cycle: 2.0, view: "side", fn: function (t) {
      var e = ease((t * 2) % 1), left = t < 0.5;
      return { lean: -4,
               hipL: left ? 72 * e : 0, kneeL: left ? 24 : 6,
               hipR: left ? 0 : 72 * e, kneeR: left ? 6 : 24,
               armL: left ? 18 : -18, armR: left ? -18 : 18, elbL: 24, elbR: 24 };
    } },

    /* ---- 拉伸 / 呼吸 ---- */
    stretchForward: { cycle: 4.5, view: "side", fn: function (t) {
      var e = ease(t);
      return { lean: 6 + 46 * e, hipL: 6 + 10 * e, hipR: 6 + 10 * e,
               kneeL: 6 + 22 * e, kneeR: 6 + 22 * e,
               armL: 6 + 60 * e, armR: 6 + 60 * e, elbL: 8, elbR: 8 };
    } },
    stretchQuad: { cycle: 4.2, view: "side", fn: function (t) {
      var b = Math.sin(TAU * t) * 0.5 + 0.5;
      return { lean: 2, hipL: -8, kneeL: 30 + 90 * b, hipR: 2, kneeR: 6,
               armL: -40, armR: 6, elbL: 40, elbR: 20, bodyY: 0.004 * b };
    } },
    stretchSide: { cycle: 4.4, view: "front", fn: function (t) {
      var b = Math.sin(TAU * t);
      return { legSpread: 10, kneeBend: 6, armLift: 150, elbow: 12,
               bodyX: b * 0.05 };
    } },
    sitReach: { cycle: 4.6, view: "side", fn: function (t) {
      var e = ease(t);
      return { rotate: 90, lean: 118 + 56 * e,
               hipL: 2, hipR: 2, kneeL: 4, kneeR: 4,
               armL: 0 + 6 * e, armR: 0 + 6 * e, elbL: 4, elbR: 4 };
    } },
    breathe: { cycle: 6.5, view: "front", fn: function (t) {
      var e = ease(t);
      return { legSpread: 8, kneeBend: 3, armLift: 10 + 80 * e, elbow: 26,
               bodyY: 0.012 * e };
    } },
    rest: { cycle: 5.0, view: "side", fn: function (t) {
      var b = Math.sin(TAU * t) * 0.5 + 0.5;   // 必须 ≥0，否则摆动会把脚压到地面以下
      return { lean: 1, hipL: 2, hipR: 2, kneeL: 4, kneeR: 4,
               armL: -22, armR: -22, elbL: 62, elbR: 62, bodyY: 0.008 * b };
    } }
  };

  // 动作 id → 演示动画
  var EX_ANIM = {
    jointCircle: "jointCircle", marchInPlace: "march", dynamicKick: "kick",
    halfSquatWarm: "halfSquat", jumpingJacks: "jack", fastFeet: "fastFeet",
    highKnees: "highKnees", buttKicks: "buttKicks", jumpRope: "rope",
    wallSit: "wallSit", squat: "squat", lunge: "lunge", calfRaise: "calf",
    gluteBridge: "bridge", stepUp: "stepUp", plank: "plank",
    mountainClimber: "mountainClimber", deadBug: "deadBug", burpee: "burpee",
    lateralHop: "lateralHop", sideShuffle: "sideShuffle",
    singleLegBalance: "balance", sitReach: "sitReach",
    calfStretch: "stretchForward", quadStretch: "stretchQuad",
    hamStretch: "stretchForward", hipStretch: "stretchSide",
    backStretch: "stretchForward", breathe: "breathe", fullStretch: "stretchForward"
  };

  function animFor(exId) {
    var key = EX_ANIM[exId] || "rest";
    return { key: key, def: ANIMS[key] || ANIMS.rest };
  }

  function poseAt(animKey, t) {
    var def = ANIMS[animKey] || ANIMS.rest;
    var p = def.fn(t % 1);
    return def.view === "front" ? solveFront(p) : solveSide(p);
  }

  /* ================= 4. 画布渲染 ================= */

  var COLORS = {
    head: "#fde68a",
    headRim: "#f59e0b",
    torso: "#f97316",
    torsoFar: "#c2410c",
    limbNear: "#fb923c",
    limbFar: "#b45309",
    shoe: "#f8fafc",
    accent: "#5eead4"
  };

  function makeRenderer(canvas) {
    var ctx = canvas.getContext("2d");
    var scale = 1, originX = 0, originY = 0, cw = 0, ch = 0;
    // 取景窗口：按当前动作整个周期的包围盒自适应，站着/躺着都能填满画面
    var win = { w: 1.4, h: 1.4, cx: 0, cy: 0.6 };
    var winReady = false;

    function resize() {
      var rect = canvas.getBoundingClientRect();
      var w = Math.max(0, Math.round(rect.width));
      var h = Math.max(0, Math.round(rect.height));
      // 离屏 canvas（测试里拼"动作总览图"用的）量不到尺寸，退回用属性尺寸，
      // 否则 scale 会算成 0，画出来一片空白
      var detached = !w || !h;
      if (detached) { w = canvas.width || 1; h = canvas.height || 1; }
      var dpr = detached ? 1 : Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cw = w; ch = h;
      winReady = false;          // 画布尺寸变了，下一帧重新贴合
    }

    function bboxInto(b, J) {
      var scan = function (p) {
        if (p.x < b.minX) b.minX = p.x;
        if (p.x > b.maxX) b.maxX = p.x;
        if (p.y < b.minY) b.minY = p.y;
        if (p.y > b.maxY) b.maxY = p.y;
      };
      J.arms.forEach(function (a) { a.pts.forEach(scan); });
      J.legs.forEach(function (l) { l.pts.forEach(scan); });
      scan(J.head); scan(J.hip); scan(J.neck);
      return b;
    }

    // 用整个周期的包围盒定窗口（而不是当前帧），否则人一动画面就跟着缩放，看着晃
    function setAnim(animKey) {
      var b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      for (var i = 0; i < 16; i++) bboxInto(b, poseAt(animKey, i / 16));
      if (!isFinite(b.minX)) return;
      win.animKey = animKey;
      win.minX = b.minX; win.maxX = b.maxX; win.minY = b.minY; win.maxY = b.maxY;
      winReady = false;
    }

    function updateWindow() {
      if (win.minX == null) return;
      var PAD_X = 0.20, PAD_Y = 0.18;
      var tw = Math.max((win.maxX - win.minX) + PAD_X * 2, 0.78);
      var th = Math.max((win.maxY - win.minY) + PAD_Y * 2, 1.22);
      var tcx = (win.minX + win.maxX) / 2;
      var tcy = (win.minY + win.maxY) / 2;
      // 让窗口宽高比跟画布一致，contain 之后才不会上下留白
      var aspect = cw / ch;
      if (tw / th < aspect) tw = th * aspect; else th = tw / aspect;

      if (!winReady) {
        win.w = tw; win.h = th; win.cx = tcx; win.cy = tcy;
        winReady = true;
      } else {
        var k = 0.16;
        win.w += (tw - win.w) * k;
        win.h += (th - win.h) * k;
        win.cx += (tcx - win.cx) * k;
        win.cy += (tcy - win.cy) * k;
      }
      scale = Math.min(cw / win.w, ch / win.h) * 0.94;
      originX = cw / 2;
      originY = ch / 2;
    }

    function px(pt) {
      return { X: originX + (pt.x - win.cx) * scale, Y: originY - (pt.y - win.cy) * scale };
    }

    function limb(pts, width, color) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      pts.forEach(function (pt, i) {
        var p = px(pt);
        if (i === 0) ctx.moveTo(p.X, p.Y); else ctx.lineTo(p.X, p.Y);
      });
      ctx.stroke();
    }

    function draw(J, t) {
      updateWindow();
      ctx.clearRect(0, 0, cw, ch);

      // 地面
      var g = px({ x: 0, y: 0 });
      ctx.strokeStyle = "rgba(248,250,252,0.16)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(originX - win.w * scale * 0.46, g.Y);
      ctx.lineTo(originX + win.w * scale * 0.46, g.Y);
      ctx.stroke();

      // 远侧手脚 → 躯干 → 近侧手脚 → 头，按深度排序
      var items = [];
      J.arms.forEach(function (a) { items.push({ z: a.z, kind: "limb", pts: a.pts, w: 0.052, near: a.near, isArm: true }); });
      J.legs.forEach(function (l) { items.push({ z: l.z, kind: "limb", pts: l.pts, w: 0.068, near: l.near, isArm: false }); });
      items.push({ z: 2.5, kind: "torso" });
      items.sort(function (a, b) { return a.z - b.z; });

      items.forEach(function (it) {
        if (it.kind === "torso") {
          var col = ctx.createLinearGradient(0, px(J.neck).Y, 0, px(J.hip).Y);
          col.addColorStop(0, COLORS.torso);
          col.addColorStop(1, COLORS.torsoFar);
          limb(J.spine, 0.115 * scale, col);
          return;
        }
        limb(it.pts, it.w * scale, it.near ? COLORS.limbNear : COLORS.limbFar);
        // 鞋
        if (!it.isArm) {
          var ankle = it.pts[it.pts.length - 2], toe = it.pts[it.pts.length - 1];
          var a = px(ankle), b = px(toe);
          ctx.strokeStyle = it.near ? COLORS.shoe : "#94a3b8";
          ctx.lineWidth = 0.045 * scale;
          ctx.beginPath();
          ctx.moveTo(a.X, a.Y);
          ctx.lineTo(b.X, b.Y);
          ctx.stroke();
        }
      });

      // 头
      var h = px(J.head);
      ctx.fillStyle = COLORS.head;
      ctx.beginPath();
      ctx.arc(h.X, h.Y, J.headR * scale, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = COLORS.headRim;
      ctx.lineWidth = Math.max(1.5, 0.012 * scale);
      ctx.stroke();

      // 发力提示：动作最"用力"的两帧给个光环
      var pulse = Math.abs(Math.sin(TAU * t));
      if (pulse > 0.82) {
        ctx.strokeStyle = "rgba(94,234,212," + ((pulse - 0.82) / 0.18 * 0.55).toFixed(3) + ")";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(h.X, h.Y, (J.headR + 0.05) * scale, 0, TAU);
        ctx.stroke();
      }
    }

    return { resize: resize, draw: draw, setAnim: setAnim };
  }

  /* ================= 5. 浮层控制 ================= */

  /* ---- 分段（segment）----
   * 一次"项目"不再是一段连续时间，而是一串分段：
   *   [{kind:"work", seconds:30, setNo:1, setCount:3}, {kind:"rest", seconds:30}, ...]
   * 原地小步跑 3 组 × 30 秒、组间歇 30 秒 = work/rest/work/rest/work，共 150 秒。
   * 大倒计时显示的是**当前这一段自己**的剩余时间（每个 30 秒都有独立倒计时），
   * 总进度走阶段条 + 底部进度条；过半语音只在 work 段里说。
   */
  var state = {
    open: false,
    exId: "",
    animKey: "rest",
    workAnimKey: "rest",
    cycle: 2,
    segments: [],
    total: 0,
    left: 0,
    phaseIndex: -1,
    phaseKind: "work",
    segLeft: 0,
    halfKey: -1,          // 已经播过"还剩一半"的段序号（-1 = 还没播）
    halfFlash: 0,
    paused: false,
    finished: false,
    finishedT: 0,
    hint: "",
    raf: null,
    t0: 0,
    frozenT: 0,
    onPause: null,
    onClose: null,
    el: null,
    renderer: null,
    videoUrl: "",
    videoUrls: {},
    restUrl: "",
    videoEl: null,
    prepActive: false,    // 是否正在播「就位口令 + 数 3、2、1」
    prepDone: false,
    prepStep: 0,
    prepTimers: [],
    prepDoneCb: null,     // 这一次口令数完之后要调谁（开场=起表；段前=复活挂钟）
    onPrepEnd: null,
    // 循环训练：每一段新动作开始前都要重新走一遍「就位口令 + 数 3、2、1」
    cuePerSegment: false,
    cueIdx: -1,           // 已经处理过口令的段序号
    lastCueEx: "",        // 上一次已经念过口令的动作 id（开场口令也会写进来）
    cueExId: "",
    cueName: "",
    pendingCue: null,     // enterPhase 换好视频源之后再兑现的段前口令
    prepMode: "",         // "open" = 开场；"segment" = 换动作
    prepStartedAt: 0,
    onSegCueStart: null,  // 段前口令开始 → 通知调用方把挂钟停住
    onSegCueEnd: null     // 段前口令结束 → 通知调用方把停掉的时间补回去
  };

  function $(id) { return document.getElementById(id); }

  // 统一取时间戳，方便测试时替换
  function now() { return performance.now(); }

  function buildOnce() {
    if (state.el) return;
    var el = $("coachTimer");
    if (!el) return;
    state.el = el;
    var cv = $("coachCanvas");
    if (cv) state.renderer = makeRenderer(cv);
    var vid = $("coachVideo");
    if (vid) {
      state.videoEl = vid;
      // 视频加载失败（文件被删/改名/格式不支持）时别留一块黑，回落到画布动画
      vid.addEventListener("error", function () {
        if (!state.open || !state.videoUrl) return;
        state.videoUrl = "";
        vid.classList.add("hidden");
        var cv2 = $("coachCanvas");
        if (cv2) cv2.classList.remove("hidden");
        if (state.renderer) state.renderer.resize();
      });
    }

    var pauseBtn = $("coachPauseBtn");
    if (pauseBtn) pauseBtn.addEventListener("click", function () {
      if (typeof state.onPause === "function") state.onPause();
    });
    var closeBtn = $("coachCloseBtn");
    if (closeBtn) closeBtn.addEventListener("click", function () {
      if (typeof state.onClose === "function") state.onClose();
    });
    // 孩子已经站好了、不想等 → 一点就开始（默认走完整口令，需要时才点）
    var prepSkip = $("coachPrepSkip");
    if (prepSkip) prepSkip.addEventListener("click", function (ev) {
      ev.stopPropagation();
      endPrep(false);
    });
    // 点空白处 = 结束
    el.addEventListener("click", function (ev) {
      if (ev.target === el && typeof state.onClose === "function") state.onClose();
    });
    document.addEventListener("keydown", function (ev) {
      if (!state.open) return;
      if (ev.key === "Escape" && typeof state.onClose === "function") state.onClose();
      if (ev.key === " " && typeof state.onPause === "function") { ev.preventDefault(); state.onPause(); }
    });
    window.addEventListener("resize", function () {
      if (state.open && state.renderer) state.renderer.resize();
    });
  }

  function frame() {
    if (!state.open) return;
    state.raf = requestAnimationFrame(frame);
    // 准备阶段（口令 + 数数）：画面保持静止，等数完再动
    if (state.prepActive) return;
    // 休息段：整块是倒计时面板，不用画任何骨架/动画
    if (state.phaseKind === "rest") return;
    // 有跟做视频时，视频自己播放，不再渲染 canvas 动画
    if (state.videoUrl) return;
    var def = ANIMS[state.animKey] || ANIMS.rest;
    var cycle = def.cycle || 2;
    var t = state.paused ? (state.frozenT || 0) : ((performance.now() - state.t0) / 1000 / cycle) % 1;
    if (state.paused) state.frozenT = t;
    if (state.renderer) {
      try { state.renderer.draw(poseAt(state.animKey, t), t); } catch (e) {}
    }
  }

  /* ---- 小工具 ---- */

  function setText(id, text) {
    var el = $(id);
    if (el) el.textContent = text == null ? "" : String(text);
  }

  function fmt(sec) {
    var s = Math.max(0, Math.ceil(sec));
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }

  // 把 open 的入参整理成分段数组（老写法只给 seconds 也兼容）
  function segmentsOf(opts) {
    var list = [];
    var raw = (opts && opts.segments) || null;
    if (raw && raw.length) {
      for (var i = 0; i < raw.length; i++) {
        var s = raw[i] || {};
        var sec = Number(s.seconds) || 0;
        if (sec <= 0) continue;
        list.push({
          kind: s.kind === "rest" ? "rest" : "work",
          seconds: sec,
          setNo: Number(s.setNo) || 0,
          setCount: Number(s.setCount) || 0,
          exId: s.exId || "",
          label: s.label || "",
          animKey: s.animKey || "",
          sides: Number(s.sides) || 1
        });
      }
    }
    if (!list.length) {
      var only = Math.max(0, Number(opts && opts.seconds) || 0);
      if (only > 0) {
        list.push({
          kind: "work", seconds: only, setNo: 1, setCount: 1,
          exId: (opts && opts.exId) || "", label: "", animKey: "", sides: 1
        });
      }
    }
    return list;
  }

  // 按"已经过去的秒数"定位到第几段、这一段还剩多少
  function phaseAt(elapsed) {
    var segs = state.segments;
    var acc = 0;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (elapsed < acc + s.seconds) {
        return { index: i, seg: s, leftIn: acc + s.seconds - elapsed, elapsedIn: elapsed - acc };
      }
      acc += s.seconds;
    }
    var last = segs[segs.length - 1];
    if (!last) return { index: -1, seg: { kind: "work", seconds: 0, sides: 1 }, leftIn: 0, elapsedIn: 0 };
    return { index: segs.length - 1, seg: last, leftIn: 0, elapsedIn: last.seconds };
  }

  // 阶段条：一段一根，work 橙 / rest 青，里面那条 <i> 表示这一段自己的进度
  function buildPhaseStrip() {
    var wrap = $("coachPhases");
    if (!wrap) return;
    wrap.innerHTML = "";
    // 只有一段（单组动作）时阶段条没有意义，藏起来免得跟总进度条重复
    var many = state.segments.length > 1;
    wrap.classList.toggle("hidden", !many);
    if (!many) return;
    state.segments.forEach(function (seg, i) {
      var d = document.createElement("div");
      d.className = "ph " + (seg.kind === "rest" ? "rest" : "work");
      d.title = (seg.kind === "rest"
        ? "组间休息 "
        : (seg.setCount > 1 ? "第 " + seg.setNo + " 组 " : "") + (seg.label ? seg.label + " " : "")) +
        Math.round(seg.seconds) + " 秒";
      var fill = document.createElement("i");
      d.appendChild(fill);
      // 宽度按时长分配（超过 60 秒按 60 算，免得一个长拉伸把整条吃掉）
      d.style.flexGrow = String(Math.min(60, Math.max(5, seg.seconds)));
      wrap.appendChild(d);
    });
  }

  function paintPhaseStrip(index, elapsedIn) {
    var wrap = $("coachPhases");
    if (!wrap) return;
    var nodes = wrap.children;
    for (var i = 0; i < nodes.length; i++) {
      var seg = state.segments[i];
      var n = nodes[i];
      var fill = n.firstChild;
      if (!seg || !fill) continue;
      var isNow = i === index;
      var isDone = i < index;
      n.classList.toggle("is-now", isNow);
      n.classList.toggle("is-done", isDone);
      var pct = isDone ? 100 : (isNow && seg.seconds > 0 ? (elapsedIn / seg.seconds) * 100 : 0);
      fill.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + "%";
    }
  }

  /* 安全播放：`<video>.play()` 返回的是 Promise，被 `pause()`/换源打断时
   * 会**异步**抛出 AbortError，`try/catch` 根本抓不到 —— 它只会变成
   * 控制台里的未捕获拒绝。准备阶段正好是"先 pause 定首帧、倒计时结束再 play"，
   * 切换动作时也频繁 pause，所以这里必须显式吞掉这个 Promise。
   * 返回值含义：true = 真的开始播了，false = 被打断/被策略拦（调用方无需处理）。 */
  function playSafe(el) {
    if (!el) return false;
    try {
      var p = el.play();
      if (p && p.catch) p.catch(function () {});
      return true;
    } catch (e) { return false; }
  }

  // 切换到某个视频地址（"" = 回到画布动画）。
  // 运动段用该动作自己的跟做视频；休息段用项目自带的中场休息视频。
  function switchVideoTo(url) {
    url = url || "";
    if (url === state.videoUrl) return;
    state.videoUrl = url;
    var vid = state.videoEl, cv = $("coachCanvas");
    if (!vid) return;
    try { vid.pause(); } catch (e) {}
    if (url) {
      vid.src = url;
      vid.classList.remove("hidden");
      if (cv) cv.classList.add("hidden");
      // 准备阶段（口令+数数）还没走完时不要自动播 ——
      // 否则视频会先闪一下再被暂停，既破坏"停在首帧"的效果，也白白抛一次 AbortError。
      if (!state.paused && !state.finished && !state.prepActive) {
        playSafe(vid);
      }
    } else {
      vid.removeAttribute("src");
      try { vid.load(); } catch (e) {}
      vid.classList.add("hidden");
      if (cv) cv.classList.remove("hidden");
      if (state.renderer) state.renderer.resize();
    }
  }

  // 兼容旧调用：按动作 id 找它自己的跟做视频
  function switchVideo(exId) {
    switchVideoTo(exId ? (state.videoUrls[exId] || "") : "");
  }

  // 进入某一段：换演示动画、换配色、给个提示音
  function enterPhase(ph) {
    var prev = state.phaseIndex;
    state.phaseIndex = ph.index;
    state.phaseKind = ph.seg.kind;
    state.segLeft = ph.leftIn;
    var seg = ph.seg;

    /* 休息段：**不播任何演示**。
     * 之前休息时会切到中场休息视频 / 画一个简单动画，孩子看着画面反而忘了休息，
     * 现在改成整块换成一个大倒计时，干净、明确、一眼就知道还有多久。 */
    if (seg.kind === "rest") {
      switchVideoTo("");          // 视频停掉并撤下
      showRestPanel(true);
      paintRestPanel(ph);
      if (prev >= 0 && prev !== ph.index && !state.finished) audio.beep(2, 620);
      if (state.el) {
        state.el.classList.add("is-rest");
        state.el.classList.remove("is-rest-warn");
      }
      return;
    }

    // 运动段：该动作自己的跟做视频；没有视频时回落到画布上的动作演示动画
    switchVideoTo(state.videoUrls[seg.exId || state.exId] || "");
    showRestPanel(false);

    var key = ph.seg.animKey ||
      (ph.seg.exId ? animFor(ph.seg.exId).key : state.workAnimKey);
    if (key !== state.animKey) {
      state.animKey = key;
      var def = ANIMS[key] || ANIMS.rest;
      state.cycle = def.cycle || 2;
      if (state.renderer) state.renderer.setAnim(key);
      // 换动作时把演示重新从头播，孩子看到的第一个动作是完整的
      if (!state.paused) { state.t0 = performance.now(); state.frozenT = 0; }
    }

    if (prev >= 0 && prev !== ph.index && !state.finished) {
      audio.beep(1, 990);                          // 休息结束 → 下一组
    }

    if (state.el) {
      state.el.classList.remove("is-rest", "is-rest-warn");
    }
  }

  // 休息面板：显示 / 收起（收起时把画布和视频的可见性交回原逻辑）
  function showRestPanel(on) {
    var panel = $("coachRest");
    var cv = $("coachCanvas");
    var vid = $("coachVideo");
    if (panel) panel.classList.toggle("hidden", !on);
    if (on) {
      if (cv) cv.classList.add("hidden");
      if (vid) vid.classList.add("hidden");
    } else {
      // 运动段：有视频就显示视频，否则显示画布
      if (vid) vid.classList.toggle("hidden", !state.videoUrl);
      if (cv) cv.classList.toggle("hidden", !!state.videoUrl);
    }
  }

  // 大倒计时 + 下一组提示
  function paintRestPanel(ph) {
    var s = Math.max(0, Math.ceil(ph.leftIn));
    setText("coachRestCount", fmt(s));
    setText("coachRestNext", nextWorkLabel(ph));
    var hint = $("coachRestHint");
    if (hint) {
      hint.textContent = ph.leftIn <= 3
        ? "准备，马上开始下一组！"
        : "慢慢呼吸，喝两口水，下一组还要用劲。";
    }
    // 最后 3 秒整块变红闪一下，孩子不用盯着数字也能感觉到
    if (state.el) state.el.classList.toggle("is-rest-warn", ph.leftIn <= 3 && ph.leftIn > 0);
  }

  // 休息时告诉孩子"接下来是什么"，避免一睁眼不知道要干嘛
  function nextWorkLabel(ph) {
    var segs = state.segments;
    for (var i = ph.index + 1; i < segs.length; i++) {
      if (segs[i].kind !== "work") continue;
      var nxt = segs[i];
      var who = nxt.label || (nxt.exId ? exNameOf(nxt.exId) : (state.name || "下一个动作"));
      var doing = nxt.setCount > 1 ? "第 " + nxt.setNo + " 组" : "";
      return "接下来：" + who + (doing ? " · " + doing : "") + "（" + Math.round(nxt.seconds) + " 秒）";
    }
    return "接下来：全部做完了，准备好收尾。";
  }

  function exNameOf(exId) {
    if (typeof FITNESS_EX !== "undefined" && FITNESS_EX[exId]) return FITNESS_EX[exId].name;
    return exId || "";
  }

  function paintHint(ph, segLeft) {
    var hint = $("coachHint");
    if (!hint) return;
    if (state.finished) { hint.textContent = "完美结束！记得在清单上打勾。"; return; }
    if (state.paused) { hint.textContent = "已暂停，点「继续」接着做。"; return; }
    // 过半那一嗓子，让文字跟语音一起亮两秒多（否则会被下面的"过半了"立刻覆盖）
    if (state.halfFlash && performance.now() < state.halfFlash) { hint.textContent = "坚持，还剩一半！"; return; }
    var s = Math.ceil(segLeft);
    if (ph.seg.kind === "rest") {
      hint.textContent = (s <= 3 && s > 0)
        ? "休息快结束了，准备下一组！"
        : "慢慢呼吸，喝两口水，下一组还要用劲。";
      return;
    }
    if (s <= 3 && s > 0) { hint.textContent = "最后 " + s + " 秒，坚持住！"; return; }
    if (ph.seg.sides === 2 && ph.elapsedIn >= ph.seg.seconds / 2) { hint.textContent = "换另一侧，接着做！"; return; }
    if (segLeft <= ph.seg.seconds / 2) { hint.textContent = "过半了，保持节奏，呼吸别乱。"; return; }
    hint.textContent = state.hint || "跟着教练的节奏做，注意呼吸不要憋气。";
  }

  /* ---- 开练准备：口令 + 人声数 3、2、1 ----
   *
   * 需求：每个运动开始前说「准备开始进行XX，请就位」，然后人声倒数 1、2、3 再开始。
   * 做法：先播口令，等口令**真正念完**再开始数，屏幕上同步跳数字；
   *       数到「开始」之后再等一拍才放行计时。
   */
  var PREP_COUNT_MS = 1000;      // 每个数字占 1 秒（和"一二三"的语速节奏对得上）
  var PREP_AFTER_GO_MS = 620;    // "开始"念完之后再留一点余量才真正开跑
  var PREP_CUE_MS = 4600;        // 拿不到音频真实时长时的兜底：口令最长约 4.5 秒，宁可多等
  var PREP_TAIL_MS = 260;        // 口令余韵留一点，别让数字咬在最后一个字上

  /* 段前口令：循环训练里每换一个动作都要重新走一遍"口令 + 数 3、2、1"。
   * mode = "open"（开场，数完由调用方起表）
   *      = "segment"（换动作，数完由调用方把停住的时间补回去，动作时间一秒不少） */
  function startPrep(opts, mode) {
    opts = opts || {};
    var prep = $("coachPrep");
    state.prepMode = mode || "open";
    state.prepStartedAt = now();
    if (!prep) { endPrep(); return; }

    state.prepActive = true;
    state.prepDone = false;
    state.prepStep = 0;          // 0=说口令 1/2/3=数数 4=go
    prep.classList.remove("hidden");

    setText("coachPrepName", (opts.name || "训练"));
    setText("coachPrepCount", "");
    setText("coachPrepSub", state.prepMode === "segment"
      ? "换动作了，站好位置"
      : "听口令，站到位置上");

    // 通知调用方：口令期间把挂钟停住（换动作时的口令不占动作时间）
    if (state.prepMode === "segment" && typeof state.onSegCueStart === "function") {
      state.onSegCueStart();
    }

    // 准备阶段演示区：有跟做视频就把视频**定在首帧、不播放**，
    // 让孩子先看清起始姿势；没有视频才退回落定的画布静态帧。
    showPrepPreview();

    // 口令：优先用预生成 mp3（缺失时自动退回系统 TTS）
    audio.ready(opts.exId || state.exId, opts.name || "");

    /* 关键：不能当场读 duration（那时恒为 NaN），要等元数据加载完。
     * 拿到真实时长 → 数数正好接在口令后面；拿不到 → 用保守兜底值，宁可多等别抢拍。 */
    audio.cueDuration(1500).then(function (dur) {
      if (!state.prepActive) return;             // 期间被"跳过准备"或关掉了
      var cueMs = (dur && isFinite(dur) && dur > 0.4)
        ? Math.round(dur * 1000) + PREP_TAIL_MS
        : PREP_CUE_MS;
      schedulePrepCounts(cueMs);
    });
  }

  // 按"口令结束时刻"排好 3、2、1、开始
  function schedulePrepCounts(cueMs) {
    var seq = [
      { at: cueMs, n: 3 },
      { at: cueMs + PREP_COUNT_MS, n: 2 },
      { at: cueMs + PREP_COUNT_MS * 2, n: 1 },
      { at: cueMs + PREP_COUNT_MS * 3, n: "go" }
    ];

    seq.forEach(function (step, i) {
      state.prepTimers.push(setTimeout(function () {
        if (!state.prepActive) return;
        if (step.n === "go") {
          setText("coachPrepCount", "开始");
          setText("coachPrepSub", "动起来！");
          audio.count("go");
        } else {
          setText("coachPrepCount", String(step.n));
          setText("coachPrepSub", step.n === 3 ? "准备…" : "马上");
          audio.count(step.n);
        }
        state.prepStep = i + 1;
      }, step.at));
    });

    state.prepTimers.push(setTimeout(function () {
      endPrep(true);
    }, cueMs + PREP_COUNT_MS * 3 + PREP_AFTER_GO_MS));
  }

  /* 准备阶段的演示预览：视频停在首帧（paused），画布画一帧静止动作。
   * 需求原话："倒计时导入的演示视频不要播放，要显示视频首帧但是要暂停，
   *            等倒计时结束再播放。" */
  function showPrepPreview() {
    var cv = $("coachCanvas"), vid = $("coachVideo");

    if (vid && state.videoUrl) {
      // 有视频：显示它、定位到首帧、明确暂停
      vid.classList.remove("hidden");
      if (cv) cv.classList.add("hidden");
      try {
        vid.pause();
        /* 只有"已经播到一半"才需要拉回首帧。刚换的新 src 本来就在第 0 帧，
         * 无条件写 currentTime=0 会白发一次字节范围请求，Chrome 在 file:// 下
         * 可能回 ERR_REQUEST_RANGE_NOT_SATISFIABLE（无害，但会污染控制台，
         * 掩盖真正的问题）。 */
        var rewind = function () {
          try { if (vid.currentTime > 0.01) vid.currentTime = 0; } catch (e) {}
          try { vid.pause(); } catch (e) {}
        };
        if (vid.readyState >= 1) {
          rewind();
        } else {
          // 元数据还没到，等到了再判断；避免出现黑屏
          var onMeta = function () {
            vid.removeEventListener("loadedmetadata", onMeta);
            rewind();
          };
          vid.addEventListener("loadedmetadata", onMeta);
        }
      } catch (e) {}
      if (state.renderer) state.renderer.resize();
      return;
    }

    // 没视频：画布保持可见，画一帧**静止**的起始姿势（不跑动画）
    if (vid) vid.classList.add("hidden");
    if (cv) cv.classList.remove("hidden");
    if (state.renderer) {
      state.renderer.resize();
      try {
        // t=0 即该动作的起始姿态；画完就停，frame() 在准备阶段直接 return
        state.renderer.draw(poseAt(state.animKey, 0), 0);
      } catch (e) {}
    }
  }

  /* 结束准备：收起面板、恢复演示、真正开始跑。
   * 两种模式收尾方式不同：
   *   open    —— 开场口令我念完了，通知调用方起表（onPrepEnd）
   *   segment —— 换动作口令我念完了，通知调用方把停住的时间补回去（onSegCueEnd），
   *              并且**不重新起滴答声**（它本来就没停过，重复 startTick 会从头再播） */
  function endPrep(playCue) {
    if (!state.prepActive) return;
    var mode = state.prepMode || "open";
    state.prepActive = false;
    state.prepDone = true;
    state.prepTimers.forEach(function (t) { clearTimeout(t); });
    state.prepTimers = [];
    audio.stopCue();

    var prep = $("coachPrep");
    if (prep) prep.classList.add("hidden");
    // 恢复画布/视频可见性（运动段优先视频）
    var cv = $("coachCanvas"), vid = $("coachVideo");
    if (vid) vid.classList.toggle("hidden", !state.videoUrl);
    if (cv) cv.classList.toggle("hidden", !!state.videoUrl);

    // 演示动画/视频从这一秒开始，前面准备的时间不占用动作时间
    state.t0 = performance.now();
    state.frozenT = 0;
    if (state.videoEl && state.videoUrl && !state.paused) {
      // 首帧已停在 currentTime=0，从这里开始播就是完整的第一帧起
      playSafe(state.videoEl);
    }

    if (mode === "segment") {
      // 换动作：滴答声一直在响，这里不要碰它；把停掉的时长还给调用方
      if (typeof state.onSegCueEnd === "function") state.onSegCueEnd();
      state.prepMode = "";
      return;
    }

    audio.startTick();
    state.prepMode = "";
    if (typeof state.onPrepEnd === "function") state.onPrepEnd();
  }

  /* ---- 独立可复用的「口令 + 人声数 3、2、1」流程 ----
   *
   * 场景：体感跟练里，校准锁定之后孩子还站在离电脑两三米远的地方。
   *       要他先跑过来点「开始这一组」不现实 —— 应该由页面自己喊一声
   *       「准备开始进行XX，请就位」，再人声数 3、2、1，数到"开始"就自动开练。
   *
   * 和计时器里的 startPrep 是同一套语音素材、同一套节奏，但它**不依赖
   * coachTimer 那个浮层**（体感跟练根本不开浮层），所以单独实现一份，
   * 只借用 audio 对象的能力。数到"开始"时 resolve(true)。
   *
   * 返回 { promise, cancel }：
   *   promise —— 数完"开始"后 resolve(true)；被 cancel 则一直不 resolve（调用方靠 cancel 语义收尾）
   *   cancel  —— 立刻停下所有已排的定时器与正在播的人声
   */
  function prepSequence(exId, name, opts) {
    opts = opts || {};
    var countMs = opts.countMs == null ? PREP_COUNT_MS : opts.countMs;
    var afterGo = opts.afterGoMs == null ? PREP_AFTER_GO_MS : opts.afterGoMs;
    var cueFallback = opts.cueFallbackMs == null ? PREP_CUE_MS : opts.cueFallbackMs;
    var tail = opts.tailMs == null ? PREP_TAIL_MS : opts.tailMs;
    var timers = [];
    var api = { cancelled: false, finished: false, promise: null };

    function clearAll() {
      timers.forEach(function (t) { clearTimeout(t); });
      timers = [];
    }

    if (typeof opts.onStep === "function") {
      // 先告诉界面"要开始了"，好在口令期间就把大字摆出来（不必等拿到时长）
      try { opts.onStep("cue", 0); } catch (e) {}
    }

    api.promise = new Promise(function (resolve) {
      audio.ready(exId, name);
      /* 关键：不能当场读 duration（那时恒为 NaN），要等元数据加载完。
       * 拿到真实时长 → 数数正好接在口令后面；拿不到 → 用保守兜底值，
       * 宁可多等也别抢拍（抢拍听感就是"没念完口令直接数数"）。 */
      audio.cueDuration(1500).then(function (dur) {
        if (api.cancelled) return;
        var cueMs = (dur && isFinite(dur) && dur > 0.4)
          ? Math.round(dur * 1000) + tail
          : cueFallback;
        [3, 2, 1, "go"].forEach(function (n, i) {
          timers.push(setTimeout(function () {
            if (api.cancelled) return;
            audio.count(n);
            if (typeof opts.onStep === "function") {
              try { opts.onStep(n, i + 1); } catch (e) {}
            }
          }, cueMs + countMs * i));
        });
        timers.push(setTimeout(function () {
          if (api.cancelled) return;
          api.finished = true;
          clearAll();
          resolve(true);
        }, cueMs + countMs * 3 + afterGo));
      });
    });

    api.cancel = function () {
      if (api.cancelled || api.finished) return;
      api.cancelled = true;
      clearAll();
      audio.stopCue();
    };
    return api;
  }

  /* 循环训练换动作：先停下来把口令念完，等数到"开始"再让时间接着走。
   * 判定原则 —— 只有"这一段的动作和上一段的**动作不同**"才重新念口令。
   * 同一个动作的组间歇回来（第 1 组 → 第 2 组）不该再念一遍"准备开始进行平板支撑"，
   * 那样孩子只会觉得啰嗦；换动作才需要重新就位。
   * `state.lastCueEx` = 上一次已经念过口令的动作 id，开场口令也会写进去。
   *
   * 这里只"决定并占位"（把 prepActive 立起来 + 记下待念的口令），真正的
   * startPrep 放到 enterPhase 之后由 flushPendingCue() 执行 —— 因为
   * showPrepPreview() 要定格的是**新动作**的首帧，而视频源是 enterPhase 才换的。
   * 反过来如果先 startPrep 再 enterPhase，定格的会是上一个动作的视频。 */
  function maybeSegmentCue(ph) {
    if (!state.cuePerSegment || state.finished) return false;
    if (ph.index < 0 || ph.seg.kind !== "work") return false;
    if (ph.index === state.cueIdx) return false;      // 这一段已经处理过，别重复触发
    state.cueIdx = ph.index;                          // 先记账，避免每 200ms 重进
    var ex = ph.seg.exId || "";
    if (!ex || ex === state.lastCueEx) return false;  // 还是同一个动作，不念
    state.lastCueEx = ex;
    state.cueExId = ex;
    state.cueName = ph.seg.label || exNameOf(ex) || state.name || "下一个动作";
    state.pendingCue = { exId: ex, name: state.cueName };
    state.prepActive = true;      // 抢先立起来：enterPhase 才不会把新视频自动播起来
    return true;
  }

  // 视频源换好之后，真正开始播这一段的「准备开始进行XX，请就位」
  function flushPendingCue() {
    var p = state.pendingCue;
    if (!p) return;
    state.pendingCue = null;
    startPrep({ exId: p.exId, name: p.name }, "segment");
  }


  function render(leftTotal) {
    var left = Math.max(0, Number(leftTotal) || 0);
    state.left = left;
    var elapsed = Math.max(0, Math.min(state.total, state.total - left));
    var ph = phaseAt(elapsed);

    /* 循环训练：换到新动作的那一段，先停下来把「准备开始进行XX，请就位」念完
     * （再来 3、2、1）。必须在 enterPhase 之前判断，好让它知道"现在是准备阶段"，
     * 从而把新视频停在首帧而不是自动播起来；真正开念则等 enterPhase 换好源之后。 */
    var cuePending = maybeSegmentCue(ph);

    enterPhase(ph);

    // 源已换好，现在定格首帧 + 开口令（顺序反了会定格到上一个动作的画面）
    if (cuePending) {
      showPrepPreview();
      flushPendingCue();
    }

    setText("coachCount", fmt(ph.leftIn));
    setText("coachPhaseLabel", ph.seg.kind === "rest"
      ? "组间休息"
      : (state.segments.length > 1 ? "本组剩余" : "剩余时间"));

    var setline;
    if (ph.seg.kind === "rest") {
      setline = "组间休息 " + Math.round(ph.seg.seconds) + " 秒 · 全程还剩 " + fmt(left);
    } else if (ph.seg.setCount > 1) {
      setline = "第 " + ph.seg.setNo + " 组 / 共 " + ph.seg.setCount + " 组 · 全程还剩 " + fmt(left);
    } else if (ph.seg.label) {
      setline = ph.seg.label + " · 全程还剩 " + fmt(left);
    } else {
      setline = "全程还剩 " + fmt(left);
    }
    setText("coachSetLine", setline);
    setText("coachTag", ph.seg.kind === "rest" ? "组间休息" : "教练示范");

    paintPhaseStrip(ph.index, ph.elapsedIn);

    var bar = $("coachBar");
    if (bar && state.total > 0) bar.style.width = ((elapsed / state.total) * 100).toFixed(2) + "%";

    paintHint(ph, ph.leftIn);

    var pauseBtn = $("coachPauseBtn");
    if (pauseBtn) {
      pauseBtn.textContent = state.paused ? "继续" : "暂停";
      pauseBtn.disabled = !!state.finished;
    }
    if (state.el) {
      state.el.classList.toggle("is-paused", !!state.paused);
      state.el.classList.toggle("is-done", !!state.finished);
    }
  }

  function open(opts) {
    buildOnce();
    if (!state.el) return false;
    opts = opts || {};
    state.open = true;
    state.exId = opts.exId || "";
    state.videoUrls = opts.videoUrls || {};
    if (opts.videoUrl && state.exId && !state.videoUrls[state.exId]) {
      state.videoUrls[state.exId] = opts.videoUrl;
    }
    state.restUrl = opts.restUrl || "";
    state.videoUrl = "";
    var a = animFor(state.exId);
    state.workAnimKey = a.key;
    state.animKey = a.key;
    state.cycle = a.def.cycle || 2;
    state.segments = segmentsOf(opts);
    state.total = state.segments.reduce(function (sum, s) { return sum + s.seconds; }, 0);
    state.left = state.total;
    state.phaseIndex = -1;
    state.phaseKind = "work";
    state.segLeft = state.total;
    state.halfKey = -1;
    state.halfFlash = 0;
    state.paused = false;
    state.finished = false;
    state.finishedT = 0;
    state.hint = opts.how || "";
    state.onPause = opts.onPause || null;
    state.onClose = opts.onClose || null;
    // 准备阶段结束的回调：调用方用它来"正式开表"（口令时间不计入动作时间）
    state.onPrepEnd = opts.onPrepEnd || null;
    state.prepTimers.forEach(function (t) { clearTimeout(t); });
    state.prepTimers = [];
    state.prepActive = false;
    state.prepDone = false;
    state.prepStep = 0;
    state.prepMode = "";
    state.prepStartedAt = 0;
    /* 循环训练：每个动作段开始前都要说「准备开始进行XX，请就位」+ 数 3、2、1。
     * 由调用方（app.js）通过 opts.cuePerSegment 打开 —— 只有 loop 型计划才需要，
     * 单动作多组的项目每个组前都念会把 30 秒的组间歇切得七零八落。 */
    state.cuePerSegment = !!opts.cuePerSegment;
    state.cueIdx = -1;
    state.cueExId = "";
    state.cueName = "";
    // 开场说的是"循环训练"这句集合口令，所以第一段的动作还没念过 → 留空
    state.lastCueEx = opts.cueFirstExId || "";
    state.onSegCueStart = opts.onSegCueStart || null;
    state.onSegCueEnd = opts.onSegCueEnd || null;
    state.t0 = performance.now();
    state.frozenT = 0;

    // 首段具体动作在 render/enterPhase 中选择视频或演示动画。
    setText("coachEmoji", opts.emoji || "🏃");
    setText("coachExName", opts.name || "训练");
    setText("coachExHow", opts.how || "跟着教练的节奏做，注意呼吸不要憋气。");
    setText("coachCaption", opts.label || "");
    buildPhaseStrip();

    state.el.classList.remove("hidden", "is-paused", "is-done", "is-rest", "is-rest-warn");
    document.body.classList.add("coach-timer-open");
    if (state.renderer) { state.renderer.resize(); state.renderer.setAnim(state.animKey); }
    /* 先标记"准备阶段"再 render：render 会经 enterPhase → switchVideoTo 装载演示视频，
     * 若此刻还没标记，视频会先自动播起来、紧接着又被 startPrep 暂停，
     * 既闪一下首帧又抛一个 AbortError。先标记就一次都不播。 */
    var willPrep = opts.prep !== false;
    state.prepActive = willPrep;
    render(state.total);                 // 首次进入第 0 段（phaseIndex=-1 → 不响提示音）

    // 开练前先走"口令 + 人声数 3、2、1"。opts.prep === false 可跳过（重播/调试用）。
    if (!willPrep) {
      state.prepActive = false;
      state.prepDone = true;
      audio.startTick();
    } else {
      startPrep(opts);
    }
    if (!state.raf) state.raf = requestAnimationFrame(frame);
    return true;
  }

  function update(left) {
    if (!state.open) return;
    var prevLeft = state.left;
    var val = Math.max(0, Number(left) || 0);
    if (val > prevLeft + 0.001) state.halfKey = -1;   // 时间被往回拨（重新装载），允许再提示
    render(val);

    // 过半提示：只在这一段是"运动"、且按这一段自己的时长过半时才说
    var elapsed = Math.max(0, Math.min(state.total, state.total - state.left));
    var ph = phaseAt(elapsed);
    if (!state.finished && ph.seg.kind === "work" && ph.seg.seconds >= 8 &&
        state.halfKey !== ph.index && ph.leftIn <= ph.seg.seconds / 2) {
      state.halfKey = ph.index;
      state.halfFlash = performance.now() + 2600;
      audio.say("half", "坚持，还剩一半");
      paintHint(ph, ph.leftIn);
    }
  }

  function finish() {
    if (!state.open || state.finished) return;
    state.finished = true;
    state.finishedT = performance.now();
    if (state.videoEl) try { state.videoEl.pause(); } catch (e) {}
    audio.stopTick();
    audio.say("finish", "完美结束");
    if (state.el) {
      state.el.classList.add("is-done");
      state.el.classList.remove("is-rest", "is-rest-warn");
    }
    showRestPanel(false);
    setText("coachPhaseLabel", "全部完成");
    setText("coachSetLine", "");
    setText("coachHint", "完美结束！记得在清单上打勾。");
    var bar = $("coachBar");
    if (bar) bar.style.width = "100%";
    var wrap = $("coachPhases");
    if (wrap) {
      for (var i = 0; i < wrap.children.length; i++) {
        var n = wrap.children[i];
        n.classList.remove("is-now");
        n.classList.add("is-done");
        if (n.firstChild) n.firstChild.style.width = "100%";
      }
    }
    var pauseBtn = $("coachPauseBtn");
    if (pauseBtn) pauseBtn.disabled = true;
  }

  function setPaused(v) {
    state.paused = !!v;
    if (state.paused) {
      state.frozenT = ((performance.now() - state.t0) / 1000 / (state.cycle || 2)) % 1;
      audio.stopTick();
      if (state.videoEl) try { state.videoEl.pause(); } catch (e) {}
    } else {
      // 从冻结相位继续
      state.t0 = performance.now() - state.frozenT * (state.cycle || 2) * 1000;
      if (!state.finished) audio.startTick();
      if (state.videoEl && state.videoUrl) playSafe(state.videoEl);
    }
    render(state.left);
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = null; }
    // 准备阶段的定时器要清掉，否则浮层关了几秒还会突然数数
    state.prepActive = false;
    state.prepTimers.forEach(function (t) { clearTimeout(t); });
    state.prepTimers = [];
    audio.stopAll();
    document.body.classList.remove("coach-timer-open");
    if (state.el) state.el.classList.add("hidden");
    // 停止并清空视频
    if (state.videoEl) {
      try { state.videoEl.pause(); } catch (e) {}
      state.videoEl.src = "";
      state.videoEl.classList.add("hidden");
    }
    var cv = $("coachCanvas");
    if (cv) cv.classList.remove("hidden");
    var panel = $("coachRest");
    if (panel) panel.classList.add("hidden");
    var prep = $("coachPrep");
    if (prep) prep.classList.add("hidden");
    if (state.el) state.el.classList.remove("is-rest", "is-rest-warn");
    state.phaseKind = "";
    state.videoUrl = "";
    state.videoUrls = {};
    state.restUrl = "";
    state.onPause = null;
    state.onClose = null;
    state.segments = [];
    state.phaseIndex = -1;
  }

  function debug() {
    var def = ANIMS[state.animKey] || ANIMS.rest;
    var pose = null;
    try { pose = poseAt(state.animKey, 0.25); } catch (e) {}
    var seg = state.segments[state.phaseIndex] || null;
    return {
      open: state.open,
      exId: state.exId,
      animKey: state.animKey,
      view: def.view,
      cycle: def.cycle,
      total: state.total,
      left: state.left,
      paused: state.paused,
      halfSaid: state.halfKey >= 0,
      halfKey: state.halfKey,
      finished: state.finished,
      // 分段相关
      phaseIndex: state.phaseIndex,
      phaseCount: state.segments.length,
      phaseKind: state.phaseKind,
      segLeft: state.segLeft,
      // 开练准备（口令 + 数 3、2、1）
      prepActive: state.prepActive,
      prepDone: state.prepDone,
      prepStep: state.prepStep,
      // 循环训练的段前口令：不打这几个字段出来，"换动作到底念没念"就只能靠听，
      // 而自动化测试听不到声音 —— 会变成永远无法验证的暗区。
      prepMode: state.prepMode,
      cuePerSegment: state.cuePerSegment,
      cueIdx: state.cueIdx,
      cueExId: state.cueExId,
      cueName: state.cueName,
      lastCueEx: state.lastCueEx,
      prepName: (function () { var e = $("coachPrepName"); return e ? e.textContent : ""; })(),
      prepCount: (function () { var e = $("coachPrepCount"); return e ? e.textContent : ""; })(),
      prepShown: !!(function () { var e = $("coachPrep"); return e && !e.classList.contains("hidden"); })(),
      // 当前挂着的视频源与地址：判断"运动段放视频 / 休息段不放视频"要靠它，
      // 少了这两个字段，相关断言会永远读到 undefined 而变成假阳性。
      videoUrl: state.videoUrl,
      video: state.videoEl ? {
        hidden: state.videoEl.classList.contains("hidden"),
        paused: state.videoEl.paused,
        curTime: Number((state.videoEl.currentTime || 0).toFixed(2)),
        src: String(state.videoEl.currentSrc || state.videoEl.src || "").split("/").pop()
      } : null,
      setNo: seg ? seg.setNo : 0,
      setCount: seg ? seg.setCount : 0,
      segments: state.segments.map(function (s) {
        return { kind: s.kind, seconds: s.seconds, setNo: s.setNo, setCount: s.setCount, exId: s.exId };
      }),
      animCount: Object.keys(ANIMS).length,
      mapped: Object.keys(EX_ANIM).length,
      canvas: state.el && $("coachCanvas") ? {
        w: $("coachCanvas").width,
        h: $("coachCanvas").height,
        cssW: Math.round($("coachCanvas").getBoundingClientRect().width),
        cssH: Math.round($("coachCanvas").getBoundingClientRect().height)
      } : null,
      pose: pose ? {
        head: pose.head, hip: pose.hip,
        armPts: pose.arms[0].pts.length,
        legPts: pose.legs[0].pts.length,
        groundMin: Math.min.apply(null, pose.legs.reduce(function (acc, l) {
          return acc.concat(l.pts.map(function (p) { return p.y; }));
        }, []))
      } : null,
      audio: audio.status()
    };
  }

  window.CoachTimer = {
    open: open,
    update: update,
    finish: finish,
    setPaused: setPaused,
    close: close,
    isOpen: function () { return state.open; },
    // 立刻结束"准备"阶段：给测试用（测试要把剩余时间直接推到 0，不该被口令拖住），
    // 也给将来可能的"跳过准备"外部入口用。
    skipPrep: function () { endPrep(true); },
    isPrepping: function () { return !!state.prepActive; },
    // 读音口令（给测试用）：返回是否用上了预生成 mp3（false = 走了系统 TTS 兜底）。
    // 用来验证"新增动作/循环块忘了生成语音时，不会静默无声"。
    __speakReady: function (exId, name) { return audio.ready(exId, name); },
    /* 给体感跟练用：独立跑一遍「准备开始进行XX，请就位」+ 人声数 3、2、1。
     * 不依赖 coachTimer 浮层（体感根本不开那个浮层），数到"开始"后 resolve。
     * 详见 audio 上方 prepSequence 的注释。 */
    prepSequence: function (exId, name, opts) { return prepSequence(exId, name, opts); },
    // 口令音频的当前状态（src / 时长 / readyState），供"口令念完了吗"类断言使用
    __cueStatus: function () { return audio.status ? audio.status() : null; },
    animFor: function (exId) { return animFor(exId).key; },
    ANIMS: ANIMS,
    EX_ANIM: EX_ANIM,
    // 给测试用：直接取某个动画在相位 t 的解算结果，便于批量校验几何
    __poseAt: poseAt,
    // 给测试用：把某个动画的某一帧画进任意 canvas，便于拼"动作总览图"
    __drawPose: function (canvas, animKey, t) {
      var r = makeRenderer(canvas);
      r.resize();
      r.setAnim(animKey);
      r.draw(poseAt(animKey, t), t);
    },
    __solve: function (animKey, p) {
      var def = ANIMS[animKey];
      return (def && def.view === "front") ? solveFront(p) : solveSide(p);
    },
    debug: debug
  };
})();
