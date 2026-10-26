/* 体感跟练 · 中文引导语音播放
 *
 * 开场骨骼校准要靠"说"来引导孩子站位：站偏了、太近了、太远了，
 * 一句话比屏幕上一行字有用得多（孩子正对着摄像头，不会一直盯着文字看）。
 *
 * 为什么是预生成 mp3 而不是 speechSynthesis 直接念：
 *   单机版是 file:// 双击打开的，浏览器的语音合成在不同机器上音色/可用性
 *   差别极大，有的机器根本没装中文语音。预生成的 mp3 每次听起来都一样，
 *   而且和教练计时器（坚持，还剩一半 / 完美结束）用的是同一条路子。
 *   文件缺失时才退回 speechSynthesis，保证功能不会整个消失。
 *
 * 用法：
 *   VoiceGuide.say("left")          播一句（同一句有节流，不会连珠炮）
 *   VoiceGuide.sayOnce("good")      整场只播一次
 *   VoiceGuide.force("welcome")     无视节流立刻播
 *   VoiceGuide.sayExclusive("wrong") 提示语：正在播就不打断重播（见下）
 *   VoiceGuide.stop()
 *   VoiceGuide.setEnabled(false)    家长/界面可以静音
 */
(function () {
  var BASE = "assets/coach/";
  var PREFIX = "guide-";

  // 兜底朗读文本（mp3 加载失败时用系统语音念）
  var TEXT = {
    welcome: "欢迎来到体感跟练，请站到摄像头前面，让我看看你。",
    nobody: "还没有看到你，请走到摄像头前面，站到画面中间。",
    left: "请往屏幕的左边移动一点。",
    right: "请往屏幕的右边移动一点。",
    closer: "请往前走近一点。",
    back: "请往后退一点，让全身都进画面。",
    head: "看不到你的头，请往后退一点。",
    feet: "看不到你的脚，请往后退一点。",
    arms: "请把双手张开一点。",
    bright: "画面有点暗，请把房间的灯打开。",
    hold: "很好，保持不动，正在锁定你的骨骼。",
    good: "识别成功，我们开始吧！",
    lost: "跟丢你了，请回到画面中间。",
    // 空房扫描：引擎要先在没有人的时候量一遍房间，之后才能用
    // "和空房不一样的地方"来认人（这是真实房间下能认出张臂的关键）。
    roomscan: "我要先记一下房间的样子，请你先退到画面外面，不要被拍到。",
    roomok: "好了，我记住房间了。请站到摄像头前面，让我看看你。",
    // 达标完成 / 项间休息 / 整套完成
    // （素材由 build/gen-fit-voice.py 的 DONE_LINES 生成到 assets/coach/done-*.mp3；
    //  这里只写兜底朗读文本 —— 文件缺失时退回系统 TTS，功能不会整个消失）
    doneitem: "项目完成，休息一下。",
    donerest: "休息一下，准备进行下一个项目。",
    doneall: "太棒了，今天的训练全部完成。",
    // 计时类动作"没在动 → 停表"时的提醒。
    // 素材是 assets/coach/guide-wrong.mp3（build/gen-fit-voice.py 生成）；
    // 这里必须也留兜底文本 —— play() 开头就有 `!TEXT[key]` 直接 return 的守卫，
    // 漏了这一行的话 mp3 生成了也播不出来。
    wrong: "动作不正确，请把动作做标准一点。"
  };

  var cache = new Map();      // key -> HTMLAudioElement
  var lastAt = {};            // key -> 上次播放时刻（节流用）
  var lastPlayAt = 0;         // 任意一句的上次播放时刻
  var playedOnce = {};        // sayOnce 用
  var enabled = true;
  var failed = false;         // 有一个文件没加载到就转兜底，避免每句都白等

  var REPEAT_GAP = 3200;      // 同一句至少隔这么久才重播
  var ANY_GAP = 900;          // 换句子也要留一点间隔，别两句话叠在一起

  var exclusiveUntil = {};    // sayExclusive 用：key -> 预计播完的时刻（ms）

  function now() { return Date.now(); }

  function element(key) {
    var el = cache.get(key);
    if (!el) {
      el = new Audio();
      el.src = BASE + PREFIX + key + ".mp3";
      el.preload = "auto";
      el.volume = 0.95;
      cache.set(key, el);
    }
    return el;
  }

  function speakFallback(key) {
    try {
      var text = TEXT[key];
      if (!text || typeof speechSynthesis === "undefined") return;
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN";
      u.rate = 1.12;
      u.pitch = 1.15;
      u.volume = 1;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (e) { /* 声音失败不影响功能 */ }
  }

  function play(key, force) {
    if (!enabled || !key || !TEXT[key]) return false;
    var t = now();
    if (!force) {
      if (t - lastPlayAt < ANY_GAP) return false;
      if (lastAt[key] && t - lastAt[key] < REPEAT_GAP) return false;
    }
    lastAt[key] = t;
    lastPlayAt = t;

    if (failed) { speakFallback(key); return false; }
    var el = element(key);
    try {
      el.currentTime = 0;
      var p = el.play();
      if (p && p.catch) p.catch(function () { failed = true; speakFallback(key); });
      return true;
    } catch (e) {
      failed = true;
      speakFallback(key);
      return false;
    }
  }

  /* 提示类语音（比如「动作不正确」）专用的"独占"播放。
   *
   * 需求原话：「这个语音没有播报完的话不要立即重复播报」。
   * 要防的不是"触发两次"，而是**打断重播** —— play() 每次都会先 el.currentTime = 0
   * 再 play()，也就是会把正在播的同一句从头打断重念。所以这里三道防线一起上：
   *   ① 该句对应的 <audio> 正在播（未暂停、未结束、且已经走过一点）；
   *   ② speechSynthesis 正在说话 —— 文件加载失败时会走 TTS 兜底，那条路径也得挡住；
   *   ③ 时长窗口 —— 记下本次开始播的时刻 + 预估时长，窗口内一律不重播。
   * 三道都要，缺一不可：el.duration 在元数据加载前是 NaN，而 play() 被浏览器
   * 拦下时 paused 也可能仍是 true，任何单一一层都可能漏。
   * 语义：只在"当前没在播"时才播；正在播就原样返回 false，绝不打断。 */
  function estimatedMs(el) {
    var d = el && el.duration;
    if (typeof d === "number" && isFinite(d) && d > 0) return d * 1000;
    // 拿不到时长（元数据还没加载）时的保守值：guide-wrong 约 2 秒，留 1 秒余量
    return 3000;
  }

  function isExclusiveBusy(key) {
    if (typeof speechSynthesis !== "undefined" && speechSynthesis.speaking) return true;
    if (exclusiveUntil[key] && now() < exclusiveUntil[key]) return true;
    var el = cache.get(key);
    if (el && !el.paused && !el.ended && el.currentTime > 0) return true;
    return false;
  }

  function sayExclusive(key) {
    if (!enabled || !key || !TEXT[key]) return false;
    if (isExclusiveBusy(key)) return false;
    var el = element(key);
    // 先把"这一句正在播"的窗口立起来，再播 —— 这样即使 play() 是异步的
    // （此刻 paused 仍是 true），紧随其后的重入也会被窗口挡住。
    exclusiveUntil[key] = now() + estimatedMs(el) + 150;   // +150ms 盖住尾音
    // force：这是"提示"语义，不该被普通引导语的节流挡掉（ANY_GAP 只有 900ms）
    return play(key, true);
  }

  window.VoiceGuide = {
    TEXT: TEXT,
    keys: function () { return Object.keys(TEXT); },
    say: function (key) { return play(key, false); },
    force: function (key) { return play(key, true); },
    // 提示类语音：正在播就不打断、返回 false（见 sayExclusive 上方注释）
    sayExclusive: sayExclusive,
    // 测试钩子：某句现在是不是"正在播 / 还在时长窗口内"，只回答不发声
    __busy: function (key) { return isExclusiveBusy(key); },
    // 整场只播一次的句子（比如"识别成功"），重复校准也不回放
    sayOnce: function (key) {
      if (playedOnce[key]) return false;
      playedOnce[key] = true;
      return play(key, true);
    },
    resetOnce: function (key) {
      if (key) delete playedOnce[key];
      else playedOnce = {};
    },
    stop: function () {
      cache.forEach(function (el) {
        try { el.pause(); } catch (e) {}
        try { el.currentTime = 0; } catch (e) {}
      });
      try { if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel(); } catch (e) {}
    },
    setEnabled: function (on) {
      enabled = !!on;
      if (!enabled) this.stop();
    },
    isEnabled: function () { return enabled; },
    // 预加载：进体感页时先悄悄把文件读进内存，第一句才不会卡半秒
    warm: function (keys) {
      (keys || Object.keys(TEXT)).forEach(function (k) {
        try { var el = element(k); el.load(); } catch (e) {}
      });
    },
    status: function () {
      var out = {};
      cache.forEach(function (el, k) {
        out[k] = { ready: el.readyState, err: !!el.error };
      });
      return { enabled: enabled, failed: failed, files: out };
    }
  };
})();
