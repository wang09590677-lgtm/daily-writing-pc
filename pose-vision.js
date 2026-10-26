/* ==================================================================
 * pose-vision.js — MediaPipe Pose 真实骨架感知层
 *
 * 它解决什么：原来的体感识别走的是"灰度背景差 + 逐带轮廓"的启发式，
 * 只能给出**估计出来的**人形位置，关节是沿轮廓猜的（手臂贴身就猜不出肘腕）。
 * 本模块把 MediaPipe Pose 的 33 个真实关键点翻译成引擎需要的
 * 「人形几何 + 骨架关节」，接口与原有掩码链路**完全同构**，
 * 所以引擎的计次、节奏、幅度、对称、连续、站位评分全部原样复用。
 *
 * 它不解决什么：不做动作分类、不做评分。那些仍由 motion-engine.js 负责。
 *
 * ── 与引擎的契约 ───────────────────────────────────────────────
 * poll() 返回（或 ok:false）：
 *   joints   { head:{x,y}, neck, shoulderL/R, elbowL/R, wristL/R, hipMid, ... }
 *            x/y 为**归一化图像坐标**（0=左/上），与引擎内部约定一致；
 *            超画面外的点为负值或 >1（保留真实出画信息，站位评分要用）
 *   energy   { 关节名: 0..1 }  该关节本帧的位移强度（画骨架时"动的关节更亮"）
 *   bbox     { x, y, w, h }
 *   area     人形包围盒面积占比（与 skel.area 同量纲）
 *   centroidX/Y, width, height, top, bottom, bottomL, bottomR
 *
 * ── 左右命名（重要，别搞反）────────────────────────────────────
 * 引擎内部的 "L" = **图像 x 较小的一侧**（见 motion-engine 里 bottomL 的取法：
 * `if (x < W/2) ... bottomL`）。
 * MediaPipe 的 LEFT_* 指的是**被拍摄者的左**，人面朝镜头时它出现在图像右侧。
 * 所以映射是交叉的：引擎 shoulderL ← MediaPipe R_SHOULDER。
 * 页面的镜像只在 CSS 显示层做（scaleX(-1)），引擎内部始终用未镜像坐标。
 * ================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.PoseVision = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* MediaPipe Pose（33 点）索引 */
  var MP = {
    NOSE: 0, L_EYE_INNER: 1, L_EYE: 2, L_EYE_OUTER: 3,
    R_EYE_INNER: 4, R_EYE: 5, R_EYE_OUTER: 6,
    L_EAR: 7, R_EAR: 8, MOUTH_L: 9, MOUTH_R: 10,
    L_SHOULDER: 11, R_SHOULDER: 12,
    L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16,
    L_PINKY: 17, R_PINKY: 18, L_INDEX: 19, R_INDEX: 20, L_THUMB: 21, R_THUMB: 22,
    L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26,
    L_ANKLE: 27, R_ANKLE: 28, L_HEEL: 29, R_HEEL: 30, L_FOOT: 31, R_FOOT: 32
  };

  /* 关键点可见度下限。低于此值视为"这一点这帧不可信"。
   * 人抬手挡脸、快速转身时 MediaPipe 会瞎猜坐标，宁缺毋滥。 */
  var VIS_MIN = 0.3;
  /* 判"画面里有没有人"的核心点：鼻/双肩/双髋（踝会因蹲下/出画缺，不作核心）。
   * 至少要看到 3 个核心点，且肩髋两组不能全缺。 */
  var CORE_MIN = 3;

  var DEFAULT_LOCATE = "vendor/mediapipe/";

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function fin(v) { return typeof v === "number" && isFinite(v); }

  /* ★ z 是**深度**（MediaPipe 口径：**负 = 靠近相机**，量纲与 x 同，原点大致在髋中点）。
   *
   * 为什么必须带上它（真机反馈）：
   *   孩子原话「跟练模型只是对正面平面的运动识别比较准，对前后方向动作无法识别，
   *   比如我正对着摄像头跑步、双臂正向举起落下、正对镜头高抬腿」。
   *   这三个都是**矢状面**动作。原来这里只返回 {x, y}，把 z 丢掉之后，
   *   下游（引擎 → 跟练角色）**根本没有"前后"这个维度**：
   *     前平举 90° ⇒ 2D 投影里肩/肘/腕三点重合 ⇒ 角色把手臂折成一团（肘弯 168.5°）；
   *     高抬腿    ⇒ 2D 里膝内角看着 ≈180° ⇒ 角色腿不弯、整条腿被平移上提；
   *     正对镜头跑 ⇒ 只有上下抖，没有前后摆。
   *   复现见 `build/_probe-sagittal.js`（喂 3D 与喂 2D 结果**逐位相同**，
   *   直接证明 z 在这条链路上被丢掉）。
   *
   * ⚠️ 缺 z 时一律补 0，**不是** undefined —— 下游按 0 处理就退化成"纯 2D"，
   *    与旧行为**逐字节一致**（`?poseDepth=1` 才真正启用，见 motion-avatar.js）。
   * ⚠️ MediaPipe 的 z 是**模型最弱的一路输出**（在无深度线索的平面图上实测有明显先验伪影），
   *    所以它默认**不参与**驱动；要先用真实数据验（见 motion-avatar.js 的 POSE_DEPTH 注释）。 */
  function zOf(p) {
    return (p && typeof p.z === "number" && isFinite(p.z)) ? p.z : 0;
  }

  function makePt(lm, i) {
    var p = lm && lm[i];
    if (!p || !fin(p.x) || !fin(p.y)) return null;
    var v = (p.visibility === undefined || p.visibility === null) ? 1 : p.visibility;
    if (!fin(v) || v < VIS_MIN) return null;
    return { x: p.x, y: p.y, z: zOf(p) };
  }
  function mid(a, b) {
    if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (zOf(a) + zOf(b)) / 2 };
    return a || b;
  }
  function lerp(a, b, t) {
    if (!a) return b;
    if (!b) return a;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: zOf(a) + (zOf(b) - zOf(a)) * t };
  }
  function countVisible(lm) {
    var n = 0;
    for (var i = 0; i < lm.length; i++) {
      var p = lm[i];
      if (!p || !fin(p.x) || !fin(p.y)) continue;
      var v = (p.visibility === undefined || p.visibility === null) ? 1 : p.visibility;
      if (fin(v) && v >= VIS_MIN) n++;
    }
    return n;
  }

  /**
   * 把 MediaPipe 的 33 关键点翻译成引擎需要的几何。
   * 纯函数，不依赖 MediaPipe 运行时 —— 所以能在 Node 里直接单测映射对不对。
   */
  function mapLandmarks(lm) {
    if (!lm || lm.length < 33) {
      return { ok: false, reason: "no-landmarks", visible: 0, core: 0 };
    }
    var P = makePt;
    var nose = P(lm, MP.NOSE);
    var eyeL = P(lm, MP.L_EYE), eyeR = P(lm, MP.R_EYE);
    var earL = P(lm, MP.L_EAR), earR = P(lm, MP.R_EAR);
    var head = nose || mid(eyeL, eyeR) || mid(earL, earR);

    var shMedL = P(lm, MP.L_SHOULDER), shMedR = P(lm, MP.R_SHOULDER);
    var hipMedL = P(lm, MP.L_HIP), hipMedR = P(lm, MP.R_HIP);
    var anMedL = P(lm, MP.L_ANKLE), anMedR = P(lm, MP.R_ANKLE);

    var core = 0;
    if (head) core++;
    if (shMedL) core++;
    if (shMedR) core++;
    if (hipMedL) core++;
    if (hipMedR) core++;

    if (core < CORE_MIN || (!shMedL && !shMedR) || (!hipMedL && !hipMedR)) {
      return { ok: false, reason: "insufficient-core", visible: countVisible(lm), core: core };
    }

    // 交叉映射：引擎的 L/R 是"图像左/右"，MediaPipe 的是"人的左/右"
    var shL = shMedR, shR = shMedL;          // 图像左肩 ← 人的右肩
    var hipL = hipMedR, hipR = hipMedL;
    var knL = P(lm, MP.R_KNEE), knR = P(lm, MP.L_KNEE);
    var anL = anMedR, anR = anMedL;
    var elL = P(lm, MP.R_ELBOW), elR = P(lm, MP.L_ELBOW);
    var wrL = P(lm, MP.R_WRIST), wrR = P(lm, MP.L_WRIST);
    var haL = P(lm, MP.R_INDEX) || wrL, haR = P(lm, MP.L_INDEX) || wrR;

    var neckFull = (shL && shR) ? mid(shL, shR) : null;
    var hipFull = (hipL && hipR) ? mid(hipL, hipR) : null;

    /* 身体中线（x）。单侧关键点缺失时，镜像补齐必须围绕**真正的中线**，
     * 而不是围绕"仅存的那一侧"——否则补齐点会被算到同一侧去（实测过：
     * 缺右肩时 neck 塌到左肩上，补出的左肩算出 0.58 而非 0.42）。 */
    var centerX = null;
    if (hipFull) centerX = hipFull.x;
    else if (neckFull) centerX = neckFull.x;
    else if (head) centerX = head.x;
    else if (hipL || hipR) centerX = (hipL || hipR).x;
    else centerX = (shL || shR).x;

    // 单侧缺失时按另一侧镜像补齐——**只补躯干锚点（肩/髋）**。
    // 理由：颈与髋中点是躯干的骨架基准，缺一侧会让整条躯干歪掉、包围盒失真。
    // 而肘/腕/手/踝/趾是**末端关节**：它们缺失代表"这一点真的看不见"，
    // 若凭空镜像出来，会让"左右对称评分"和"手臂张开幅度"在真实单侧遮挡时
    // 假装完美——那是在骗评分。末端缺失就不画（引擎见 !joints.x 会跳过该骨骼）。
    /* 镜像补齐的 z 沿用**源点**的 z —— 镜像是绕画面竖轴做的，深度不变 ✓ */
    if (!shL && shR) shL = { x: 2 * centerX - shR.x, y: shR.y, z: zOf(shR) };
    if (!shR && shL) shR = { x: 2 * centerX - shL.x, y: shL.y, z: zOf(shL) };
    if (!hipL && hipR) hipL = { x: 2 * centerX - hipR.x, y: hipR.y, z: zOf(hipR) };
    if (!hipR && hipL) hipR = { x: 2 * centerX - hipL.x, y: hipL.y, z: zOf(hipL) };
    if (!hipFull && hipL && hipR) hipFull = mid(hipL, hipR);

    var neck = neckFull || { x: centerX, y: (shL || shR).y, z: zOf(shL || shR) };
    var hipMid = hipFull;
    if (!hipMid) return { ok: false, reason: "no-hipmid", visible: countVisible(lm), core: core };

    var joints = {};
    if (head) joints.head = head;
    joints.neck = neck;
    joints.shoulderL = shL; joints.shoulderR = shR;
    joints.hipMid = hipMid;
    joints.hipL = hipL; joints.hipR = hipR;

    // 躯干上端点：引擎里它介于颈与髋之间、偏向髋（归一化高度 0.48 vs 颈 0.14 / 髋 0.53）
    joints.torsoTop = lerp(neck, hipMid, 0.8);

    if (elL) joints.elbowL = elL;
    if (elR) joints.elbowR = elR;
    if (wrL) joints.wristL = wrL;
    if (wrR) joints.wristR = wrR;
    if (haL) joints.handL = haL;
    if (haR) joints.handR = haR;
    if (shL && elL) joints.midL = mid(shL, elL);
    if (shR && elR) joints.midR = mid(shR, elR);
    if (elL && wrL) joints.foreL = mid(elL, wrL);
    if (elR && wrR) joints.foreR = mid(elR, wrR);

    if (knL) joints.kneeL = knL;
    if (knR) joints.kneeR = knR;
    if (anL) joints.ankleL = anL;
    if (anR) joints.ankleR = anR;
    if (knL && anL) joints.shinL = mid(knL, anL);
    if (knR && anR) joints.shinR = mid(knR, anR);
    var toeL = P(lm, MP.R_FOOT) || P(lm, MP.R_HEEL);
    var toeR = P(lm, MP.L_FOOT) || P(lm, MP.L_HEEL);
    if (toeL) joints.toeL = toeL;
    if (toeR) joints.toeR = toeR;

    // ---- 包围盒：只统计可见点 ----
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < lm.length; i++) {
      var q = lm[i];
      if (!q || !fin(q.x) || !fin(q.y)) continue;
      var vis = (q.visibility === undefined || q.visibility === null) ? 1 : q.visibility;
      if (!fin(vis) || vis < VIS_MIN) continue;
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.y > maxY) maxY = q.y;
    }
    if (minX === Infinity) {
      return { ok: false, reason: "no-visible", visible: 0, core: core };
    }
    var bw = Math.max(0, maxX - minX), bh = Math.max(0, maxY - minY);
    var bbox = { x: minX, y: minY, w: bw, h: bh };

    // 左右半身最低点：取该半侧最低的可见关键点（引擎用它分开计左右腿）
    var bL = 0, bR = 0;
    for (i = 0; i < lm.length; i++) {
      var r = lm[i];
      if (!r || !fin(r.x) || !fin(r.y)) continue;
      var vv = (r.visibility === undefined || r.visibility === null) ? 1 : r.visibility;
      if (!fin(vv) || vv < VIS_MIN) continue;
      if (r.x < 0.5) { if (r.y > bL) bL = r.y; }
      else { if (r.y > bR) bR = r.y; }
    }

    return {
      ok: true,
      joints: joints,
      bbox: bbox,
      area: bw * bh,
      centroidX: hipMid.x,
      centroidY: hipMid.y,
      width: bw,
      height: bh,
      top: minY,
      bottom: maxY,
      bottomL: bL,
      bottomR: bR,
      /* ★★ 左右踝的 y —— 只看脚踝，**不掺任何手臂关键点**。
       *
       * bottomL / bottomR 的语义是"该半侧所有可见关键点里最靠下的那个 y"，
       * 里面**包含手腕和肘**。孩子站着只抬手臂时，下垂的手腕就足以成为
       * 半侧最低点，于是 bottomL/bottomR 跟着手臂上下跳 —— 实测表现就是
       * 「我只是抬了抬手臂，高抬腿/踏步却在计数」（老李真机反馈）。
       *
       * 踝是抬腿类动作唯一可靠的信号源：腿不动，踝绝对不动。
       * 踝被遮挡时返回 null，由上层沿用上一帧（见 onResults 的继承逻辑），
       * 不能补 0 —— 0 等于"踝跑到画面顶端"，会造出一个巨大的假峰。 */
      ankleY_L: anL ? anL.y : null,
      ankleY_R: anR ? anR.y : null,
      visible: countVisible(lm),
      core: core,
      leftWrist: !!wrL, rightWrist: !!wrR, leftAnkle: !!anL, rightAnkle: !!anR
    };
  }

  /* ------------------------------------------------------------------ *
   * 感知器：驱动 MediaPipe 推理，并对外提供 poll()
   * ------------------------------------------------------------------ */
  function createPoseVision(opts) {
    opts = opts || {};
    var video = opts.video || null;
    var locate = opts.locateFile || function (f) { return DEFAULT_LOCATE + f; };
    var complexity = opts.modelComplexity === undefined ? 0 : opts.modelComplexity;
    var rateLimit = opts.rateLimit === undefined ? 20 : opts.rateLimit;
    var holdMs = opts.holdMs === undefined ? 700 : opts.holdMs;

    var pose = null, ready = false, running = false;
    var raf = 0, sending = false, lastSent = 0, lastVideoTime = -1;
    var frames = 0, inferHist = [];
    var latest = null;          // 最近一次可用结果（含 at）
    var lastRaw = null;         // 最近一次模型原始输出（不论 ok）
    var prevJoints = null;      // 上一帧关节（算 energy 用）
    var lastAnkY_L = null;      // 上一帧左踝 y（踝被遮挡时沿用，见 mapLandmarks）
    var lastAnkY_R = null;
    var emaEnergy = {};
    var lastReason = "idle";
    var lastAt = 0;
    var errMsg = "";
    var manual = false;         // pushLandmarks 模式（测试用，不开摄像头）
    var warmed = false;         // 是否已做过预热（一次性开销已付掉）

    function now() {
      return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    }

    function load() {
      if (ready) return Promise.resolve(true);
      if (typeof window === "undefined" || typeof window.Pose === "undefined") {
        errMsg = "姿态模型未加载（window.Pose 不存在）";
        return Promise.reject(new Error(errMsg));
      }
      return new Promise(function (resolve, reject) {
        try {
          pose = new window.Pose({ locateFile: locate });
        } catch (e) {
          errMsg = "构造 Pose 失败：" + (e && e.message);
          reject(new Error(errMsg)); return;
        }
        pose.setOptions({
          modelComplexity: complexity,
          smoothLandmarks: true,
          enableSegmentation: false,
          smoothSegmentation: false,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5
        });
        pose.onResults(onResults);
        ready = true;
        resolve(true);
      });
    }

    /* 关键点位移强度：让"正在动的关节"在骨架上更亮。
     * 用与上一帧的距离除以一个参考幅度再压到 0..1，并做 EMA 平滑。 */
    function computeEnergy(joints) {
      var ENERGY_REF = 0.03;     // 归一化图像坐标下，激烈动作单帧位移约 0.02~0.05
      var out = {};
      var moved = false;
      Object.keys(joints).forEach(function (name) {
        var cur = joints[name];
        var prev = prevJoints && prevJoints[name];
        var d = 0;
        if (prev) {
          /* 含 z：矢状面动作（跑步/高抬腿）的位移主要发生在 z 上，
           * 只算 x/y 会让"正在动的关节"反而不亮 —— 那是自相矛盾的显示。 */
          var dz = zOf(cur) - zOf(prev);
          d = Math.sqrt((cur.x - prev.x) * (cur.x - prev.x) +
            (cur.y - prev.y) * (cur.y - prev.y) + dz * dz);
        }
        var e = clamp(d / ENERGY_REF, 0, 1);
        if (emaEnergy[name] === undefined) emaEnergy[name] = e;
        else emaEnergy[name] = emaEnergy[name] * 0.6 + e * 0.4;
        out[name] = emaEnergy[name];
        if (d > 0) moved = true;
      });
      prevJoints = joints;
      void moved;
      return out;
    }

    /**
     * 预热：把「首次推理」的一次性开销提前付掉。
     *
     * 为什么必须预热（实测数据，本机 Chrome）：
     *   首次 pose.send() 要 3.2 秒 —— 这段时间花在 wasm 实例化 + 模型加载 +
     *   计算图初始化上，是**同步阻塞主线程**的。如果等到孩子点「开启摄像头」
     *   之后才发第一帧，页面会当场卡死 3 秒多：引擎的 rAF 被饿死，
     *   预览态一个骨架都画不出来，孩子看到的是"摄像头开了但没反应"。
     *   而稳态每帧只要 9~11ms，完全没有问题。
     *
     * 做法：先用一张 1×1 的画布发一帧，把这 3.2 秒付掉；
     *   之后再用真实画面发帧就只剩 ~0.33 秒（实测 3213ms → 334ms）。
     * 调用时机：**刚进体感跟练页、还没开摄像头时**（此时孩子正在看说明文字，
     *   卡一下他察觉不到），而不是开摄像头之后。
     *
     * 预热帧用的是 1×1 画面，模型必然检测不到人，不会污染任何状态；
     * 不预热也不影响功能，只是第一次开摄像头会顿一下。
     */
    function warmup() {
      if (warmed || manual) return Promise.resolve(false);
      return load().then(function () {
        var cv = document.createElement("canvas");
        cv.width = 1; cv.height = 1;
        try { cv.getContext("2d").fillRect(0, 0, 1, 1); } catch (e) { /* 忽略 */ }
        /* ⚠️ 必须带超时，不能直接 await pose.send()。
         * 原因（实测）：页面**不带** --allow-file-access-from-files 打开时，
         * fetch 本地 .wasm/.tflite 会被 origin 'null' 拦掉，而 Chrome 对这种
         * 被拦的请求**既不 resolve 也不 reject，就那么挂着** ——
         * 结果是"预热永远进行中"，状态卡在 ready=false / failed=false，
         * 界面既不显示失败提示、也不会退回掩码链路（掩码其实能用），
         * 变成一个静默的半死状态。加超时后能明确判定"加载不了"，
         * 交给上层退回轮廓链路，并如实告诉孩子。
         * 正常情况（带 flag）实测 3.2 秒，取 15 秒是宽容上界。 */
        var sent = false;
        return Promise.race([
          pose.send({ image: cv }).then(function () { sent = true; return true; },
            function () { return false; }),
          new Promise(function (resolve) {
            setTimeout(function () { resolve("timeout"); }, 15000);
          })
        ]).then(function (r) {
          warmed = true;
          if (r === "timeout") { errMsg = "模型加载超时（多半是没通过 start-app.bat 打开）"; return false; }
          if (!sent) { errMsg = "模型加载被浏览器拦截（需要 start-app.bat 的 --allow-file-access-from-files）"; return false; }
          return true;
        });
      });
    }

    function onResults(res) {
      lastAt = now();
      frames++;
      inferHist.push(lastAt);
      while (inferHist.length && inferHist[0] < lastAt - 1000) inferHist.shift();

      var lm = res && res.poseLandmarks;
      lastRaw = lm || null;
      if (!lm || !lm.length) {
        lastReason = "no-person";
        return;
      }
      var mapped = mapLandmarks(lm);
      if (!mapped.ok) {
        lastReason = mapped.reason || "map-failed";
        return;
      }
      mapped.energy = computeEnergy(mapped.joints);
      /* 踝被遮挡这一帧 → 沿用上一帧的 y。
       * 为什么必须沿用而不是给 0：信号序列要连续，突然跳到一个假值会被
       * detectReps 当成一次"动作"（detrend 归一化后与振幅无关，任何跳变都计）。
       * 沿用的时长上限由 poll() 的 holdMs 宽限兜着 —— 真丢了人整体会
       * 退回掩码链路，不会一直拿旧踝位置冒充。 */
      if (mapped.ankleY_L == null) mapped.ankleY_L = lastAnkY_L;
      else lastAnkY_L = mapped.ankleY_L;
      if (mapped.ankleY_R == null) mapped.ankleY_R = lastAnkY_R;
      else lastAnkY_R = mapped.ankleY_R;
      mapped.at = lastAt;
      mapped.frames = frames;
      latest = mapped;
      lastReason = "ok";
    }

    function loop() {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      if (manual || !pose || !video) return;
      if (video.readyState < 2 || !video.videoWidth) return;
      if (video.currentTime === lastVideoTime) return;   // 同一帧不重复推理
      lastVideoTime = video.currentTime;
      var t = now();
      if (rateLimit > 0 && t - lastSent < 1000 / rateLimit) return;
      if (sending) return;                              // 上一帧还没算完就跳过
      sending = true;
      lastSent = t;
      try {
        var p = pose.send({ image: video });
        if (p && p.then) p.then(function () { sending = false; }, function () { sending = false; });
        else sending = false;
      } catch (e) {
        sending = false;
      }
    }

    function start() {
      if (manual) return true;
      if (running) return true;
      if (!pose) return false;
      running = true;
      lastVideoTime = -1;
      if (typeof requestAnimationFrame === "function") raf = requestAnimationFrame(loop);
      return true;
    }
    function stop() {
      running = false;
      if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      raf = 0;
      sending = false;
    }

    /**
     * 取最近一次结果。
     * 漏检时**在 holdMs 内继续沿用上一帧**——MediaPipe 偶发漏检（抬手挡脸、
     * 快速转身）不该让骨架瞬间消失，那会让计次和站位评分一起抖。
     * 超过宽限期才真正返回 ok:false，交回引擎的掩码链路兜底。
     */
    function poll() {
      if (!latest) return { ok: false, reason: lastReason };
      var age = now() - latest.at;
      if (age <= holdMs) {
        return age > 120
          ? Object.assign({}, latest, { stale: true, age: Math.round(age) })
          : latest;
      }
      return { ok: false, reason: "stale" };
    }

    function stats() {
      return {
        ready: ready, running: running, frames: frames,
        fps: inferHist.length, lastAt: lastAt, reason: lastReason,
        hasResult: !!latest, stale: latest ? (now() - latest.at > holdMs) : true,
        visible: latest ? latest.visible : 0,
        error: errMsg, manual: manual, complexity: complexity,
        /* warmed = 预热流程已经走完（无论成败）。上层必须看这个，
         * 因为"没预热完"和"预热失败"要分开处理：
         *   没预热完（warmed=false）→ 还要等，别急着退回掩码
         *   预热失败（warmed=true 且 !ok）→ 明确退回掩码链路 */
        warmed: warmed
      };
    }

    /** 测试/离线用：绕过 MediaPipe，直接喂 33 关键点 */
    function pushLandmarks(lm) {
      manual = true;
      onResults({ poseLandmarks: lm });
      return latest;
    }

    return {
      load: load,
      warmup: warmup,
      start: start,
      stop: stop,
      poll: poll,
      stats: stats,
      reset: function () {
        latest = null; prevJoints = null; emaEnergy = {}; frames = 0;
        lastAnkY_L = null; lastAnkY_R = null;
        inferHist = []; lastReason = "idle"; lastAt = 0;
      },
      pushLandmarks: pushLandmarks,
      setVideo: function (v) { video = v; lastVideoTime = -1; },
      setRateLimit: function (r) { rateLimit = r; },
      /** 把 page 上的 Pose 构造参数暴露出来，便于自检断言 */
      DEBUG: function () {
        return { complexity: complexity, rateLimit: rateLimit, holdMs: holdMs, locate: typeof locate === "function" ? locate("x") : locate };
      }
    };
  }

  return {
    MP: MP,
    VIS_MIN: VIS_MIN,
    CORE_MIN: CORE_MIN,
    mapLandmarks: mapLandmarks,
    createPoseVision: createPoseVision,
    /* 引擎需要的关节名（顺序与 JOINTS 表一致），测试用来断言"映射没漏" */
    JOINT_NAMES: ["head", "neck", "shoulderL", "shoulderR", "midL", "midR",
      "elbowL", "elbowR", "foreL", "foreR", "wristL", "wristR", "handL", "handR",
      "torsoTop", "hipMid", "hipL", "hipR", "kneeL", "kneeR",
      "shinL", "shinR", "ankleL", "ankleR", "toeL", "toeR"]
  };
});
