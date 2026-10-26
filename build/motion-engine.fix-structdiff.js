/* ==================================================================
 * 体感分析引擎（纯 JS，离线可用）
 *
 * 为什么不用 MediaPipe / TensorFlow.js 这类姿态模型：
 *   本应用是双击 index.html 直接打开的（file:// 协议）。实测在 file:// 下
 *   `getUserMedia` 可用（Chrome 把 file:// 视为安全上下文），但
 *   `fetch` / `XMLHttpRequest` 会被 CORS 直接拦掉（origin 为 null），
 *   所以**任何需要下载模型权重的方案都加载不了**。
 *   因此这里改成在本地纯 JS 做运动分析：把画面降到 96×72 灰度，
 *   用"背景差"提取人形掩码、用"帧间差"提取运动量，再按动作类型做峰值检测。
 *   这也是 Wii / Switch 体感运动的做法——靠信号启发式而不是骨架识别。
 *
 * 两个掩码，各管一件事：
 *   · 背景差掩码（bgDiff）：当前画面和"学习到的背景"的差 → 人形轮廓。
 *     从它取 重心 / 包围盒 / 左右半身最低点，用来**数次数**；
 *     骨架（见下）也从它取人形。
 *   · 帧间差掩码（frameDiff）：相邻两帧的差 → 真正"正在动"的量。
 *     从它取 运动能量 / 左右分布，用来判断**有没有在动、动得均不均衡**。
 *
 * 背景学习率按动作节奏自适应：
 *   背景是"指数滑动平均"，学习越快，运动残影越短。残影太长会把整个
 *   扫过的区域糊成一片，重心就不动了，也就数不出次数。所以学习率取
 *   "该动作节奏上限对应的周期的 2/3 左右"——残影短于半个周期，
 *   掩码才会跟着身体部位走。保持类动作反过来，学习要慢，才留得住人形。
 *   副作用正好是骨架要的：残影短，人走过的地方 0.3~0.9 秒就清掉，
 *   包围盒不会被拖长；而前景像素只以 1/20 速度学，站定不动时轮廓还在。
 *
 * 背景初值用"全画面平均亮度"，不是"第一帧"：
 *   开摄像头时孩子通常已经站在画面里了，拿第一帧当背景会把整个人学成
 *   背景，骨架永远出不来。用均值等于假设"画面大部分是背景"，人形只占
 *   一小块——这才是对的先验，之后约 1 秒内就收敛到真实背景。
 *
 * 骨架（"感应出来的人体"）：
 *   把最大的一块人形沿纵向切成 16 条带，逐带取"该高度上人形的左右边界"
 *   和"左右两簇的中心"，再按人体比例挂到 14 个关节上。它画的不是解剖学
 *   精确的骨骼，而是**跟着人动的人形骨架**：开合跳时肩点会往外张、深蹲时
 *   髋膝踝会一起下沉。这正是体感游戏要的反馈。
 *
 * 能做到什么（都对得上训练动作）：
 *   · 次数：中低频率的周期性动作（深蹲、弓步、提踵、臀桥、台阶、波比、
 *     开合跳、侧向跳、跳绳…）——靠信号峰值检测
 *   · 强度 / 连续：高频动作（高抬腿、小步跑、后踢腿、登山跑、侧滑步…）
 *     数不准次数，改为测"动得有多猛、有没有一直在动"
 *   · 节奏：每分钟次数 + 节奏是否均匀
 *   · 幅度：动作幅度的相对大小
 *   · 对称：左右两侧运动量是否均衡
 *   · 保持：靠墙静蹲、平板支撑、单腿站立的保持时长与稳定性
 *
 * 做不到什么（需要真正的骨架识别模型）：
 *   · 关节角度（膝盖有没有内扣、蹲得够不够深）
 *   · 精确的手脚位置
 *   界面上如实说明，不夸大。
 *
 * 对外接口（window.MotionEngine）：
 *   createEngine()  创建一路分析器
 *       .attach(videoEl | canvasEl)   绑定画面来源
 *       .attachOverlay(canvasEl)      可选：把检测到的人形画成青色色块
 *       .setProfile(p)                设置动作参数（FITNESS_EX[id].motion）
 *       .setGoal(g)                   设置本组目标
 *       .start() / .stop() / .reset()
 *       .getLive() / .getState()      取实时指标
 *       .onTick(fn)                   每约 3 帧回调一次
 *   scoreSession(profile, stats, goal)  把统计量算成 0-100 分 + 分项 + 中文反馈
 * ================================================================== */

(function () {
  const W = 96;   // 采样宽度
  const H = 72;   // 采样高度
  const PIX = W * H;

  // 取信号的方式：每个动作选一个最能反映"一次动作"的信号
  const SIGNALS = {
    centroidY: s => s.centroidY,     // 人形重心的纵向位置（蹲起类）
    centroidX: s => s.centroidX,     // 人形重心的横向位置（侧移类）
    height: s => s.height,           // 人形包围盒高度（蹲起 / 起跳类）
    width: s => s.width,             // 人形包围盒宽度（开合类）
    bottomL: s => s.bottomL,         // 左半身最低点（抬腿类，两条腿分别计数）
    bottomR: s => s.bottomR,
    area: s => s.area,               // 人形面积
    motion: s => s.motion,           // 帧间运动量
    upper: s => s.upper,             // 运动量落在上半身的比例
    lower: s => s.lower,
    // 下面两个只有接了 Astra 深度（桥接服务在跑）才有值，否则恒为 0。
    // 深度是真实距离，不受光线/衣服颜色影响，蹲起、起跳类用它更稳。
    depthNear: s => s.depthNear || 0,        // 人到相机的距离 mm（远离/靠近）
    bodyHeight: s => s.bodyHeightMM || 0     // 人形真世界高度 mm（蹲下会变矮）
  };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function mean(arr) {
    if (!arr.length) return 0;
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function std(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(s / arr.length);
  }

  // 动作参数默认值：动作库里没写全时兜底
  const DEFAULT_PROFILE = {
    mode: "rep",
    signal: "centroidY",
    tempoBand: [20, 60],
    minRepGap: 0.5,
    expectedAmplitude: 0.1,
    holdSeconds: 30,
    stabilityTolerance: 0.05,
    holdMinEnergy: 0.0012,
    refIntensity: 0.05,
    burstSeconds: 30
  };

  /* ---------- 骨架（"感应出来的人体"）----------
   *
   * 没有姿态模型，怎么画骨架？
   *   把稳定人形轮廓沿纵向切成 BANDS 条带，逐带取"该高度上人形的左右边界"
   *   和"左右两簇的中心"，再按人体比例把这些位置挂到关节上。
   *   所以它画的不是解剖学精确的骨骼，而是**跟着人动的人形骨架**：
   *   开合跳时肩点会往外张、深蹲时髋膝踝会一起下沉、抬右手时右腕会抬起来。
   *   这正是体感游戏要的反馈——孩子要的是"系统看到我了"，不是关节角度。
   *
   * 每条带的取值：
   *   L / R  = 该带掩码的左右边界（手臂自然下垂时≈左右肩 / 左右肘 / 左右腕）
   *   C      = 该带掩码的列质心（≈脊柱）
   *   cL/cR  = 该带按"最大间隙"切成两簇后的左右簇中心（腿分开时≈左右腿）
   *
   * 为什么要分簇：双腿分开时，只取 L/R 会得到"整条腿的外包络"，
   * 两条腿会糊成一根粗柱子。按最大间隙切开后，左右腿各归各位。
   */
  const BANDS = 24;   // 从 16 提到 24，纵向分辨率更高，关节定位更准

  /* [关节名, 归一化高度(0=头顶 1=脚底), 取哪个量]
   * 新增：
   *   torsoTop / torsoBot —— 躯干上下端点，让脊柱更完整
   *   handL / handR —— 手掌中心（比 wrist 更靠外，手臂张开时更明显）
   *   midL / midR —— 手臂"中点"（肩-肘之间），手臂运动时能看到弯折
   *   foreL / foreR —— 前臂"中点"（肘-腕之间）
   *   shinL / shinR —— 小腿中点，深蹲时能看到膝盖下沉
   *   toeL / toeR —— 脚尖（用外轮廓最外侧），跳跃时能看到脚离地
   *
   * 关键改进：手臂关节不再用 "L"/"R"（整个人形的左右边界，手臂会糊进躯干），
   * 而是用 "oL"/"oR"（外轮廓边界）——手臂张开时外轮廓就是手的位置，
   * 手臂垂下时外轮廓就是躯干边缘，不会把垂下的手臂算到躯干里去。 */
  const JOINTS = [
    ["head", 0.04, "C"],
    ["neck", 0.14, "C"],
    ["shoulderL", 0.20, "oL"], ["shoulderR", 0.20, "oR"],
    ["midL", 0.26, "oL"], ["midR", 0.26, "oR"],
    ["elbowL", 0.32, "oL"], ["elbowR", 0.32, "oR"],
    ["foreL", 0.37, "oL"], ["foreR", 0.37, "oR"],
    ["wristL", 0.42, "oL"], ["wristR", 0.42, "oR"],
    ["handL", 0.45, "oL"], ["handR", 0.45, "oR"],
    ["torsoTop", 0.48, "C"],
    ["hipMid", 0.53, "C"],
    ["hipL", 0.53, "cL"], ["hipR", 0.53, "cR"],
    ["kneeL", 0.68, "cL"], ["kneeR", 0.68, "cR"],
    ["shinL", 0.78, "cL"], ["shinR", 0.78, "cR"],
    ["ankleL", 0.90, "cL"], ["ankleR", 0.90, "cR"],
    ["toeL", 0.96, "oL"], ["toeR", 0.96, "oR"]
  ];

  // 骨骼连线（虚拟关节 hipMid 只用来连脊柱和两胯，不画点）
  const BONES = [
    ["head", "neck"],
    ["neck", "shoulderL"], ["neck", "shoulderR"],
    ["shoulderL", "midL"], ["midL", "elbowL"], ["elbowL", "foreL"], ["foreL", "wristL"], ["wristL", "handL"],
    ["shoulderR", "midR"], ["midR", "elbowR"], ["elbowR", "foreR"], ["foreR", "wristR"], ["wristR", "handR"],
    ["neck", "torsoTop"], ["torsoTop", "hipMid"],
    ["hipMid", "hipL"], ["hipMid", "hipR"],
    ["hipL", "kneeL"], ["kneeL", "shinL"], ["shinL", "ankleL"], ["ankleL", "toeL"],
    ["hipR", "kneeR"], ["kneeR", "shinR"], ["shinR", "ankleR"], ["ankleR", "toeR"]
  ];

  const VIRTUAL_JOINTS = { hipMid: true, torsoTop: true };
  const TRAIL_JOINTS = ["handL", "handR", "toeL", "toeR"];
  const TRAIL_LEN = 12;
  const SHAPE_FG_RATE = 0.0004;
  const SK_ALPHA = 0.28;   // 从 0.45 降到 0.28：更跟手，延迟更低，但仍有基本平滑

  function createEngine() {
    let source = null;
    let canvas = null;
    let ctx = null;
    let gray = null;        // 当前帧灰度
    let prevGray = null;    // 上一帧灰度
    let bg = null;          // 背景模型（指数滑动平均；计次和骨架共用）
    let bgShape = null;     // 轮廓背景（只给骨架用，前景学得极慢）
    let bgShapeInit = -1;
    let mask = new Uint8Array(PIX);       // 计次掩码（噪声阈值）
    let shapeMask = new Uint8Array(PIX);  // 轮廓掩码（Otsu 阈值，给骨架用）
    let motionMask = new Uint8Array(PIX); // 帧间差掩码 = 真正在动的像素

    // ---- 深度（Astra Pro，通过本地桥接服务推过来；没跑桥接就一直是 null）----
    let depthLink = null;
    let dep = null;          // 当前深度网格，单位 mm，0 = 该格没数据
    let depthOn = false;     // 这一帧有没有用上深度
    let depthNear = 0;       // 离相机最近的那片（通常就是人）的距离 mm
    let depthCoverage = 0;   // 有效深度格数占比
    let depthMask = new Uint8Array(PIX);  // 深度算出来的人形（确认可用后才盖到 shapeMask 上）
    const depthHist = new Int32Array(64); // 掩码深度直方图（求人的代表深度用）
    let bodyMM = { height: 0, width: 0 }; // 用深度换算出的真世界身高 / 臂展，单位 mm
    let depthArea = 0;          // 深度人形占画面的比例（提示语优先看这个，不看灰度面积）
    let nearestFG = 0;          // 比背景近的最近距离 mm（不管在不在"人"的距离范围内）
    let depthSeenAt = -1;       // 最近一次用深度看到人是第几帧
    let depthDebugInfo = null;  // 最近一次 depthPersonMask 的逐候选判定（诊断用）
    let lastPersonDepth = 0;    // 上一帧成功锁定的人的距离 mm（候选锚点，保证时间连续）

    /* ---- 房间结构基线（structure baseline）----
     * 解决「真实房间里引擎把墙当人 / 把手臂切掉」（实测：空房间被判成
     * bbox 0.458×0.903 的"人"；张臂只有 1.24x）。
     *
     * 原来的做法是「找离相机最近的一整片」：按深度分位数取一条深度带试
     * [t, t+身厚]，谁形状好就选谁。问题是**真实房间到处都是"形状像人"的
     * 东西**——斜视房间的侧墙是竖直长条（长宽比 1.96、填充率 0.20），
     * 完全满足"竖长 + 够高 + 不贴死左右边"三条，实测能同时产出 13 个
     * 合格候选（空房里！），最高分 2.9 甚至高过真人的 2.79。
     * 单帧形状判据在结构上无解，所以必须引入**时域**信息：房间不动，人动。
     *
     * structureBg[i]  = 预热窗口内该格深度的中位数（该格"本来"有多远）
     * structureVar[i] = 预热窗口内的抖动（max − min）
     * structureOk[i]  = 抖动 < STABLE_TOL → 这一格是**房间结构**
     *                   （墙 / 地板 / 天花板 / 家具，一直不动）
     *
     * 判人时把「structureOk 且 与 structureBg 基本一致」的格子剔掉，
     * 剩下的才是**新出现的、会动的东西**（也就是人）。
     *
     * 为什么用"抖动"而不是"预热时有没有人"：
     *   人在预热窗口里即使站着，只要他在动，抖动就大 → 不会被误认成结构。
     *   所以**不需要用户特意走开**，walk-in 过程本身就完成了基线采集。
     * 实测（真实数据，带 2906-3545）：
     *   空房 → 没人 ✅（原来误报有人）；张臂/垂臂宽度比 → 2.59x（原来 1.00x）
     */
    const stBg = new Float32Array(PIX);     // 房间结构深度
    const stOk = new Uint8Array(PIX);       // 1 = 这一格被判定为房间结构
    const stMin = new Float32Array(PIX);    // 预热窗口内该格最小深度
    const stMax = new Float32Array(PIX);    // 预热窗口内该格最大深度
    const stN = new Uint8Array(PIX);        // 每格各自的有效样本数（不能共用一个计数）
    let stSamples = 0;                      // 预热已采帧数
    let stReady = false;                    // 基线是否可用
    let stCoverage = 0;                     // 结构格占比（诊断用）
    let stGen = 0;                          // 基线"代次"，每次 reset 自增（诊断谁清的）
    /* ⚠️ 基线必须是**显式开启**的扫描，不能"开机就偷偷学"。
     * 原因：如果从第 0 帧就开始被动学习，那么"一进来就站定不动"的孩子
     *   （或者任何连续十几帧不变的画面）会被当成房间结构学进去 →
     *   人被判成墙、整块消失。这是把"静止"和"墙"混为一谈的必然结果。
     * 所以契约是：**由 App 在"画面里应当没人"的时刻显式调用 beginRoomScan()**，
     *   扫够 ST_WARM_FRAMES 帧后冻结；没调用过就完全不剔结构（等同旧行为）。
     * 这样也保证了：不调用该 API 的自动化测试行为完全不变。 */
    let stArmed = false;
    const ST_WARM_FRAMES = 12;              // 预热帧数：约 0.4~0.8 秒
    const ST_STABLE_TOL = 140;              // 抖动 < 140mm 视为"没动过"
    const ST_MATCH_TOL = 200;               // 当前深度与基线差 < 200mm 视为"还是那堵墙"
    /* 结构差分阈值：与空房基线差 ≥ 这么多，才算"多了/少了东西"（=人）。
     * 实测扫描 250~700mm 结果完全一致（T-pose 恒 3.75x、空房恒 1 像素），
     * 鲁棒区间很宽，取中值 400 兼顾"人站得远（回波弱、差值小）"与
     * "房间里有轻微热漂移"两种情况。 */
    const ST_DIFF_TOL = 400;

    // ---- 站位质量（开场骨骼校准用）----
    let pose = null;            // evaluatePose() 的产出：分数 + 该往哪边挪

    let running = false;
    let previewing = false; // 预览态：只做分析画骨架，不计时不计数
    let raf = null;

    // 叠加层（把检测到的人形画在视频上，让孩子看到"系统看到我了"）
    let overlay = null;
    let overlayCtx = null;
    let debugCanvas = null;
    let debugCtx = null;
    let debugImg = null;
    let glowCanvas = null;
    let glowCtx = null;

    // 骨架
    let skel = { has: false, root: 0, area: 0, bbox: null, joints: {}, energy: {}, bands: [] };
    let skelSmooth = {};          // 关节位置的时间平滑状态
    let lastSkeletonCenter = null; // 帧间关联，防止远距时切换到墙角/地板
    let lostSkeletonFrames = 0;
    let trails = {};              // 末端关节的运动轨迹
    let frameMean = 128;          // 全画面平均亮度（慢背景的初值）
    let lastMaskThresh = 0;      // 最近一次轮廓阈值（诊断用）
    let lastOtsuRaw = 0, lastFgRatio = 0;

    // 连通域标记（两遍 + 并查集），用于"只认最大的一块人形"
    const labelBuf = new Int32Array(PIX);
    const ufParent = new Int32Array(PIX + 1);
    const compArea = new Int32Array(PIX + 1);
    const compMinX = new Int16Array(PIX + 1);
    const compMaxX = new Int16Array(PIX + 1);
    const compMinY = new Int16Array(PIX + 1);
    const compMaxY = new Int16Array(PIX + 1);
    // 逐带统计的复用缓冲
    const bandHist = new Uint8Array(W);
    const diffHist = new Int32Array(256);      // |画面 − 背景| 直方图（Otsu 用）
    const cumC = new Int32Array(W + 1);
    const cumS = new Int32Array(W + 1);
    const bandList = [];
    for (let b = 0; b < BANDS; b++) {
      bandList.push({ ok: false, top: 0, bottom: 0, L: 0, R: 0, C: 0, cL: 0, cR: 0, split: false, cnt: 0, energy: 0 });
    }

    let profile = null;
    let goal = null;
    let startedAt = 0;
    let elapsed = 0;        // 秒
    let frames = 0;
    let ticks = 0;
    let fps = 25;
    let fpsWindowStart = 0;
    let framesSeen = 0;
    let bgAlpha = 0.06;

    // 每帧指标
    let live = {
      motion: 0, area: 0, energy: 0,
      centroidX: 0.5, centroidY: 0.5,
      width: 0, height: 0, top: 0, bottom: 0, bottomL: 0, bottomR: 0,
      left: 0, right: 0, upper: 0, lower: 0, thresh: 0
    };

    // 时间序列（保留最近 MAXSEC 秒）
    const MAXSEC = 30;
    let series = [];

    // 计次状态（每个信号一个独立计数器，最后相加）
    let repCounters = {};   // { signal: { reps, armed, lastAt } }
    let reps = 0;
    let repTimes = [];

    // 运动量累积（用于"强度"）
    let motionSum = 0;
    let motionFrames = 0;
    let peakMotion = 0;

    // 保持类动作
    let holdSeconds = 0;

    // 实时提示
    let hint = "站到画面中间，让全身都能看到";
    let hintLevel = "info";   // info | good | warn

    const listeners = [];

    function cfg(key) {
      if (profile && profile[key] !== undefined && profile[key] !== null) return profile[key];
      return DEFAULT_PROFILE[key];
    }

    function signalList() {
      if (profile && Array.isArray(profile.signals) && profile.signals.length) return profile.signals;
      return [cfg("signal") || "centroidY"];
    }

    function tempo() {
      if (repTimes.length < 2) return 0;
      const recent = repTimes.slice(-7);
      const gaps = [];
      for (let i = 1; i < recent.length; i++) gaps.push(recent[i] - recent[i - 1]);
      const m = mean(gaps);
      return m > 0.05 ? 60 / m : 0;
    }

    function rhythm() {
      if (repTimes.length < 4) return 0;
      const recent = repTimes.slice(-8);
      const gaps = [];
      for (let i = 1; i < recent.length; i++) gaps.push(recent[i] - recent[i - 1]);
      const m = mean(gaps);
      if (m <= 0.05) return 0;
      const cv = std(gaps) / m;      // 变异系数，越小越均匀
      return clamp(1 - cv / 0.55, 0, 1);
    }

    function activeRatio(seconds) {
      const raw = signalWindow("motion", seconds);
      if (!raw.length) return 0;
      // 自适应阈值：既要有绝对下限（滤掉摄像头噪声），也相对这一段自己的水平
      const thr = Math.max(0.0008, mean(raw) * 0.45);
      let n = 0;
      for (let i = 0; i < raw.length; i++) if (raw[i] > thr) n++;
      return n / raw.length;
    }

    function symmetry() {
      let L = 0, R = 0;
      for (let i = 0; i < series.length; i++) { L += series[i].left * series[i].motion; R += series[i].right * series[i].motion; }
      const total = L + R;
      if (total < 1e-6) return 0;
      return 1 - Math.abs(L - R) / total;
    }

    function amplitude() {
      const raw = signalWindow(signalList()[0], 6);
      if (raw.length < 6) return 0;
      const range = Math.max(...raw) - Math.min(...raw);
      const ref = cfg("expectedAmplitude") || 0.1;
      return clamp(range / ref, 0, 1.6) / 1.6;
    }

    function stability() {
      const raw = signalWindow("centroidY", 3);
      if (raw.length < 6) return 0;
      const sd = std(raw);
      const tol = cfg("stabilityTolerance") || 0.05;
      return clamp(1 - sd / tol, 0, 1);
    }

    // 强度：这一组平均运动量 / 该动作的参考运动量
    function intensity() {
      if (!motionFrames) return 0;
      const avg = motionSum / motionFrames;
      return clamp(avg / (cfg("refIntensity") || 0.05), 0, 1);
    }

    function calibrating() {
      if (!running) return false;
      // 预览态没有 series，用"已经看过多少帧"判断
      if (previewing) return framesSeen < Math.round(fps * 0.8);
      return series.length < Math.round(fps * 1.2);
    }

    function getState() {
      return {
        running,
        previewing,
        elapsed,
        fps,
        reps,
        tempo: tempo(),
        rhythm: rhythm(),
        symmetry: symmetry(),
        amplitude: amplitude(),
        stability: stability(),
        activeRatio: activeRatio(6),
        intensity: intensity(),
        holdSeconds,
        live,
        area: live.area,
        motion: live.motion,
        calibrating: calibrating(),
        hint,
        hintLevel,
        profile: profile ? profile.id : null,
        mode: profile ? profile.mode : null,
        hasMotion: live.motion > 0.0012,
        skeleton: skeletonSnapshot(),
        goal: goal || null
      };
    }

    function emit() {
      const st = getState();
      listeners.forEach(cb => { try { cb(st); } catch (e) { /* 忽略回调异常，别让界面出错拖垮分析循环 */ } });
    }

    /* ---------- 画面采样 ---------- */

    function initBuffers() {
      canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      ctx = canvas.getContext("2d", { willReadFrequently: true });
      gray = new Float32Array(PIX);
      prevGray = new Float32Array(PIX);
      bg = new Float32Array(PIX).fill(-1);
      bgShape = new Float32Array(PIX).fill(-1);
      bgShapeInit = -1;
      mask = new Uint8Array(PIX);
      shapeMask = new Uint8Array(PIX);
      motionMask = new Uint8Array(PIX);
      dep = new Float32Array(PIX);
      depthMask = new Uint8Array(PIX);
      depthOn = false;
      depthNear = 0;
      depthCoverage = 0;
      lastPersonDepth = 0;
      lastSkeletonCenter = null;
      lostSkeletonFrames = 0;
      skelSmooth = {};
    }

    /* ---------- 深度：用"离墙多近"找人 ---------- */

    // 判据：**找离相机最近的那一片**，不用学背景。
    //
    // 一开始用的是"深度背景差"（每格记住身后那面墙多远，比墙近就算人），
    // 实测有两个绕不开的毛病，都跟"要不要一直站在镜头前"直接相关：
    //   1. 静止的东西迟早会被学成背景 —— 站着不动，人形面积会 0→25% 慢吞吞
    //      爬十几秒还停不下来（等于必须一直动才看得见）
    //   2. 反过来把学习率调快，又会连人一起学掉，面积从 58% 塌到 3%
    // 所以改成直接按距离切一片：取画面里落在"人可能站的距离"中的深度，
    // 用它的低分位数当参考距离 d0，凡是在 [d0, d0+身厚] 里的就算人。
    // 好处是开局立刻生效、站着不动也一直在、走开再回来也是一帧的事。
    /* 地板 / 后墙剔除 —— 「超过 2 米骨架就整块乱掉」的根因就在这里。
     *
     * 现象（可复现，见 build/distance-diag.js）：
     *   相机高 1 米时，画面里**最近能看到的地板**是 camH/tan(22.75°) ≈ 2.4 米。
     *   人站得比这近（< 2.4 米）时，人的深度带里没有地板，连通域是干净的
     *   竖长条（实测 0.21×0.78，长宽比 3.7）→ 判定为人体，骨架正常。
     *   人一站到 2.4 米以外，地板就落进了同一个深度带；地板是一整行铺满
     *   画面的横条，与人的腿 8-连通 → 最大连通域被撑成 1.00×0.71，
     *   长宽比掉到 0.71 < 1.10 → labelComponents 判"这不是人" → 骨架整块消失。
     *   分界点 ≈ camH/0.4193，正好落在用户说的「2 米多一点」，与镜头架多高有关。
     *
     * 判据：一整行几乎铺满、并且同时贴到左右画面边 → 背景面（地板/墙）。
     *   人自己不会贴到两边（2.5 米时人形只占 21% 宽；张开手臂也就 16%），
     *   所以不会误伤。
     * 处理：把这种行裁剪到"它上方最近一条正常行"的横向跨度，只留下人的腿；
     *   若上方根本没有正常行（整块都是背景），整行清零。
     * 注意只向下传播参考跨度：地板横条在人体的**下方**，而墙横条在**上方**
     *   且上方无正常行 → 直接被清零，不会在头顶糊出一片假身体。
     */
    function stripBackgroundRows(mask) {
      const WIDE = 0.82;          // 行横向铺满到 82% 以上
      /* 上下各扫一遍，这是关键。
       * 只从上往下扫的话，人站在墙前面时墙的每一行都铺满整幅，
       * 而这时还没有出现过"正常行"可以当参照 → 整行被清零，
       * 连人的头和躯干一起删掉，人就整个消失了。
       * 反方向再扫一遍，墙行就能用"人的跨度"当参照，只切掉人身两侧的墙。 */
      for (let pass = 0; pass < 2; pass++) {
        const down = pass === 0;
        let refLo = -1, refHi = -1, refDepth = 0; // 最近一条"正常行"的跨度与平均深度
        for (let k = 0; k < H; k++) {
          const y = down ? k : (H - 1 - k);
          const row = y * W;
          let mn = -1, mx = -1, ds = 0, dn = 0;
          for (let x = 0; x < W; x++) {
            if (!mask[row + x]) continue;
            if (mn < 0) mn = x;
            mx = x; ds += dep[row + x]; dn++;
          }
          if (mn < 0) continue;
          /* 只看"横向铺满"。这里刻意不再要求"必须顶到左右画面边"——
           * 深度传感器最外一两列经常整列无数据，一旦据此判宽，
           * 地板/墙就永远不会被识别成背景行。人单独站着时横向最多占三成，
           * 82% 这个门槛不会误伤。 */
          const wide = (mx - mn + 1) >= W * WIDE;
          if (!wide) { refLo = mn; refHi = mx; refDepth = ds / dn; continue; }
          // 这个方向还没出现过正常行：先放着，交给另一遍扫过来处理
          if (refLo < 0) continue;
          const lo = Math.max(0, refLo - 1), hi2 = Math.min(W - 1, refHi + 1);
          // 深度容差：地板"前缘"（比人的脚更近）会顺着腿的列留下来，在脚下拖一条尾巴，
          // 把 depthNear 拉低、把包围盒往下撑。只保留与参考行同深度的像素就能切掉它。
          const tol = Math.max(140, refDepth * 0.06);
          for (let x = 0; x < W; x++) {
            const i = row + x;
            if (!mask[i]) continue;
            if (x < lo || x > hi2 || Math.abs(dep[i] - refDepth) > tol) mask[i] = 0;
          }
        }
      }
    }

    /* 预热阶段逐帧累积结构基线。必须在"人还没进来 / 正在走进来"时调用。
     * 用 min/max 追踪抖动：先记 min/max，预热结束时再定哪些格是稳定的。
     *
     * ⚠️ 两个必须做对的地方（都踩过）：
     *   1) **每格独立判断"是否首次见到数据"**（用 stMin[i] <= 0 判断），
     *      不能用一个全局 stSamples === 0 —— 那样只要第一帧整幅无数据
     *      （引擎启动瞬间 grid 还是全 0 是常态），后面所有格的 min 都停在 0，
     *      finalize 时全部被判"无数据" → 基线覆盖 0% → 功能静默失效。
     *   2) 整帧有效格太少（<5%）时**不计入样本次数**，避免拿空白帧凑数。 */
    function structureWarm() {
      if (!stArmed || stReady) return;
      const g = depthLink && depthLink.grid ? depthLink.grid() : null;
      if (!g || g.length !== PIX) return;
      let valid = 0;
      for (let i = 0; i < PIX; i++) {
        const d = g[i];
        if (!(d > 0)) continue;
        valid++;
        if (stMin[i] <= 0) { stMin[i] = d; stMax[i] = d; }
        else {
          if (d < stMin[i]) stMin[i] = d;
          if (d > stMax[i]) stMax[i] = d;
        }
        stBg[i] += d;
        if (stN[i] < 255) stN[i]++;
      }
      if (valid < PIX * 0.05) return;      // 这一帧基本没数据，不计数
      stSamples++;
      if (stSamples >= ST_WARM_FRAMES) structureFinalize();
    }

    function structureFinalize() {
      let ok = 0;
      for (let i = 0; i < PIX; i++) {
        if (stMin[i] <= 0 || stN[i] === 0) { stOk[i] = 0; stBg[i] = 0; continue; }
        stBg[i] = stBg[i] / stN[i];
        const span = stMax[i] - stMin[i];
        /* 抖动小 = 一直没动过 = 房间结构。
         * 用 min/max 而不是标准差：一次经过的人影就能把 max−min 撑开，
         * 这正合我意——"有人在预热窗口里走过"的格子不会被当成墙。 */
        stOk[i] = span < ST_STABLE_TOL ? 1 : 0;
        if (stOk[i]) ok++;
      }
      stReady = true;
      stCoverage = ok / PIX;
    }

    function structureReset() {
      stBg.fill(0); stOk.fill(0); stMin.fill(0); stMax.fill(0); stN.fill(0);
      stSamples = 0; stReady = false; stCoverage = 0; stArmed = false; stGen++;
    }

    /* 显式开始采集"房间结构基线"。必须在**画面里没有人**的时候调用
     * （App 的流程：打开摄像头 → "请先退到画面外" → 调本函数 → 等就绪 → 再请孩子进场）。
     * 返回是否已经开始；用 roomScanInfo() 查进度。 */
    function beginRoomScan() {
      if (stReady) return false;      // 已经采好了，不用重来
      stBg.fill(0); stOk.fill(0); stMin.fill(0); stMax.fill(0); stN.fill(0);
      stSamples = 0; stCoverage = 0;
      stArmed = true;
      return true;
    }

    /* 把"与房间结构一致"的格子从深度掩码里剔掉。
     * 只在基线就绪时生效；没就绪时退化为原来的行为（不剔）。 */
    function stripStructure(mask, dep2) {
      if (!stReady) return 0;
      let stripped = 0;
      for (let i = 0; i < PIX; i++) {
        if (!mask[i]) continue;
        if (!stOk[i]) continue;
        if (Math.abs(dep2[i] - stBg[i]) < ST_MATCH_TOL) { mask[i] = 0; stripped++; }
      }
      return stripped;
    }

    function depthPersonMask() {
      depthDebugInfo = null;
      if (!depthLink || !depthLink.available() || !dep) return false;
      const g = depthLink.grid();
      if (!g || g.length !== PIX) return false;

      const MIN_PERSON_MM = 600;  // 比这还近的不是人 —— 桌面边缘、地板、自己的手
      const MAX_PERSON_MM = 5000; // 再远的一律当背景（远墙会干扰判据）

      let n = 0, closest = 0;
      for (let i = 0; i < PIX; i++) {
        const d = g[i];
        dep[i] = d;
        if (d > 0) {
          n++;
          if (!closest || d < closest) closest = d;
        }
      }
      depthCoverage = n / PIX;
      nearestFG = closest;
      if (n < PIX * 0.05) return false;            // 深度几乎没数据 → 退回灰度

      /* ---------- 路线 S：房间结构差分（真实房间首选） ----------
       * 前提：用户显式做过"空房扫描"（beginRoomScan → 预热 12 帧 → stReady）。
       * 做法：与空房基线**逐格**比较，|dep − stBg| ≥ ST_DIFF_TOL 的格就是
       *       "和空房间不一样的东西"，也就是人（或人带来的遮挡变化）。
       *
       * 为什么必须替代"深度分位数选带"——这是 D2（张臂识别失效）的真正根因：
       *   选带先定 t，再取 hi = t + 厚度，落在带外的像素**整块丢掉**。
       *   T-pose 实测：躯干 3035mm，右手指尖 3176mm；而选中带的 hi = 3145 ——
       *   指尖被切在带外，含臂整块宽度从 0.469 塌到 0.14，T/垂 只有 1.24x。
       *   注意：含双臂的那条带（t=2882 hi=3516，bw 0.46）其实存在，只是
       *   被"居中分"以 0.08 分之差打败 —— 靠调分数治不了本，必须换机制。
       *   结构差分没有"带"，整幅一起比 → 手臂天生就在掩码里（实测 3.75x）。
       *
       * 空房自检：拿空房帧套同一准则，最大连通域只有 1 像素（阈值 250~700 全稳）。
       * 合成测试从不调 beginRoomScan → stReady 恒为 false → 完全走原路径，
       * 因此这项改动对已有合成回归是**零影响**的。 */
      let structPath = false, sHits = 0;
      if (stReady) {
        for (let i = 0; i < PIX; i++) {
          const d = dep[i];
          depthMask[i] = (d >= MIN_PERSON_MM && d <= MAX_PERSON_MM
            && stOk[i] && Math.abs(d - stBg[i]) >= ST_DIFF_TOL) ? 1 : 0;
          if (depthMask[i]) sHits++;
        }
        if (sHits >= PIX * 0.005) structPath = true;
      }

      // 同时尝试近处家具、远处人体可能落入的几个距离分位数；
      // 不以最小值或第一个面积合格的候选直接定人，须比较连通域形状与连续性。
      const cand = [];
      for (let i = 0; i < PIX; i++) {
        const d = dep[i];
        if (d >= MIN_PERSON_MM && d <= MAX_PERSON_MM) cand.push(d);
      }
      if (cand.length < 40) return false;
      cand.sort(function (a, b) { return a - b; });

      // 不再“第一个面积合格就选”：近处的桌角/地板占 1% 以上时，
      // 原逻辑会优先跟踪它，画面中的真人反而跳到角落。
      // 候选 = 若干距离分位数 + 上一帧锁定的人的距离（时间连续）。
      // 人越站越远时，人在深度直方图里只占很小一撮，分位数可能整个错过他；
      // 有上一帧的锚点就不会丢。
      const TRIES = [0, 0.005, 0.02, 0.05, 0.10, 0.20, 0.35];
      const tList = [];
      for (let q = 0; q < TRIES.length; q++) {
        tList.push(cand[Math.min(cand.length - 1, Math.floor(cand.length * TRIES[q]))]);
      }
      if (lastPersonDepth > MIN_PERSON_MM && lastPersonDepth < MAX_PERSON_MM) {
        tList.push(lastPersonDepth, Math.max(MIN_PERSON_MM, lastPersonDepth - 250));
      }
      let d0 = 0, hi = 0, bestScore = -Infinity;
      const diag = [];
      /* 身厚：人的前后厚度 + 摆臂。
       * 不能太厚 —— 站 2.4 米时按 0.30 算出来有 720mm，比身后墙的距离还远，
       * 整面墙都会被算成"人"，比例爆到 60% 以上直接判废，表现就是"站远了看不见人"。
       * 人的实际前后厚度也就 200~300mm，加上摆臂 450mm 足够，远时再放宽一点但封顶。
       *
       * 每个候选距离同时试**宽档和窄档**。窄档是为"孩子背后就是墙"准备的：
       * 孩子退到 2~3 米想全身进画面时，背后常常正好是房间的墙。宽档会把
       * 整面墙圈进候选，而墙横跨整幅画面 —— 剔除背景行时找不到"正常行"当参照，
       * 最后只剩一整块横贯画面的区域，人被否掉，表现就是"退远了骨架直接没了"。
       * 窄档把墙排除在外，人立刻干净。 */
      const thickOf = (t) => [
        Math.min(900, Math.max(450, t * 0.22)),
        Math.max(260, Math.min(430, t * 0.09))
      ];
      for (let q = 0; q < tList.length; q++) {
        const t = tList[q];
        const thicks = thickOf(t);
        for (let w = 0; w < thicks.length; w++) {
        const tHi = t + thicks[w];
        let c = 0;
        for (let i = 0; i < PIX; i++) {
          const d = dep[i];
          if (d >= t && d <= tHi) c++;
        }
        const r = c / PIX;
        const row = { q: (q < TRIES.length ? TRIES[q] : ("锚" + Math.round(t))) + (w ? "窄" : ""), t: Math.round(t), hi: Math.round(tHi), r: Math.round(r * 1000) / 1000, pick: "" };
        /* 这里只挡"整幅同深度"这种明显不是人的情况。
         * 真正的面积闸放到剔除背景、切出人体那一块之后再算 ——
         * 否则"人 + 侧边同深度柜子 + 地板"合起来能到 44%，人还没被切出来
         * 就被这里拦掉，表现就是孩子退远了骨架直接消失。 */
        if (r < 0.005 || r > 0.85) { row.pick = "面积闸"; diag.push(row); continue; }
        for (let i = 0; i < PIX; i++) depthMask[i] = dep[i] >= t && dep[i] <= tHi ? 1 : 0;
        /* 先剔「房间结构」（墙/地板/天花板）——这一步是真实房间下能用的关键。
         * 不剔的话空房间里会有 13 条带产出"形状像人"的候选（含侧墙长条）。 */
        const stripped = stripStructure(depthMask, dep);
        stripBackgroundRows(depthMask);       // 再剔掉地板/墙横条
        shapeMask.set(depthMask);
        const candidate = labelComponents();
        if (!candidate.root || candidate.area < PIX * 0.005) {
          row.pick = stripped > 0 ? "剔结构后无块" : "无合格连通域";
          // 记录最大连通域的长宽比，便于看是不是被地板撑宽了
          let big = 0;
          for (let rr = 1; rr <= PIX; rr++) if (compArea[rr] > compArea[big]) big = rr;
          if (big) {
            row.bigBw = Math.round((compMaxX[big] - compMinX[big] + 1) / W * 100) / 100;
            row.bigBh = Math.round((compMaxY[big] - compMinY[big] + 1) / H * 100) / 100;
            row.bigRatio = Math.round(row.bigBh / Math.max(0.001, row.bigBw) * 100) / 100;
          }
          diag.push(row); continue;
        }
        const cr = candidate.root;
        const cx = (compMinX[cr] + compMaxX[cr] + 1) / (2 * W);
        const cy = (compMinY[cr] + compMaxY[cr] + 1) / (2 * H);
        const bh = (compMaxY[cr] - compMinY[cr] + 1) / H;
        const dist = lastSkeletonCenter ? Math.hypot(cx - lastSkeletonCenter.x, cy - lastSkeletonCenter.y) : 0;
        /* 居中与纵向高度优先，面积只轻微加权（否则侧边柜子会把候选抢走）。
         * "时间锚点"候选（上一帧锁定的人的距离）打个折：它只是防止"人越走越远
         * 时深度直方图错过他"的保险，不该盖过当前帧自己的合格候选 ——
         * 上一帧若在墙/地板上误锁过，锚点会把整条候选带到墙那边去。 */
        const anchorPenalty = (q >= TRIES.length) ? 0.6 : 0;
        const score = bh * 2.2 - Math.abs(cx - 0.5) * 6 - dist * 4
          + Math.min(3, Math.log1p(candidate.area) * 0.25) - anchorPenalty;
        row.pick = "合格";
        row.bw = Math.round((compMaxX[cr] - compMinX[cr] + 1) / W * 100) / 100;
        row.bh = Math.round(bh * 100) / 100;
        /* 诊断字段（不参与判定）：块的上下端行、填充率。
         * topY 是"头在哪一行"——真人站在全身进镜的距离时头必然在画面中部，
         * 而房间的墙/地板带常常一直顶到画面最上面一行。定位幻影人要用它。 */
        row.topY = Math.round(compMinY[cr] / H * 100) / 100;
        row.botY = Math.round(compMaxY[cr] / H * 100) / 100;
        row.fill = Math.round(candidate.area / Math.max(1,
          (compMaxX[cr] - compMinX[cr] + 1) * (compMaxY[cr] - compMinY[cr] + 1)) * 100) / 100;
        row.score = Math.round(score * 100) / 100;
        row.path = candidate.path;
        row.split = candidate.split;
        diag.push(row);
        if (score > bestScore) { bestScore = score; d0 = t; hi = tHi; }
        }
      }
      depthDebugInfo = { cand: cand.length, diag: diag, chosen: Math.round(d0), structPath: structPath };
      /* 有结构差分掩码时**不依赖选带结果**：即使所有深度带都不合格
       * （真实房间里很常见——直方图被墙切碎），只要"和空房不一样的那块"
       * 够大就继续。这是路线 S 相对于旧路径的核心区别。 */
      if (!d0 && !structPath) return false;

      /* 重建掩码后**再选一次连通域**，并且只保留"被选中那一块"的像素。
       * depthNear 与面积占比都必须只按人这一块算：画面侧边同深度的柜子
       * 一旦被算进来，面积占比会被顶过闸门，人反而被判成"不是人体"，
       * 同时 depthNear 也会被家具带偏，距离提示全错。 */
      if (structPath) {
        /* 路线 S：**重新生成**结构差分掩码，不重建带、不用 d0/hi。
         * 这是 D2 的根治点：带会把手臂切在 hi 之外，结构差分没有带。
         *
         * ⚠️ 必须在这里重算，不能复用函数开头那次的结果：
         * 中间的候选带循环（`depthMask[i] = dep[i] >= t && ...`）会**就地覆盖**
         * depthMask，循环结束时它装的是"最后试过的那条带"。踩过这个坑：
         * 复用开头结果 → 掩码与结构差分无关 → 人才刚刚好被清空 → 一直报"没人"。
         * 另外把 d0/hi 记成掩码实际覆盖的深度范围，供距离分位与诊断沿用。 */
        let smin = Infinity, smax = -Infinity, sN = 0;
        for (let i = 0; i < PIX; i++) {
          const d = dep[i];
          const on = (d >= MIN_PERSON_MM && d <= MAX_PERSON_MM
            && stOk[i] && Math.abs(d - stBg[i]) >= ST_DIFF_TOL) ? 1 : 0;
          depthMask[i] = on;
          if (!on) continue;
          sN++;
          if (d < smin) smin = d;
          if (d > smax) smax = d;
        }
        if (sN < PIX * 0.005) return false;
        d0 = smin; hi = smax;
      } else {
        for (let i = 0; i < PIX; i++) {
          const d = dep[i];
          depthMask[i] = d >= d0 && d <= hi ? 1 : 0;
        }
        stripStructure(depthMask, dep);        // 最终掩码同样要剔房间结构
        stripBackgroundRows(depthMask);        // 以及剔地板/墙横条
      }
      if (depthDebugInfo) {
        depthDebugInfo.structPath = structPath;
        depthDebugInfo.midMask = maskAscii(depthMask);
      }
      shapeMask.set(depthMask);
      const fin = labelComponents();
      if (!fin.root || fin.area < PIX * 0.005) return false;
      const keepRoot = fin.root;
      if (depthDebugInfo) {
        depthDebugInfo.keepPath = fin.path;
        depthDebugInfo.keepSplit = fin.split;
        // 只有这一次（最终掩码重建）的 gc 才代表"这一帧真实可选到的候选"，
        // 写进诊断；extractSkeleton 里那次不再污染它。
        depthDebugInfo.gc = fin.gc;
        depthDebugInfo.gcWideOK = fin.gcWideOK;
        depthDebugInfo.nComp = fin.nComp;
      }

      let hits = 0, minY = H, maxY = -1, minX = W, maxX = -1;
      depthHist.fill(0);
      const NB = depthHist.length, span = Math.max(1, hi - d0);
      for (let i = 0; i < PIX; i++) {
        if (labelBuf[i] !== keepRoot) { depthMask[i] = 0; continue; }
        depthMask[i] = 1;
        hits++;
        const y = (i / W) | 0, x = i - y * W;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        const b = Math.min(NB - 1, Math.max(0, Math.floor((dep[i] - d0) / span * NB)));
        depthHist[b]++;
      }
      /* 人的代表深度 = 掩码像素深度的 20% 分位，而不是最小值。
       * 最小值会被"脚下方那条地板前缘"拉近几百毫米，身高换算和距离引导都会偏；
       * 人占据掩码的绝大部分，20% 分位稳稳落在人的身上。 */
      let near = 0, acc = 0;
      const q20 = hits * 0.2;
      for (let b = 0; b < NB; b++) {
        acc += depthHist[b];
        if (acc >= q20) { near = d0 + (b + 0.5) * span / NB; break; }
      }
      if (!near) near = d0;

      const ratio = hits / PIX;
      // 分割失败时停止显示深度骨架；不与另一路彩色相机轮廓混用。
      // 上限与 labelComponents 一致：人跟侧边家具连成一块时会超过 40%。
      if (ratio < 0.005 || ratio > 0.60) return false;

      shapeMask.set(depthMask);      // 确认可用了才盖上去，绝不半途污染
      /* 诊断：到这一步 depthMask 已只剩"被选中那一块"（keepRoot 像素），
       * 这才是引擎真正的输出。中间态掩码含全部候选块，拿它当输出会误判。 */
      if (depthDebugInfo) depthDebugInfo.personMask = maskAscii(depthMask);
      depthNear = near;
      lastPersonDepth = near;        // 记下来当下一帧的候选锚点
      depthArea = ratio;
      depthSeenAt = framesSeen;
      // 身高/臂展在这里先不算：要用**最大连通块**的框（见 analyze 里
      // extractSkeleton 之后），用这里所有前景像素的框会把地板一起框进去。
      return true;
    }

    // 采样源可以是 <video>（正常使用），也可以是 <canvas>（自动化测试喂合成画面）
    function sourceReady() {
      if (!source) return false;
      if (typeof source.videoWidth === "number") {
        return source.readyState >= 2 && source.videoWidth > 0 && source.videoHeight > 0;
      }
      return !!(source.width && source.height);
    }

    function sample() {
      if (!sourceReady()) return false;
      try {
        ctx.drawImage(source, 0, 0, W, H);
        const data = ctx.getImageData(0, 0, W, H).data;
        for (let i = 0, p = 0; i < PIX; i++, p += 4) {
          // 亮度（BT.601 近似）
          gray[i] = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
        }
      } catch (e) {
        return false;   // 画面还没准备好时 drawImage 可能抛错
      }
      return true;
    }

    // 背景学习率：残影长度要短于半个动作周期，掩码才会跟着身体部位走
    function updateBgAlpha() {
      if (!profile) { bgAlpha = 0.06; return; }
      if (profile.mode === "hold") { bgAlpha = 0.012; return; }   // 保持类要慢，才留得住人形
      const band = cfg("tempoBand") || [20, 60];
      const period = 60 / Math.max(10, band[1]);                  // 最快那一拍的周期（秒）
      const tau = Math.max(0.12, period * 0.66);                  // 目标时间常数
      bgAlpha = clamp(1 / (tau * Math.max(10, fps)), 0.02, 0.4);
    }

    // Otsu 自适应阈值：在 |当前画面 − 背景| 的直方图上找"房间 / 人"的分界。
    //
    // 为什么需要它：背景初值是"全画面平均亮度"，而房间本身离均值可能很远
    // （偏暗的家具、偏亮的窗户）。如果只用噪声阈值，整个房间都会被判成前景，
    // 于是房间也走"前景=慢慢学"这条路，背景永远收敛不了——实测就是一大坨
    // 青色糊住整个画面。Otsu 会自动落在两团之间的谷底，换房间也不用调参。
    //
    // 分出来之后：被判为"房间"的像素按正常速率学（背景迅速收敛，人走开的
    // 地方 0.5 秒内清掉，包围盒不会被拖长）；被判为"人"的像素**极慢**地学
    // （时间常数约 40 秒）——这一条是关键，见 shapeThreshold 上面的说明。
    function otsuThreshold() {
      diffHist.fill(0);
      let total = 0, sum = 0;
      for (let i = 0; i < PIX; i++) {
        let v = Math.abs(gray[i] - bgShape[i]) | 0;
        if (v > 255) v = 255;
        diffHist[v]++;
        total++;
        sum += v;
      }
      let sumB = 0, wB = 0, best = -1, bestT = 0;
      for (let v = 0; v < 256; v++) {
        if (!diffHist[v]) continue;
        wB += diffHist[v];
        const wF = total - wB;
        if (!wF) break;
        sumB += v * diffHist[v];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) { best = between; bestT = v; }
      }
      return bestT;
    }

    // 轮廓阈值 = Otsu 结果，过三道闸，任何一道不过就当"没看到人"：
    //   · 分割点太靠下（< 22）说明画面里根本没有明显的人 → 返回 255，什么都不画
    //   · 不能低于噪声阈值（否则噪声会变成"人"）
    //   · 分出来的前景占比要在 1%~45% 之间（太小=没分出人，太大=把房间算进来了）
    function shapeThreshold(noiseThresh) {
      const raw = otsuThreshold();
      lastOtsuRaw = raw;
      if (raw < 22) { lastFgRatio = 0; return 255; }
      const t = clamp(raw, noiseThresh, 90);
      let n = 0;
      for (let i = 0; i < PIX; i++) if (Math.abs(gray[i] - bgShape[i]) > t) n++;
      lastFgRatio = n / PIX;
      if (n < PIX * 0.008 || n > PIX * 0.45) return 255;
      return t;
    }

    function analyze() {
      updateBgAlpha();
      const first = framesSeen === 0;
      const slow = bgAlpha * 0.05;

      // 全画面平均亮度
      let gsum = 0;
      for (let i = 0; i < PIX; i++) gsum += gray[i];
      frameMean = gsum / PIX;

      // 轮廓背景的初值用"全画面平均亮度"，而不是"第一帧"。
      // 开摄像头时孩子通常已经站在画面里了，拿第一帧当背景会把整个人学成
      // 背景，骨架就永远出不来——这正是"看不出识别效果"的根因之一。
      // 用均值等于假设"画面里大部分是背景"，人形只占一小块，这才是对的先验。
      // 计次背景（bg）保持原来的"第一帧"初始化，不动它的手感。
      if (bgShapeInit < 0) {
        bgShape.fill(frameMean);
        bgShapeInit = 1;
      }

      // 噪声水平：用帧间差估计；前两帧还没有参考帧，给个保守值
      let noise = 6;
      if (framesSeen > 2) {
        let acc = 0;
        for (let i = 0; i < PIX; i += 7) acc += Math.abs(gray[i] - prevGray[i]);
        noise = acc / Math.ceil(PIX / 7);
      }
      const thresh = Math.max(11, noise * 2.6);
      const threshShape = shapeThreshold(thresh);
      lastMaskThresh = threshShape;

      let area = 0, sumX = 0, sumY = 0;
      let minX = W, maxX = -1, minY = H, maxY = -1;
      let bottomL = 0, bottomR = 0;
      let motion = 0, mL = 0, mR = 0, mU = 0, mLo = 0;

      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const g = gray[i];

          // ---- 计次掩码：原有手感完全不动 ----
          const d = Math.abs(g - bg[i]);
          const on = d > thresh;
          mask[i] = on ? 1 : 0;
          // 选择性更新：正在运动的像素几乎不学（保住对比度），
          // 静止的像素正常学（把残影清掉）。
          bg[i] += (g - bg[i]) * (on ? slow : bgAlpha);
          if (on) {
            area++;
            sumX += x; sumY += y;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (x < W / 2) { if (y + 1 > bottomL) bottomL = y + 1; }
            else { if (y + 1 > bottomR) bottomR = y + 1; }
          }

          // ---- 轮廓掩码：独立背景，前景学得极慢（时间常数约 40 秒）----
          // 这一条是整个骨架能不能用的关键：
          //   · 人的对比度几乎不衰减 → 站定不动也一直看得到人
          //   · 人走开后腾出来的地方，差值增长极慢，会一直低于 Otsu 阈值
          //     → 被判为"背景"按正常速率学 → 半秒内清干净
          // 反过来（前景学得快）就会出现：人的对比度掉到 40，残影涨到 35，
          // 两者分不开，Otsu 阈值被拉到 22，残影被误判成前景而永久留存——
          // 实测就是这个自锁，包围盒被撑大、骨架不跟人走。
          const dS = Math.abs(g - bgShape[i]);
          const onS = dS > threshShape;
          shapeMask[i] = onS ? 1 : 0;
          bgShape[i] += (g - bgShape[i]) * (onS ? SHAPE_FG_RATE : bgAlpha);

          // ---- 帧间差 → 真正在动的量 ----
          if (!first) {
            const moving = Math.abs(g - prevGray[i]) > thresh;
            motionMask[i] = moving ? 1 : 0;
            if (moving) {
              motion++;
              if (x < W / 2) mL++; else mR++;
              if (y < H / 2) mU++; else mLo++;
            }
          } else {
            motionMask[i] = 0;
          }
        }
      }

      live = {
        area: area / PIX,
        energy: area / PIX,                       // 兼容旧字段名
        motion: motion / PIX,
        centroidX: area ? (sumX / area) / W : 0.5,
        centroidY: area ? (sumY / area) / H : 0.5,
        width: maxX >= 0 ? (maxX - minX + 1) / W : 0,
        height: maxY >= 0 ? (maxY - minY + 1) / H : 0,
        top: maxY >= 0 ? minY / H : 0,
        bottom: maxY >= 0 ? (maxY + 1) / H : 0,
        bottomL: bottomL / H,
        bottomR: bottomR / H,
        left: motion ? mL / motion : 0,
        right: motion ? mR / motion : 0,
        upper: motion ? mU / motion : 0,
        lower: motion ? mLo / motion : 0,
        thresh,
        depthOn: false,
        depthNear: 0,
        depthCoverage: 0,
        depthArea: 0,
        depthTracked: false,
        bodyHeightMM: 0,
        bodyWidthMM: 0
      };

      // 深度可用时，通过近距候选与人体连通域筛选做人形轮廓；
      // 深度与 UVC 彩色未配准，不能将两种坐标直接叠加。
      // 计次那条路（mask / motion）完全不动，保持已经调好的手感。
      structureWarm();   // 先把这一帧并进"房间结构基线"（预热够了就自动 finalize）
      depthOn = depthPersonMask();
      if (depthOn) {
        live.depthOn = true;
        live.depthNear = depthNear;
        live.depthCoverage = depthCoverage;
        live.depthArea = depthArea;
      } else {
        depthNear = 0;
        depthArea = 0;
        // 深度流仍在但本帧没有可靠人体时，不要突然切到另一台/另一
        // 坐标系的彩色流轮廓；这种回退正是“退到 2 米骨架跳角落”的来源之一。
        if (depthLink && depthLink.available()) shapeMask.fill(0);
      }

      extractSkeleton();
      live.depthTracked = depthOn && skel.has;
      if (depthOn && !skel.has) {
        // 深度候选被判为非人体时，本帧也不应向 UI 报告“已识别”。
        depthOn = false;
        live.depthOn = false;
        depthNear = 0;
        depthArea = 0;
      }

      // 真世界身高 / 臂展：必须用骨架那个**最大连通块**的框，不能用所有深度
      // 前景的框 —— 后者会把同样距离的地板一起框进去，实测身高虚到 2254mm。
      // 视场角取 Astra Pro 标称的 60°×45°，每格实际尺寸 = 2·d·tan(半角)/格数。
      if (depthOn && skel.has && skel.bbox) {
        const mmPerRow = 2 * depthNear * 0.4142 / H;    // tan(22.5°)≈0.4142
        const mmPerCol = 2 * depthNear * 0.5774 / W;    // tan(30°) ≈0.5774
        bodyMM = {
          height: skel.bbox.h * H * mmPerRow,
          width: skel.bbox.w * W * mmPerCol
        };
        live.bodyHeightMM = bodyMM.height;
        live.bodyWidthMM = bodyMM.width;
      } else {
        bodyMM = { height: 0, width: 0 };
      }

      pose = evaluatePose();
      live.pose = pose;

      prevGray.set(gray);
      framesSeen++;
      return live;
    }

    /* ---------- 站位质量评分 + 移动引导（开场骨骼校准用） ----------
     * 骨架能不能"挂"准，几乎完全取决于站位：人只进半个身子、离得太近
     * （Astra 结构光最近有效距离约 0.7 米）、或者整个人占不满画面，
     * 轮廓都会糊成一坨，后面再怎么调算法都白搭。
     * 所以开场必须先让孩子站好：这里把"当前站得好不好"量化成 0-100，
     * 并按优先级给出**最该先纠正的那一条**指令（一次只说一件事，
     * 孩子才反应得过来）。
     */
    /* 最佳识别距离（毫米）。
     * 实测 2 米内摄像头无法同时看到头与脚，体感效果不良。
     * 最佳窗口定在 2~3.5 米：这个距离 Astra 结构光仍然稳定，
     * 人也能完整进画面，轮廓最清楚。物理焦距是定焦改不了，能动的是判定窗口。 */
    const DIST_BEST_MIN = 2000;
    const DIST_BEST_MAX = 3500;
    const DIST_TOO_NEAR = 1200;  // 比这还近，结构光开始散且看不到全身
    const DIST_TOO_FAR  = 4200;  // 比这还远，人又太小了

    function bandAt(u) {
      const i = clamp(Math.round(u * (BANDS - 1)), 0, BANDS - 1);
      return bandList[i];
    }

    function evaluatePose() {
      const p = {
        seen: false, score: 0, locked: false, distanceMeasured: false,
        checks: { whole: 0, size: 0, center: 0, legs: 0, arms: 0, distance: 0 },
        guide: "none", guideText: "", bbox: null, cx: 0.5, heightRatio: 0
      };
      if (!skel.has || !skel.bbox) {
        p.guide = "nobody";
        p.guideText = depthOn && depthCoverage < 0.05
          ? "深度画面基本是空的，请站到摄像头前面"
          : "还没有看到你，请走到摄像头前面";
        return p;
      }

      const bb = skel.bbox;
      const top = bb.y, bottom = bb.y + bb.h;
      const left = bb.x, right = bb.x + bb.w;
      const cx = bb.x + bb.w / 2;
      p.seen = true;
      p.bbox = bb;
      p.cx = cx;
      p.heightRatio = bb.h;

      // 0) 距离先算：后面好几项都要看"是不是站在最佳窗口里"
      let distOK = null;
      if (depthOn && depthNear > 0) {
        distOK = depthNear >= DIST_BEST_MIN && depthNear <= DIST_BEST_MAX ? 1
          : depthNear < DIST_BEST_MIN
            ? clamp((depthNear - DIST_TOO_NEAR + 100) / (DIST_BEST_MIN - DIST_TOO_NEAR + 100), 0, 1)
            : clamp((DIST_TOO_FAR - depthNear) / (DIST_TOO_FAR - DIST_BEST_MAX), 0, 1);
        p.checks.distance = distOK;
        p.distanceMeasured = true;
      }
      /* 站在最佳窗口里（2~3.5 米）：这个距离能看到全身，轮廓清楚。 */
      const nearOK = distOK !== null && depthNear >= DIST_BEST_MIN - 200
                                      && depthNear <= DIST_TOO_FAR - 200;

      // 1) 全身都在画面里：2 米以上应该能看到头脚，严格要求
      const outV = Math.max(0, 0.02 - top) + Math.max(0, bottom - 0.985);
      const outH = Math.max(0, 0.02 - left) + Math.max(0, right - 0.98);
      p.checks.whole = (outV === 0 && outH === 0) ? 1
        : clamp(1 - outH * 6 - outV * 6, 0, 0.7);

      // 2) 大小：2~3.5 米时人占画面 45%~75% 最佳
      const h = bb.h;
      p.checks.size = h >= 0.45 && h <= 0.75 ? 1
        : h < 0.45 ? clamp((h - 0.25) / 0.20, 0, 1)
        : clamp((0.90 - h) / 0.15, 0, 1);

      // 3) 左右居中：偏离画面中线不超过 12%
      const off = Math.abs(cx - 0.5);
      p.checks.center = clamp(1 - Math.max(0, off - 0.06) / 0.20, 0, 1);

      // 4) 双腿能分开：小腿那条横带中间有空白，说明两条腿各自成簇
      const shinBand = bandAt(0.90);
      const thighBand = bandAt(0.74);
      const legSplit = (shinBand && shinBand.split) || (thighBand && thighBand.split);
      p.checks.legs = legSplit ? 1 : 0.35;

      // 5) 双手：张开手臂时轮廓最好认。
      /* 判据用"带状宽度比"，**不要**用 bandAt(0.42).split。
       * 为什么不用 split：双手侧平举时左臂—肩—躯干—肩—右臂是**连续**的，
       * 该带内没有任何空隙，split 永远是 false —— 孩子张得越标准越判不出来。
       * 而 split 真正能捕获的高度，恰好是"手臂自然下垂时手腕所在处"；
       * 孩子一旦把手臂抬起来，那个高度就只剩躯干，更不可能分开。老实现
       * 因此把"请把双手张开一点"变成了一条**照着做也消解不掉**的死指令。
       * 实测（build/band-width-diag.js，3m 处，逐带宽度最宽/均宽）：
       *   手臂下垂 = 1.25（逐带几乎恒定）
       *   上举 V 形 = 1.96 ｜ 斜下举 550mm = 3.33 ｜ 侧平举 T-pose = 3.96
       * 取 1.5 作阈值，两侧余量都够（下垂 1.25 < 1.5 ≤ 1.96 最小张臂）。
       * 再加绝对下限 0.15：人退得很远时逐带只有两三格宽，比值容易被噪声
       * 放大成假阳性，绝对宽度能挡住。 */
      let wMax = 0, bwSum = 0, wCnt = 0;
      for (let b = 0; b < BANDS; b++) {
        const bd = bandList[b];
        if (!bd || !bd.ok) continue;
        const bw = bd.R - bd.L;
        if (bw > wMax) wMax = bw;
        bwSum += bw; wCnt++;
      }
      const wMean = wCnt ? bwSum / wCnt : 0;
      const armsOut = wMax >= 0.15 && wMean > 1e-6 && (wMax / wMean) >= 1.5;
      // split 保留作次要判据：手臂斜张且恰好在该带留下空隙时也能认
      const wristBand = bandAt(0.42);
      p.checks.arms = (armsOut || (wristBand && wristBand.split)) ? 1 : 0.6;

      const wSum = 1.0 + 0.85 + 0.7 + 0.8 + 0.35 + (distOK === null ? 0 : 0.9);
      const wVal = p.checks.whole * 1.0 + p.checks.size * 0.85 + p.checks.center * 0.7
                 + p.checks.legs * 0.8 + p.checks.arms * 0.35
                 + (distOK === null ? 0 : distOK * 0.9);
      p.score = Math.round(clamp(wVal / wSum, 0, 1) * 100);

      /* ---- 引导：一次只说最该先纠正的那一条 ----
       * 自拍镜像后，原始图像 x<0.5 对应屏幕右侧；此时向孩子的左侧
       * 移动会使其屏幕像向左回到中间，所以保留 left 指令。 */
      /* 2 米以上才能看到全身，这是体感效果的前提。 */
      if (depthOn && depthNear > 0 && depthNear < DIST_TOO_NEAR) {
        p.guide = "back"; p.guideText = "离得太近了，请往后退到 2~3.5 米";
      } else if (distOK !== null && depthNear > DIST_BEST_MAX + 200) {
        p.guide = "closer"; p.guideText = "有点远，请往前走近一点";
      } else if (h < 0.35) {
        p.guide = "closer"; p.guideText = "人太小了，请往前走近一点";
      } else if (h > 0.82) {
        p.guide = "back"; p.guideText = "人太大了，请往后退一点";
      } else if (off > 0.12) {
        p.guide = cx < 0.5 ? "left" : "right";
        p.guideText = cx < 0.5 ? "请往左边移动一点" : "请往右边移动一点";
      } else if (p.score >= 82) {
        /* 分数已经很好时先说"保持"，**不要**再拿 arms 说事。
         * 老实现的顺序是先判 arms<1、后判 score>=82，而 arms 权重只有 0.35
         * （总分照样能到 90~97、locked 也为真）—— 结果孩子拿到 97 分、
         * 界面却一直挂着"请把双手张开一点"，且因为张臂判据本身有缺陷，
         * 这条指令**照着做也永远消失不了**。分数达标就是达标。 */
        p.guide = "hold"; p.guideText = "很好，保持不动";
      } else {
        p.guide = "arms"; p.guideText = "双臂可以再张开一些，站直站正";
      }

      p.locked = p.score >= 82 && (p.guide === "hold" || p.guide === "arms");
      return p;
    }

    /* ---------- 骨架提取 ---------- */

    function ufFind(a) {
      let r = a;
      while (ufParent[r] !== r) r = ufParent[r];
      while (ufParent[a] !== r) { const n = ufParent[a]; ufParent[a] = r; a = n; }
      return r;
    }

    function ufUnion(a, b) {
      const ra = ufFind(a), rb = ufFind(b);
      if (ra !== rb) ufParent[rb] = ra;
    }

    /* 把"人"从"和侧边家具连在一起的大块"里切出来。
     *
     * 典型场景：孩子往后退，画面侧边有个**同深度**的柜子/门框/窗帘，
     * 两者在深度图上 8-连通成一块。此时包围盒横跨到画面边上，
     * 画出来的绿块自然就黏在屏幕边缘——用户看到的"一后退色块就偏到边上"。
     *
     * 做法：按"列"统计占用，中间空掉的列就是天然分界线；
     * 每一段各自按"竖长 + 居中 + 不实心"打分，取最好的一段，
     * 其余列清零，并把包围盒/面积同步成这一段的值，下游就全都一致了。 */
    function splitByColumnGap(root, w0, w1, h0, h1) {
      let best = null;
      const origBw = (w1 - w0 + 1) / W;   // 裁剪前的整块宽度（用于滑窗宽度闸）
      /* 候选评估：给一个列区间 [a0,a1]，算它的"人体形态分"。
       * 要求竖长、不实心、不贴到画面最外缘。
       * trim = 从画面边裁掉的列数 —— 要扣分。否则"越裁越窄"的段会因为
       * 中心更靠近画面中央而拿高居中分，把人的左（右）半边活活裁掉，
       * 绿块就会从"贴着左边"变成"偏到右边"。 */
      const take = (a0, a1, trim, isSlide, floatGain) => {
        if (a1 < a0) return;
        let area = 0, y0 = H, y1 = -1;
        for (let y = h0; y <= h1; y++) {
          const row = y * W;
          for (let x = a0; x <= a1; x++) {
            if (labelBuf[row + x] !== root) continue;
            area++;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
        if (!area || y1 < 0) return;
        const bw = (a1 - a0 + 1) / W, bh = (y1 - y0 + 1) / H;
        if (bh < 0.22 || bw < 0.025 || bh / bw < 1.10) return;
        const cx = (a0 + a1 + 1) / (2 * W);
        if (cx < 0.06 || cx > 0.94) return;
        const fill = area / Math.max(1, (a1 - a0 + 1) * (y1 - y0 + 1));
        /* 实心家具（柜门/墙）整段填充率接近 1，直接排除。
         * 滑窗候选要更严 —— 它是"从画面边往里裁"出来的，最容易在纯家具上
         * 裁出一个伪人段（探针实测：纯门框/整面衣柜场景曾报出幻影人）。
         * 上限取 0.72 是**实测数据定出来的**：真人在滑窗段里的填充率约 0.62
         * （人形轮廓有凹陷），而门框/柜门被裁出来的窄条填充率 0.81 —— 两者
         * 不重叠，一刀切在 0.72 能"保真人、拒家具"。这比继续抬高宽度比例闸
         * 更安全：抬比例会连真人一起切掉（如 CX=0.20 @2400 的真人段）。 */
        if (fill > (isSlide ? 0.72 : 0.88)) return;
        /* 宽度闸也**不能是绝对值** —— 家具被裁到恰好 5 列（bw=0.05）时照样
         * 能溜过去。改成相对**裁剪前块宽**的比例：真人是"一大块里切出来的一段"
         * （比例 ≥0.25），家具裁出来的窄条只是它自己的零头（比例 ~0.1）。 */
        if (isSlide && bw < Math.max(0.04, origBw * 0.25)) return;
        /* 滑窗候选的"填充率"权重加大：从画面边往里裁时，"裁得少"会让
         * 柜子留在段里、块更大也更居中，是个**假信号**；真正能把人的边界
         * 标出来的是"这一段不是实心"（填充率低）。裁剪量只作为轻微代价，
         * 否则会反过来鼓励"整块不裁"。 */
        /* 长宽比的分子用**核心宽度**，而不是整段宽度 —— 这是"张臂能被认出来"
         * 的最后一道门。
         * take() 的第一项 min(2.6, bh/bw)*1.6 本意是"人比家具竖长"，但它同时
         * 隐含奖励"越窄越好"：3m 处纯躯干段 bw=0.104 → bh/bw=5.35（封顶 2.6
         * → 4.16 分），而含手臂段 bw=0.396 → bh/bw=1.40（2.24 分）。
         * 光是这一项，躯干段就领先 1.9 分，把上一轮 floating() 好不容易保住
         * 的**对称手臂段**又压掉了 —— 表现就是 T-pose 与"双臂下垂"的 bbox
         * 逐字段完全相同（都 0.104），checks.arms 恒 0.6。
         * 修法：floatGain 那一轮（唯一会把悬空细列并进来的轮次）用**不含悬空列
         * 的核心跨度** bwCore 去算 bh/bw。张开的双臂本来就是"躯干 + 两侧肢体"，
         * 拿肢体的宽度去判"矮胖"是方向性错误。
         * 但要防"窄核心 + 巨宽肢体"骗分：核心宽占比过小（>6.5 倍）就不给这个
         * 优待，退回整段宽度 —— 真人臂展/躯干宽约 4 倍，6.5 倍够用，
         * 而横贯画面的横条家具（十几倍）拿不到这个便宜。 */
        let bwRatio = bw;
        if (floatGain) {
          let c0 = -1, c1 = -1;
          for (let x = a0; x <= a1; x++) {
            const cc = x - w0;
            if (cc < 0 || cc >= cols || cnt[cc] < minCol) continue;
            if (c0 < 0) c0 = cc;
            c1 = cc;
          }
          if (c0 >= 0) {
            const bwCore = Math.max(0.025, (c1 - c0 + 1) / W);
            if (bw <= bwCore * 6.5) bwRatio = bwCore;
          }
        }
        const score = Math.min(2.6, bh / bwRatio) * 1.6
          + Math.min(0.9, bh) * 1.2
          + (1 - Math.min(1, Math.abs(cx - 0.5) * 2)) * 2.4
          - Math.abs(fill - 0.5) * (isSlide ? 8 : 2.2)
          + Math.min(4, Math.log1p(area) * 0.35)
          - ((a0 <= 1 || a1 >= W - 2) ? 1.2 : 0)
          - (trim > 0 ? (trim / W) * 2 : 0);
        if (!best || score > best.score) {
          best = { score: score, a0: a0, a1: a1, y0: y0, y1: y1, area: area };
        }
      };

      /* 候选 A：按"空列"分段（人和家具之间还看得见地板/缝时走这条）。
       * 什么算"空列"：既要有绝对下限（挡掉人形边缘的碎点），也要按最高列
       * 取一个比例 —— 柜子和人之间的缝里常常还看得见**同深度**的地板，
       * 那几列不是 0 而是"很矮"，只卡绝对下限切不开。 */
      const cols = w1 - w0 + 1;
      const cnt = new Int32Array(cols);
      let cmax = 0;
      for (let y = h0; y <= h1; y++) {
        const row = y * W;
        for (let x = w0; x <= w1; x++) if (labelBuf[row + x] === root) cnt[x - w0]++;
      }
      for (let c = 0; c < cols; c++) if (cnt[c] > cmax) cmax = cnt[c];
      const minCol = Math.max(
        Math.max(1, Math.round((h1 - h0 + 1) * 0.08)),
        Math.round(cmax * 0.18)
      );
      /* 但"很矮的列"有两种，必须分开：
       *   (a) 人+家具之间的缝 —— 里面是同深度的地板，**贴着块的底部**；
       *   (b) **张开的双臂** —— 一条细横条，只占几行，**悬在块的中上部**，
       *       根本不碰块底。
       * 原来只按"矮"就判空列，(b) 也被当成缝切掉了：孩子一张开胳膊，
       * 手臂像素连同 wrist/elbow/hand 关节整块消失，bbox 宽度和"双臂下垂"
       * 一模一样（实测 3m 处 T-pose 与垂臂都是 0.104），
       * evaluatePose 的"双手张开"检查因此永远通不过。
       * 判据：矮列若与块底脱开 ≥15% 块高，就是悬空的细条（四肢），
       * 要并入人身，不能当缝切掉。 */
      const colBot = new Int32Array(cols).fill(-1);
      for (let y = h0; y <= h1; y++) {
        const row = y * W;
        for (let x = w0; x <= w1; x++) {
          if (labelBuf[row + x] !== root) continue;
          colBot[x - w0] = y;              // 逐行递增，最后一次就是该列最低行
        }
      }
      const botSlack = Math.max(2, Math.round((h1 - h0 + 1) * 0.15));
      const floating = (c) => colBot[c] >= 0 && colBot[c] < h1 - botSlack;

      /* 浮列还必须**左右对称**才承认是张开的手臂 —— 这是本次的关键约束。
       * 只按"悬空"就并入，会把"贴住人身、下方悬空的横条家具"（搁板 / 半墙 /
       * 护栏 / 吧台 / 晾衣杆）当成手臂：这类家具右端贴住孩子躯干、只有**一侧**，
       * 并进来会把 bbox 重心整块拉向那一边。QA 实测复现：儿童居中站位、
       * 左侧悬空横板（右端贴躯干缘、下缘高 980mm、厚 90mm）@3000mm
       *   → bbox 从 0.104 撑到 0.375、cx 从 0.500 掉到 0.365，
       *   正是"一后退绿块就偏到屏幕边"的老症状回归。
       * 真手臂（侧平举 / 斜下举 / V 举）**左右成对**，两侧浮列宽度同量级；
       * 单侧伸出的窄条与单侧家具在单帧深度图里本来就无法区分，宁可当作
       * "没张开"（arms 权重只有 0.35，且引导语已改成"分数够高就保持"，
       * 不会阻塞流程），也不要把家具并进来污染 bbox。 */
      let coreL = W, coreR = -1;
      for (let c = 0; c < cols; c++) {
        if (cnt[c] >= minCol) { if (c < coreL) coreL = c; if (c > coreR) coreR = c; }
      }
      let fL = 0, fR = 0;
      for (let c = 0; c < cols; c++) {
        if (cnt[c] >= minCol || !floating(c)) continue;
        if (c < coreL) fL++;
        else if (c > coreR) fR++;
      }
      const symFloat = fL > 0 && fR > 0 && Math.min(fL, fR) >= Math.max(fL, fR) * 0.35;

      /* 按"空列"分段。跑**两轮**：
       *   第 1 轮 只按 minCol 分段 —— 等价于"修复前"的行为（把手臂也当缝切掉）；
       *   第 2 轮 额外把"对称的悬空细列"（张开的双臂）并入。
       * 两轮的候选一起进 take() 比形态分，谁能过 `bh/bw >= 1.10` 且分高谁赢。
       * 为什么必须两轮、而不是直接用第 2 轮：
       *   "人 + 同深度横条家具 + 张臂"这种组合场景下，横板（搁板/半墙/吧台）
       *   会把整块撑得很宽（实测 3m 处 bw 0.40 → 0.53），`bh/bw` 掉到 1.013 < 1.10
       *   → 含浮列的段被 take() 拒掉，而候选 B 的滑窗又只在"贴画面边"时才跑
       *   → 两条路都断 → **整块丢人**（QA 复核时实测到）。
       *   有了第 1 轮，这时"纯躯干段"还在候选里（ratio 5.15 轻松过闸），
       *   于是退回修复前的结果：绿块干净地框住人、不识别张臂，但**不丢人**。
       *   取舍：横板旁张臂时 bbox 不含横板（宁可少认一次张臂，也不让绿块
       *   连横板一起框进去、把重心拉偏 —— 那正是用户最初抱怨的"偏到屏幕边"）。
       *   也就是：加了张臂支持之后，最差也不比修复前更差。 */
      const segRound = (useFloat) => {
        let runStart = -1;
        for (let c = 0; c <= cols; c++) {
          const on = c < cols && (cnt[c] >= minCol || (useFloat && floating(c)));
          if (on) { if (runStart < 0) runStart = c; continue; }
          if (runStart < 0) continue;
          take(w0 + runStart, w0 + c - 1, 0, false, useFloat);
          runStart = -1;
        }
      };
      /* 第 1 轮先跑"只按 minCol 分段"（等价修复前行为），**再**跑并入浮列的轮次。
       * 顺序有讲究：take() 只在 score 严格更大时才替换 best，同分时先到的胜出。
       * 我们希望"能认出张臂就认出"，所以浮列轮放后面没关系 —— 它的分数靠
       * bwRatio 修正后会明显高过躯干段。 */
      segRound(false);
      if (symFloat) segRound(true);

      /* 候选 B：从贴边侧向内滑动边界。人和家具在画面里**横向叠在一起**
       * （柜子从画面边一直伸到人的身侧，列方向没有任何缝隙）时，候选 A
       * 只能切出一整段"人 + 柜子"。这时向内滑窗：人比家具窄 —— 滑到人身上
       * 时 bh/bw 明显变大、填充率降到合理区间，得分自然高过整段。
       * 两类候选一起比 score 取最优，避免"切不开就整块选中、绿块贴到边上"。 */
      if (w0 <= 1) for (let x0 = w0; x0 <= w1; x0++) take(x0, w1, x0 - w0, true);
      if (w1 >= W - 2) for (let x1 = w1; x1 >= w0; x1--) take(w0, x1, w1 - x1, true);

      if (!best) return false;
      for (let y = h0; y <= h1; y++) {
        const row = y * W;
        for (let x = w0; x <= w1; x++) {
          const i = row + x;
          if (labelBuf[i] !== root) continue;
          if (x < best.a0 || x > best.a1) labelBuf[i] = 0;
        }
      }
      compArea[root] = best.area;
      compMinX[root] = best.a0; compMaxX[root] = best.a1;
      compMinY[root] = best.y0; compMaxY[root] = best.y1;
      return true;
    }

    // 两遍扫描 + 并查集，找出最大的一块连通域（8-连通）。
    // 顺手把 labelBuf 压平成"根编号"，后面就能直接 === root 判断归属。
    /* 诊断用：把 0/1 掩码渲染成 ASCII（每行一个字符串）。
     * 只在调用方显式取用时才生成，不进热路径。 */
    function maskAscii(mask) {
      const out = [];
      for (let y = 0; y < H; y++) {
        let s = "";
        for (let x = 0; x < W; x++) s += mask[y * W + x] ? "#" : ".";
        out.push(s);
      }
      return out;
    }
    /* 判断一块连通域的横向轮廓是否**左右对称**。
     * 用途：区分"张开的双臂"和"单侧伸出的家具"（搁板/半墙/护栏/吧台）。
     *   张臂的人：躯干在中间（高列），左右各伸出一段细列 → 两侧都有延伸；
     *   人 + 左侧搁板：躯干 + **只有左侧**一段延伸 → 单侧。
     * 这个判据在本文件里已被验证过（见 splitByColumnGap 的 symFloat），
     * 这里复用它来守卫"又宽又居中"的块。
     * 返回 { sym, extL, extR }：extL/extR = 核心列两侧"有像素的列数"。 */
    function colSymmetry(r) {
      const w0 = compMinX[r], w1 = compMaxX[r], h0 = compMinY[r], h1 = compMaxY[r];
      const cols = w1 - w0 + 1;
      if (cols <= 0) return { sym: false, extL: 0, extR: 0 };
      const cnt = new Int32Array(cols);
      for (let y = h0; y <= h1; y++) {
        const row = y * W;
        for (let x = w0; x <= w1; x++) if (labelBuf[row + x] === r) cnt[x - w0]++;
      }
      let mx = 0;
      for (let c = 0; c < cols; c++) if (cnt[c] > mx) mx = cnt[c];
      const thr = Math.max(2, Math.round(mx * 0.35));   // 核心列 = 高度达到峰值 35% 的列
      let cL = -1, cR = -1;
      for (let c = 0; c < cols; c++) if (cnt[c] >= thr) { if (cL < 0) cL = c; cR = c; }
      if (cL < 0) return { sym: false, extL: 0, extR: 0 };
      let extL = 0, extR = 0;
      for (let c = 0; c < cL; c++) if (cnt[c] > 0) extL++;
      for (let c = cR + 1; c < cols; c++) if (cnt[c] > 0) extR++;
      const sym = extL > 0 && extR > 0 && Math.min(extL, extR) >= Math.max(extL, extR) * 0.5;
      return { sym: sym, extL: extL, extR: extR };
    }

    function labelComponents() {
      labelBuf.fill(0);
      let next = 0;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const i = row + x;
          if (!shapeMask[i]) continue;
          let lb = 0;
          const l = x > 0 ? labelBuf[i - 1] : 0;
          if (l) lb = l;
          if (y > 0) {
            const tl = x > 0 ? labelBuf[i - W - 1] : 0;
            const t = labelBuf[i - W];
            const tr = x < W - 1 ? labelBuf[i - W + 1] : 0;
            if (tl && (!lb || tl < lb)) lb = tl;
            if (t && (!lb || t < lb)) lb = t;
            if (tr && (!lb || tr < lb)) lb = tr;
          }
          if (!lb) { next++; ufParent[next] = next; lb = next; }
          labelBuf[i] = lb;
          if (l) ufUnion(lb, l);
          if (y > 0) {
            if (x > 0 && labelBuf[i - W - 1]) ufUnion(lb, labelBuf[i - W - 1]);
            if (labelBuf[i - W]) ufUnion(lb, labelBuf[i - W]);
            if (x < W - 1 && labelBuf[i - W + 1]) ufUnion(lb, labelBuf[i - W + 1]);
          }
        }
      }

      compArea.fill(0);
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const i = row + x;
          if (!labelBuf[i]) continue;
          const r = ufFind(labelBuf[i]);
          labelBuf[i] = r;
          const a = ++compArea[r];
          if (a === 1) {
            compMinX[r] = x; compMaxX[r] = x;
            compMinY[r] = y; compMaxY[r] = y;
          } else {
            if (x < compMinX[r]) compMinX[r] = x;
            if (x > compMaxX[r]) compMaxX[r] = x;
            if (y < compMinY[r]) compMinY[r] = y;
            if (y > compMaxY[r]) compMaxY[r] = y;
          }
        }
      }
      /* 最大面积那块往往是近处地板、侧边的柜子/门框/窗帘、或者墙角。
       * 真人有三个特征：竖长、站在画面中段、轮廓不是一块实心矩形。
       *
       * 面积必须只做轻微加权，绝不能让 log1p(area) 主导：
       * 孩子往后退时人在画面里越来越小，而侧边柜子/门框的像素数基本不变，
       * 一旦按面积选，退到两三米时连通域就会整块跳到侧边物件上——
       * 表现就是"一后退，绿色色块就贴到屏幕边上去了"。 */
      let bestRoot = 0, bestScore = -Infinity;
      /* 同时记住"最大的那块非全宽连通域"当兜底。
       * 人跟侧边家具连成一块时，这一整块的长宽比可能刚好不到 1.10
       * （比如 0.43 宽 × 0.46 高），按形状就被提前否掉了 ——
       * 而它其实只是"人 + 家具"，切开就对了。所以先留着，切完再复核形状。 */
      let fallback = 0, fallbackArea = 0;
      /* 还有一种兜底：贴着画面边、填充率又很高的大块。
       * 典型是「人 + 同深度侧边柜子」在画面里横向叠在一起 —— 整块几乎是
       * 实心矩形，过不了下面的填充率闸门，但它里面**确实有人**。
       * 先记下来，实在找不到人时切开试试（切开后形状不合格就当没有）。 */
      let sideFB = 0, sideFBArea = 0;
      for (let r = 1; r <= next; r++) {
        const area = compArea[r];
        // 上限放宽到 0.60：人跟侧边家具连成一块时会到 40% 以上，
        // 这里先放进来，后面按列切开、按形状打分再决定要不要它
        if (area < PIX * 0.005 || area > PIX * 0.60) continue;
        const w0 = compMinX[r], w1 = compMaxX[r], h0 = compMinY[r], h1 = compMaxY[r];
        // 横跨整幅画面 = 地板/墙这类背景带，绝不是人
        if (w0 <= 1 && w1 >= W - 2) continue;
        if (area > fallbackArea) { fallbackArea = area; fallback = r; }
        const bw = (w1 - w0 + 1) / W;
        const bh = (h1 - h0 + 1) / H;
        const cx = (w0 + w1 + 1) / (2 * W);
        const cy = (h0 + h1 + 1) / (2 * H);
        if (bh < 0.22 || bw < 0.025 || bh / bw < 1.10) continue;
        // 填充率接近 1 = 一块实心矩形（柜子/门板/墙），人的轮廓远没有这么满。
        // 但贴边的高填充块也可能是"人 + 侧边家具"叠在一起，留给兜底切开。
        const fill = area / Math.max(1, (w1 - w0 + 1) * (h1 - h0 + 1));
        if (fill > 0.88) {
          if ((w0 <= 1 || w1 >= W - 2) && area > sideFBArea) { sideFBArea = area; sideFB = r; }
          continue;
        }
        // 人一般不会站到画面最边上；但孩子真站偏了也得能认出来，
        // 所以越界只扣分不直接拒绝（极端贴边的家具由"贴边扣分"和填充率挡）
        const offCenter = Math.max(0, Math.abs(cx - 0.5) - 0.36);
        const delta = lastSkeletonCenter
          ? Math.hypot(cx - lastSkeletonCenter.x, cy - lastSkeletonCenter.y) : 0;
        if (lastSkeletonCenter && delta > 0.34) continue;
        // 形状与位置说了算，面积只占很小一份
        // 贴到左右画面边的先扣分（大概率是家具），稍后再尝试按列把它切开
        const touchSide = (w0 <= 1 || w1 >= W - 2);
        const score = Math.min(2.6, bh / bw) * 1.6
          + Math.min(0.9, bh) * 1.2
          + (1 - Math.min(1, Math.abs(cx - 0.5) * 2)) * 2.4
          - Math.abs(fill - 0.5) * 2.2
          + Math.min(4, Math.log1p(area) * 0.35)
          - (touchSide ? 1.2 : 0)
          - offCenter * 8
          - delta * 10;
        if (score > bestScore) { bestScore = score; bestRoot = r; }
      }
      /* 供"张臂抢救"使用：在**所有**合格候选里挑面积最大的那块，记录它的形态。
       * 不用 bestRoot —— 主选可能是被"竖长"加权的窄躯干段，而张臂时
       * 含手臂的整块才是长得最像人的那一块。 */
      let gcRoot = 0, gcArea = 0;
      for (let r = 1; r <= next; r++) {
        const area = compArea[r];
        if (area < PIX * 0.005 || area > PIX * 0.60) continue;
        const w0 = compMinX[r], w1 = compMaxX[r], h0 = compMinY[r], h1 = compMaxY[r];
        if (w0 <= 1 && w1 >= W - 2) continue;
        const bh = (h1 - h0 + 1) / H, bw = (w1 - w0 + 1) / W;
        if (bh < 0.22 || bw < 0.025 || bh / bw < 1.10) continue;
        if (area > gcArea) { gcArea = area; gcRoot = r; }
      }
      const gcBW = gcRoot ? (compMaxX[gcRoot] - compMinX[gcRoot] + 1) / W : 0;
      const gcBH = gcRoot ? (compMaxY[gcRoot] - compMinY[gcRoot] + 1) / H : 0;
      const gcCx = gcRoot ? (compMinX[gcRoot] + compMaxX[gcRoot] + 1) / (2 * W) : 0.5;
      const gcW0 = gcRoot ? compMinX[gcRoot] : 0;
      const gcW1 = gcRoot ? compMaxX[gcRoot] : 0;
      const gcFill = gcRoot ? compArea[gcRoot] / Math.max(1,
        (gcW1 - gcW0 + 1) * (compMaxY[gcRoot] - compMinY[gcRoot] + 1)) : 1;
      /* 横向轮廓必须**左右对称**才算"张开双臂的人"。
       * 只靠"宽 + 居中"不够：单侧伸出的搁板也能把 bbox 撑宽到 0.32、
       * 重心拉到 0.44（实测）。加上对称约束后，单侧家具不满足条件。 */
      const gcSym = gcRoot ? colSymmetry(gcRoot) : { sym: false, extL: 0, extR: 0 };
      /* gc 诊断**随返回值一起交出去**，不写全局。
       * 原因（踩过的坑）：labelComponents 一帧内会被调用 3 次 ——
       * ①候选带扫描 ②最终掩码重建 ③extractSkeleton 里再算一次。
       * ③ 那一帧 shapeMask 已被收窄成"最终那一块"，根本没有宽块可选，
       * 于是它算出的 gc 是"窄躯干"形态（bw 0.14）——把 ② 的正确结论覆盖掉。
       * 之前据此得出的"抢救候选取到了被切后的躯干"结论，其实是③的噪声。
       * 现在只有 depthPersonMask 里那次（②）才写进 depthDebugInfo。 */
      const gcInfo = {
        root: gcRoot, bw: Math.round(gcBW * 100) / 100, bh: Math.round(gcBH * 100) / 100,
        cx: Math.round(gcCx * 100) / 100, fill: Math.round(gcFill * 100) / 100,
        sym: gcSym.sym, extL: gcSym.extL, extR: gcSym.extR,
        w0: gcW0, w1: gcW1
      };
      /* 候选链（按顺序尝试，**第一个通过复核的胜出**）：
       *   1) gcRoot **不切开** —— 保手臂。仅当它满足"宽 + 居中 + 左右对称 +
       *      非实心"才入列；这组条件在物理上只有"张开双臂的人"能满足
       *      （侧边家具从画面边伸进来 → 必贴边/必单侧）。
       *   2) gcRoot 切开；
       *   3) bestRoot / fallback / sideFB（各自切开）。
       * 顺序有讲究：**先试"保手臂"，失败就退回切开**，最差与修复前完全一致。
       *
       * 为什么需要 gcRoot 而不是直接用 bestRoot：
       *   张臂时 bestRoot 常常是"窄躯干段"（长宽比加权更高），
       *   含手臂的整块才是真正像人的那块，所以在合格候选里单独挑**面积最大**的一块。 */
      const gcWideOK = gcBW >= 0.22 && gcBW <= 0.52
        && gcW0 > 3 && gcW1 < W - 4
        && Math.abs(gcCx - 0.5) <= 0.12
        && gcBH / gcBW >= 1.10 && gcBH >= 0.22
        && gcFill <= 0.55 && gcSym.sym;
      const attempts = [];
      if (gcRoot && gcWideOK) attempts.push({ r: gcRoot, doSplit: false });
      const order = [];
      if (bestRoot) order.push(bestRoot);
      if (fallback && order.indexOf(fallback) < 0) order.push(fallback);
      if (sideFB && order.indexOf(sideFB) < 0) order.push(sideFB);
      if (gcRoot && order.indexOf(gcRoot) < 0) order.push(gcRoot);
      for (let i = 0; i < order.length; i++) attempts.push({ r: order[i], doSplit: true });

      let keep = 0, pathTag = "none", splitTag = "none";
      for (let ti = 0; ti < attempts.length; ti++) {
        const r = attempts[ti].r;
        const w0 = compMinX[r], w1 = compMaxX[r];
        const h0 = compMinY[r], h1 = compMaxY[r];
        let split = false;
        /* 块宽 > 0.22 就切开会**砍掉张开的双臂**：张臂的人整块 bw≈0.31 →
         * 切开后"窄躯干段"以长宽比优势胜出 → 宽度只剩 0.135。
         * 0.22 这个阈值区分不了"张臂的人"(0.31) 和"人+侧边家具"(0.375)，
         * 区间重叠，所以不能只靠宽度决定切不切；靠上面的 gcRoot 保手臂试一试，
         * 失败再回来走这里。 */
        if (attempts[ti].doSplit) {
          if ((w1 - w0 + 1) / W > 0.22 || w0 <= 1 || w1 >= W - 2) {
            split = splitByColumnGap(r, w0, w1, h0, h1);
          }
        }
        /* 切开之后再复核一次形状。兜底候选（人 + 家具连成一块）在切开前
         * 长宽比可能不合格，切开后才看得出来；反过来，一块纯实心的家具
         * 切不开，也在这里被"填充率"挡掉。 */
        const fw0 = compMinX[r], fw1 = compMaxX[r];
        const fh0 = compMinY[r], fh1 = compMaxY[r];
        const fbw = (fw1 - fw0 + 1) / W, fbh = (fh1 - fh0 + 1) / H;
        const fcx = (fw0 + fw1 + 1) / (2 * W);
        const ffill = compArea[r] / Math.max(1, (fw1 - fw0 + 1) * (fh1 - fh0 + 1));
        if (fbh >= 0.22 && fbw >= 0.025 && fbh / fbw >= 1.10
          && fcx >= 0.06 && fcx <= 0.94 && ffill <= 0.88) {
          keep = r;
          pathTag = (r === bestRoot) ? "main" : (r === fallback ? "fallback" : "sideFB");
          splitTag = split ? "slide" : "none";
          break;
        }
      }
      /* path/split 是给回归探针做归因用的：明确告诉外部"这一帧是被哪条候选、
       * 有没有走滑窗裁剪放行的"，避免把 sideFB / 滑窗的问题算到主判据头上。 */
      return {
        root: keep, area: keep ? compArea[keep] : 0, path: pathTag, split: splitTag,
        gc: gcInfo, gcWideOK: !!(gcRoot && gcWideOK), nComp: next
      };
    }

    // 逐带统计：左右边界 / 列质心 / 左右簇中心 / 运动能量
    function scanBands(root, minX, maxX, minY, maxY) {
      const bboxH = maxY - minY + 1;
      for (let b = 0; b < BANDS; b++) {
        const band = bandList[b];
        const y0 = minY + Math.floor((b * bboxH) / BANDS);
        const y1 = minY + Math.max(Math.floor(((b + 1) * bboxH) / BANDS), Math.floor((b * bboxH) / BANDS) + 1) - 1;

        bandHist.fill(0);
        let cnt = 0, mn = W, mx = -1, mo = 0;
        for (let y = y0; y <= y1 && y < H; y++) {
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const i = row + x;
            if (labelBuf[i] !== root) continue;
            cnt++;
            if (x < mn) mn = x;
            if (x > mx) mx = x;
            if (!bandHist[x]) bandHist[x] = 1;
            if (motionMask[i]) mo++;
          }
        }
        if (!cnt || mx < 0) { band.ok = false; continue; }

        band.ok = true;
        band.cnt = cnt;
        band.top = y0 / H;
        band.bottom = (y1 + 1) / H;
        band.L = mn / W;
        band.R = (mx + 1) / W;
        // 该部位"有多少比例正在动"——关节点靠它点亮
        band.energy = clamp((mo / Math.max(8, cnt)) * 3, 0, 1);

        // 列累积（0/1 直方图的累积和），O(W) 就能查出任意切点两侧的簇中心
        let c = 0, s = 0;
        for (let x = 0; x < W; x++) {
          cumC[x] = c; cumS[x] = s;
          if (bandHist[x]) { c++; s += x; }
        }
        cumC[W] = c; cumS[W] = s;
        band.C = c ? (cumS[W] / c + 0.5) / W : (mn + mx + 1) / 2 / W;

        // 最大间隙：双腿分开时，两腿之间会有一段空白列
        let gap = 0, gapAt = -1, last = -1;
        for (let x = mn; x <= mx; x++) {
          if (!bandHist[x]) continue;
          if (last >= 0 && x - last > gap) { gap = x - last; gapAt = last; }
          last = x;
        }
        const split = gap >= Math.max(3, (mx - mn + 1) * 0.22);
        band.split = split;
        if (split) {
          const lc = cumC[gapAt + 1] - cumC[mn];
          const ls = cumS[gapAt + 1] - cumS[mn];
          const rc = cumC[mx + 1] - cumC[gapAt + 1];
          const rs = cumS[mx + 1] - cumS[gapAt + 1];
          band.cL = lc ? (ls / lc + 0.5) / W : band.L;
          band.cR = rc ? (rs / rc + 0.5) / W : band.R;
        } else {
          // 两腿接近时不能把整条人形的外沿当作左右髋/膝，
          // 否则胯会突然张到手臂宽度、投到 3D 后交叉成团。
          const half = Math.min(0.035, (band.R - band.L) * 0.16);
          band.cL = band.C - half;
          band.cR = band.C + half;
        }

        /* ---- 外轮廓边界 oL / oR：解决"手臂糊进躯干" ----
         * 问题：手臂自然下垂时，L/R 就是整个人形的左右边界，手臂和躯干混在一起。
         * 手臂张开时，外轮廓最外侧确实是手——但躯干部分的外轮廓比手靠内很多。
         * 解决：取"该带掩码最左/最右的 15% 像素"的平均位置，而不是绝对最左/最右。
         * 这样手臂张开时 oL/oR 会跟着手走；手臂垂下时 oL/oR 回落到躯干边缘，
         * 不会把整根垂下的手臂算到躯干里去。 */
        const outerRatio = 0.15;
        const outerCnt = Math.max(1, Math.round(c * outerRatio));
        // 左外轮廓：从最左往右数 outerCnt 个像素
        let olC = 0, olS = 0, olN = 0;
        for (let x = mn; x <= mx && olN < outerCnt; x++) {
          if (!bandHist[x]) continue;
          olC++; olS += x; olN++;
        }
        band.oL = olC ? (olS / olC + 0.5) / W : band.L;
        // 右外轮廓：从最右往左数 outerCnt 个像素
        let orC = 0, orS = 0, orN = 0;
        for (let x = mx; x >= mn && orN < outerCnt; x--) {
          if (!bandHist[x]) continue;
          orC++; orS += x; orN++;
        }
        band.oR = orC ? (orS / orC + 0.5) / W : band.R;
      }
    }

    // 在归一化高度 u 处取某条带统计量（相邻带线性插值，骨架才不会一跳一跳）
    function atU(u, key) {
      const f = clamp(u, 0, 0.9999) * BANDS;
      const i0 = Math.floor(f);
      const t = f - i0;
      const i1 = Math.min(BANDS - 1, i0 + 1);
      const a = bandList[i0], b = bandList[i1];
      const va = a.ok ? a[key] : null;
      const vb = b.ok ? b[key] : null;
      if (va === null && vb === null) return null;
      if (va === null) return vb;
      if (vb === null) return va;
      return va + (vb - va) * t;
    }

    function extractSkeleton() {
      const comp = labelComponents();
      // 远处人形允许占画面 0.5% 起；上限与 labelComponents 保持一致
      // （人跟侧边家具连成一块时会超过 40%，那里已经按列切开了）。
      if (comp.area < PIX * 0.005 || comp.area > PIX * 0.60) {
        skel.has = false;
        skel.root = 0;
        if (++lostSkeletonFrames > 8) {
          lastSkeletonCenter = null;
          lastPersonDepth = 0;
          skelSmooth = {};
          trails = {};
        }
        return;
      }
      lostSkeletonFrames = 0;

      const root = comp.root;
      const minX = compMinX[root], maxX = compMaxX[root];
      const minY = compMinY[root], maxY = compMaxY[root];
      scanBands(root, minX, maxX, minY, maxY);
      lastSkeletonCenter = {
        x: (minX + maxX + 1) / (2 * W),
        y: (minY + maxY + 1) / (2 * H)
      };

      const yTop = minY / H;
      const hVis = (maxY + 1) / H - yTop;
      const joints = {};
      const energy = {};

      // 不凭身高猜测头/脚并强行延长轮廓：远距离会把一小块噪声
      // 拉成整个人，头脚的位置随距离跳变。只映射真实检测到的区域。
      const hFull = hVis;

      for (let k = 0; k < JOINTS.length; k++) {
        const name = JOINTS[k][0], u = JOINTS[k][1], key = JOINTS[k][2];
        const nx = atU(u, key);
        if (nx === null) continue;
        joints[name] = { x: nx, y: yTop + hFull * u };
        const e = atU(u, "energy");
        energy[name] = e === null ? 0 : e;
      }

      // 胯中点
      if (joints.hipL && joints.hipR) {
        joints.hipMid = { x: (joints.hipL.x + joints.hipR.x) / 2, y: (joints.hipL.y + joints.hipR.y) / 2 };
        energy.hipMid = (energy.hipL + energy.hipR) / 2;
      } else if (joints.hipL || joints.hipR) {
        const only = joints.hipL || joints.hipR;
        joints.hipMid = { x: only.x, y: only.y };
        energy.hipMid = energy.hipL || energy.hipR || 0;
      }

      // 躯干上端必须落在颈与胯之间；此前延长到颈以上，会让胸腔穿过头部。
      if (joints.neck && joints.hipMid) {
        joints.torsoTop = {
          x: joints.neck.x * 0.65 + joints.hipMid.x * 0.35,
          y: joints.neck.y * 0.65 + joints.hipMid.y * 0.35
        };
        energy.torsoTop = ((energy.neck || 0) + (energy.hipMid || 0)) / 2;
      }

      /* ---- 张臂时的肘/腕/手：不能按固定的 u 取 ----
       * JOINTS 表把 elbow/wrist/hand 写死在 u=0.32/0.42/0.45 —— 那是**手臂自然
       * 下垂**时它们所在的高度。孩子一侧平举，整条手臂抬到肩膀高度（u≈0.17），
       * 那几个固定的 u 就落回躯干上了；紧接着下面"肘腕必须与躯干分离"的检查
       * 判定不分离、把关节全删掉 —— 结果**孩子越使劲张臂，骨架上越看不见手臂**。
       * 修法：先按"最宽带"找出双臂所在的高度，再把肘/腕/手放到那条带上；
       * "必须明显分离"的检查保留（手臂贴身时依然不显示，避免把躯干边缘
       * 捏造出的假肢体误当成手臂动作）。 */
      let armBandU = -1;
      {
        let bMax = -1, wMax = 0, bwSum = 0, wCnt = 0;
        for (let b = 0; b < BANDS; b++) {
          const bd = bandList[b];
          if (!bd || !bd.ok) continue;
          const bw = bd.R - bd.L;
          bwSum += bw; wCnt++;
          if (bw > wMax) { wMax = bw; bMax = b; }
        }
        const wMean = wCnt ? bwSum / wCnt : 0;
        // 与 evaluatePose 的"双手张开"用同一套阈值，两处判定必须一致
        if (bMax >= 0 && wMax >= 0.15 && wMean > 1e-6 && wMax / wMean >= 1.5) {
          armBandU = (bMax + 0.5) / BANDS;
        }
      }

      // 单目深度轮廓无法在手臂贴身时区分肘腕；沿躯干边缘捏造的
      // 肘腕会被误认为手臂动作，因此仅在腕/肘明显分离时显示。
      const torsoL = atU(0.48, "oL"), torsoR = atU(0.48, "oR");
      if (armBandU >= 0 && torsoL !== null && torsoR !== null) {
        const armE = atU(armBandU, "energy") || 0;
        const outL = atU(armBandU, "oL"), outR = atU(armBandU, "oR");
        const armY = yTop + hFull * armBandU;
        // 沿"躯干边缘 → 手臂外沿"这一条水平线铺开肩以下的关节
        if (outL !== null && outL < torsoL) {
          const at = t => torsoL + (outL - torsoL) * t;
          if (joints.midL) { joints.midL = { x: at(0.22), y: armY }; energy.midL = armE; }
          joints.elbowL = { x: at(0.45), y: armY }; energy.elbowL = armE;
          joints.foreL = { x: at(0.68), y: armY }; energy.foreL = armE;
          joints.wristL = { x: at(0.82), y: armY }; energy.wristL = armE;
          joints.handL = { x: at(1.00), y: armY }; energy.handL = armE;
        }
        if (outR !== null && outR > torsoR) {
          const at = t => torsoR + (outR - torsoR) * t;
          if (joints.midR) { joints.midR = { x: at(0.22), y: armY }; energy.midR = armE; }
          joints.elbowR = { x: at(0.45), y: armY }; energy.elbowR = armE;
          joints.foreR = { x: at(0.68), y: armY }; energy.foreR = armE;
          joints.wristR = { x: at(0.82), y: armY }; energy.wristR = armE;
          joints.handR = { x: at(1.00), y: armY }; energy.handR = armE;
        }
      }
      ["L", "R"].forEach(side => {
        const elbow = joints["elbow" + side];
        const wrist = joints["wrist" + side];
        const separated = elbow && wrist && torsoL !== null && torsoR !== null &&
          (side === "L"
            ? elbow.x < torsoL - 0.012 && wrist.x < torsoL - 0.012
            : elbow.x > torsoR + 0.012 && wrist.x > torsoR + 0.012);
        if (!separated) {
          ["mid", "elbow", "fore", "wrist", "hand"].forEach(part => {
            delete joints[part + side];
            delete energy[part + side];
            delete skelSmooth[part + side];
          });
        }
      });

      // 时间平滑：否则每帧的掩码抖动会让骨架乱颤
      Object.keys(joints).forEach(name => {
        const cur = joints[name];
        const prev = skelSmooth[name];
        if (prev) {
          cur.x = prev.x + (cur.x - prev.x) * SK_ALPHA;
          cur.y = prev.y + (cur.y - prev.y) * SK_ALPHA;
        }
        skelSmooth[name] = { x: cur.x, y: cur.y };
      });

      // 末端关节的运动轨迹（手划过的地方留一串淡点，"感应感"更强）
      TRAIL_JOINTS.forEach(name => {
        const p = joints[name];
        if (!p) { trails[name] = []; return; }
        if (!trails[name]) trails[name] = [];
        trails[name].push({ x: p.x, y: p.y });
        while (trails[name].length > TRAIL_LEN) trails[name].shift();
      });

      skel.has = true;
      skel.root = root;
      skel.area = comp.area / PIX;
      skel.bbox = { x: minX / W, y: minY / H, w: (maxX - minX + 1) / W, h: (maxY - minY + 1) / H };
      skel.joints = joints;
      skel.energy = energy;
      skel.bands = bandList;
    }

    /* ---------- 叠加层绘制：人形轮廓 + 骨架 ---------- */

    function ensureOverlayBuffers() {
      if (!debugCanvas) {
        debugCanvas = document.createElement("canvas");
        debugCanvas.width = W;
        debugCanvas.height = H;
        debugCtx = debugCanvas.getContext("2d");
        debugImg = debugCtx.createImageData(W, H);
      }
      if (!glowCanvas) {
        // 比采样尺寸还小，两次平滑放大之后自然形成柔光边
        glowCanvas = document.createElement("canvas");
        glowCanvas.width = 32;
        glowCanvas.height = 24;
        glowCtx = glowCanvas.getContext("2d");
      }
    }

    // 把"最大的一块人形"画进 debugCanvas（只画这一块，噪点不算）
    function paintShapeMask() {
      const d = debugImg.data;
      const root = skel.root;
      for (let i = 0, p = 0; i < PIX; i++, p += 4) {
        if (shapeMask[i] && labelBuf[i] === root) {
          d[p] = 34; d[p + 1] = 211; d[p + 2] = 238; d[p + 3] = 255;
        } else {
          d[p + 3] = 0;
        }
      }
      debugCtx.putImageData(debugImg, 0, 0);
    }

    function strokeBones(c, sx, sy) {
      const J = skel.joints;
      c.beginPath();
      for (let k = 0; k < BONES.length; k++) {
        const a = J[BONES[k][0]], b = J[BONES[k][1]];
        if (!a || !b) continue;
        c.moveTo(a.x * sx, a.y * sy);
        c.lineTo(b.x * sx, b.y * sy);
      }
      c.stroke();
    }

    function paintOverlay() {
      if (!overlay || !overlayCtx) return;
      const w = overlay.width || 640;
      const h = overlay.height || 480;
      const c = overlayCtx;
      c.clearRect(0, 0, w, h);
      // OpenNI 深度图和浏览器 UVC 彩色图是两条未经标定/配准的相机流。
      // 深度可用时直接显示深度坐标系自己的剪影，绝不叠在彩色视频上。
      if (depthOn) {
        c.fillStyle = "#101c2e";
        c.fillRect(0, 0, w, h);
        if (skel.has) {
          ensureOverlayBuffers();
          paintShapeMask();
          c.save();
          c.globalAlpha = 0.55;
          c.imageSmoothingEnabled = false;
          c.drawImage(debugCanvas, 0, 0, w, h);
          c.restore();
        }
      }
      if (!skel.has) return;

      ensureOverlayBuffers();
      paintShapeMask();

      // ---- 1) 人形轮廓：柔光层 + 清晰层 ----
      // 透明度压得比较低，是刻意的：轮廓只负责告诉孩子"系统框住你了"，
      // 不能盖住画面里的人，否则看起来像一坨色块而不是感应效果。
      glowCtx.clearRect(0, 0, 32, 24);
      glowCtx.imageSmoothingEnabled = true;
      glowCtx.drawImage(debugCanvas, 0, 0, 32, 24);

      c.save();
      c.globalAlpha = 0.2;
      c.imageSmoothingEnabled = true;
      c.drawImage(glowCanvas, 0, 0, w, h);
      c.globalAlpha = 0.07;
      c.imageSmoothingEnabled = false;
      c.drawImage(debugCanvas, 0, 0, w, h);
      c.restore();

      // ---- 2) 骨架连线：先描一层深色底，再叠亮线 ----
      const J = skel.joints;
      const sx = w, sy = h;
      c.save();
      c.lineCap = "round";
      c.lineJoin = "round";
      c.strokeStyle = "rgba(6, 18, 30, 0.8)";
      c.lineWidth = Math.max(4, w * 0.013);
      strokeBones(c, sx, sy);
      c.strokeStyle = "#22d3ee";
      c.lineWidth = Math.max(1.6, w * 0.0045);
      c.shadowColor = "rgba(34, 211, 238, 0.85)";
      c.shadowBlur = w * 0.018;
      strokeBones(c, sx, sy);
      c.restore();

      // ---- 3) 末端关节的运动轨迹（手/脚划过的地方留一串淡点）----
      c.save();
      for (let t = 0; t < TRAIL_JOINTS.length; t++) {
        const tr = trails[TRAIL_JOINTS[t]];
        if (!tr || tr.length < 2) continue;
        for (let i = 0; i < tr.length; i++) {
          const a = (i + 1) / tr.length;
          c.beginPath();
          c.arc(tr[i].x * sx, tr[i].y * sy, Math.max(1.2, w * 0.0035) * a, 0, Math.PI * 2);
          c.fillStyle = "rgba(125, 240, 255, " + (0.5 * a).toFixed(3) + ")";
          c.fill();
        }
      }
      c.restore();

      // ---- 4) 关节点：正在动的关节更大更亮 ----
      c.save();
      c.shadowColor = "rgba(34, 211, 238, 0.95)";
      c.shadowBlur = w * 0.02;
      Object.keys(J).forEach(name => {
        if (VIRTUAL_JOINTS[name]) return;
        const p = J[name];
        const e = skel.energy[name] || 0;
        const r = Math.max(3, w * 0.0075) * (1 + e * 0.85);
        c.beginPath();
        c.arc(p.x * sx, p.y * sy, r, 0, Math.PI * 2);
        c.fillStyle = e > 0.45 ? "#f0fdff" : "#22d3ee";
        c.fill();
        c.beginPath();
        c.arc(p.x * sx, p.y * sy, r * 0.42, 0, Math.PI * 2);
        c.shadowBlur = 0;
        c.fillStyle = e > 0.45 ? "#22d3ee" : "#0e7490";
        c.fill();
        c.shadowBlur = w * 0.02;
      });
      c.restore();
    }

    /* ---------- 信号与计次 ---------- */

    function pushSeries(t) {
      series.push({
        t,
        motion: live.motion,
        area: live.area,
        centroidX: live.centroidX,
        centroidY: live.centroidY,
        width: live.width,
        height: live.height,
        bottomL: live.bottomL,
        bottomR: live.bottomR,
        left: live.left,
        right: live.right,
        upper: live.upper,
        lower: live.lower
      });
      const cutoff = t - MAXSEC;
      while (series.length && series[0].t < cutoff) series.shift();
    }

    function signalWindow(key, seconds) {
      const t = series.length ? series[series.length - 1].t : 0;
      const from = t - seconds;
      const raw = [];
      for (let i = series.length - 1; i >= 0; i--) {
        if (series[i].t < from) break;
        const fn = SIGNALS[key];
        raw.unshift(fn ? fn(series[i]) : series[i].motion);
      }
      return raw;
    }

    // 去趋势：减去**局部**均值（消掉缓慢漂移），再除以**整段**标准差。
    //
    // 这里刻意不用局部标准差：视频帧率和 rAF 不同步时，同一帧会被重复采样，
    // 信号里会出现一段段"平台"。平台段里局部标准差接近 0，用它做分母会把
    // 摄像头噪声放大成假峰，一次动作被数成两次。用整段标准差做尺度就稳了。
    //
    // 均值窗口取"节奏上限对应的一个周期"：周期性的那一拍在一个周期上均值
    // 刚好为 0，会被完整保留。
    function detrend(raw, win) {
      const out = new Array(raw.length);
      const half = Math.max(1, Math.floor(win / 2));
      let gsum = 0;
      for (let i = 0; i < raw.length; i++) gsum += raw[i];
      const gm = gsum / raw.length;
      let gvar = 0;
      for (let i = 0; i < raw.length; i++) gvar += (raw[i] - gm) * (raw[i] - gm);
      const gstd = Math.sqrt(gvar / raw.length) || 1e-6;

      for (let i = 0; i < raw.length; i++) {
        const a = Math.max(0, i - half);
        const b = Math.min(raw.length, i + half + 1);
        let m = 0;
        for (let j = a; j < b; j++) m += raw[j];
        m /= (b - a);
        out[i] = (raw[i] - m) / gstd;
      }
      return out;
    }

    function smooth(raw, k) {
      if (k <= 1) return raw.slice();
      const out = new Array(raw.length);
      for (let i = 0; i < raw.length; i++) {
        let s = 0, n = 0;
        for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += raw[j]; n++; }
        out[i] = s / n;
      }
      return out;
    }

    // 峰值计次：带迟滞的过零检测，一次完整"下-上"算一次动作
    function detectReps(now) {
      if (!profile || profile.mode !== "rep") return;
      const band = cfg("tempoBand") || [20, 60];
      const win = clamp(Math.round(fps * 60 / Math.max(15, band[1])), 3, Math.round(fps * 1.5));
      const smoothK = Math.max(1, Math.round(fps * 0.06));
      const minGap = cfg("minRepGap") || 0.5;

      signalList().forEach(key => {
        if (!repCounters[key]) repCounters[key] = { armed: false, lastAt: -1 };
        const st = repCounters[key];
        const raw = signalWindow(key, 3.5);
        if (raw.length < 10) return;
        const d = smooth(detrend(raw, win), smoothK);
        const rms = Math.sqrt(mean(d.map(v => v * v))) || 1;
        const k = clamp(rms * 0.85, 0.45, 2.2);

        // 只看最近加入的一小段，避免同一拍被重复计数
        const tail = Math.min(d.length, Math.max(2, Math.round(fps * 0.35)));
        for (let i = d.length - tail; i < d.length; i++) {
          const v = d[i];
          if (v < -k) st.armed = true;
          else if (v > k && st.armed) {
            if (st.lastAt < 0 || now - st.lastAt >= minGap) {
              reps += 1;
              repTimes.push(now);
              if (repTimes.length > 40) repTimes.shift();
              st.lastAt = now;
            }
            st.armed = false;
          }
        }
      });
      repTimes.sort((a, b) => a - b);
    }

    /* ---------- 保持类 ---------- */

    function updateHold(dt) {
      if (!profile || profile.mode !== "hold") return;
      const st = stability();
      if (live.motion > (cfg("holdMinEnergy") || 0.0012) && st > 0.3) holdSeconds += dt;
    }

    /* ---------- 实时提示 ---------- */

    // 最近约 1.5 秒内有没有用深度看到人。
    // 中间偶尔一帧分不出来（比如跳到最高点、被自己的手挡一下）不该立刻
    // 说"没看到你"，所以看的是一个时间窗而不是当前帧。
    function depthSeen() {
      if (depthOn) return true;
      if (depthSeenAt < 0 || !framesSeen) return false;
      return (framesSeen - depthSeenAt) < Math.max(6, Math.round(fps * 1.5));
    }

    // 深度有数据、但没分出人时，判断该让人往哪边挪
    function depthGuide() {
      if (nearestFG > 0 && nearestFG < 700) {
        return { text: "离摄像头太近了（最近的东西只有 " + Math.round(nearestFG / 100) / 10 +
                       " 米）。往后退到 2~3.5 米。", level: "warn" };
      }
      if (depthCoverage < 0.05) {
        return { text: "深度画面基本是空的。检查一下摄像头有没有被挡住，或者换个 USB 口。", level: "warn" };
      }
      return { text: "没看到人。站到摄像头前面，离镜头 2~3.5 米。", level: "warn" };
    }

    function updateHint() {
      if (!profile) { hint = "先选一个动作，再开始。"; hintLevel = "info"; return; }

      // 预览态（还没点"开始这一组"）：只提示"看没看到你"，不催动作
      if (previewing) {
        if (calibrating()) { hint = "正在校准画面，先站好别动…"; hintLevel = "info"; return; }

        // 深度能看见"站着不动的人"（灰度背景差看不出来，会把人学掉），
        // 所以只要深度在跑，就优先听深度的——这也是提示语准不准的关键。
        if (depthLink && depthLink.available() && !depthSeen()) {
          const g = depthGuide();
          hint = g.text; hintLevel = g.level; return;
        }
        if (depthSeen()) {
          if (depthArea > 0 && depthArea < 0.02) {
            hint = "看到你了，但太小了。再走近一点。"; hintLevel = "info"; return;
          }
          hint = depthNear
            ? "看到你了（约 " + (Math.round(depthNear / 100) / 10) + " 米）！点「开始这一组」就开始计时计数。"
            : "看到你了！点「开始这一组」就开始计时计数。";
          hintLevel = "good";
          return;
        }

        if (!skel.has) { hint = "没看到人。往后退一点，让全身都进画面。"; hintLevel = "warn"; return; }
        if (live.area < 0.03) { hint = "看到你了，但有点小。再走近一点，让整个人占满画面中间。"; hintLevel = "info"; return; }
        hint = "看到你了！点「开始这一组」就开始计时计数。";
        hintLevel = "good";
        return;
      }

      if (profile.mode === "none") { hint = "这个动作摄像头测不了，换一个动作吧。"; hintLevel = "warn"; return; }
      if (calibrating()) { hint = "正在校准画面，先站好别动…"; hintLevel = "info"; return; }

      // 计时中：深度在跑就按深度判断"人还在不在画面里"。
      // 人中途走开（喝水、休息）时立刻说清楚，回来也立刻恢复——
      // 深度不需要重新学背景，所以是真的一帧就回来。
      if (depthLink && depthLink.available() && !depthSeen()) {
        const g = depthGuide();
        hint = g.text; hintLevel = g.level; return;
      }

      if (live.area > 0 && live.area < 0.012) {
        hint = "离摄像头太远了，走近一点，让整个人占满画面中间。";
        hintLevel = "warn";
        return;
      }

      if (live.motion < 0.0012) {
        hint = profile.mode === "hold"
          ? "没检测到身体张力。保持住，让身体有一点点用力的微动。"
          : "没检测到动作，动作做开一点，让身体动起来。";
        hintLevel = "warn";
        return;
      }

      if (profile.mode === "hold") {
        const st = stability();
        if (st > 0.7) { hint = "很稳，保持住！"; hintLevel = "good"; }
        else if (st > 0.4) { hint = "有点晃，把身体收紧一点。"; hintLevel = "info"; }
        else { hint = "晃得比较多，重新调整一下姿势。"; hintLevel = "warn"; }
        return;
      }

      if (profile.mode === "burst") {
        const ar = activeRatio(3);
        if (ar > 0.8) { hint = "很连贯，就这样别停。"; hintLevel = "good"; }
        else if (ar > 0.5) { hint = "中间停顿有点多，尽量连着做。"; hintLevel = "info"; }
        else { hint = "停下来太久了，坚持一下，把时间做满。"; hintLevel = "warn"; }
        const sym0 = symmetry();
        if (sym0 > 0 && sym0 < 0.72) { hint = "左右不太均衡，注意两边都要用上力。"; hintLevel = "warn"; }
        return;
      }

      const band = cfg("tempoBand") || [20, 60];
      const t = tempo();
      if (t > 0 && t < band[0] * 0.75) { hint = "节奏偏慢，再快一点点。"; hintLevel = "info"; }
      else if (t > band[1] * 1.3) { hint = "节奏太快了，稳住，把动作做完整。"; hintLevel = "warn"; }
      else if (t > 0) { hint = "节奏很好，就这样保持。"; hintLevel = "good"; }
      else { hint = "开始做吧，做完一次系统就会数一次。"; hintLevel = "info"; }

      const sym = symmetry();
      if (sym > 0 && sym < 0.72) { hint = "左右不太均衡，注意两边都要做。"; hintLevel = "warn"; }
      if (amplitude() < 0.28) { hint = "幅度再大一点，做充分一些。"; hintLevel = "info"; }
    }

    /* ---------- 主循环 ---------- */

    function loop() {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      if (!sample()) return;

      // 预览态：只做画面分析、画骨架，不计时、不计数、不评分。
      // 这样孩子一开摄像头就能看到"系统看到我了"，而正式计时从点"开始"算起。
      if (previewing) {
        frames++;
        ticks++;
        if (elapsed === 0) fpsWindowStart = 0;
        const pnow = (performance.now() - startedAt) / 1000;
        if (pnow - fpsWindowStart >= 0.5) {
          if (pnow > fpsWindowStart) fps = clamp(frames / (pnow - fpsWindowStart), 5, 60);
          frames = 0;
          fpsWindowStart = pnow;
        }
        analyze();
        updateHint();
        paintOverlay();
        emit();   // 预览态每帧都发，校准界面才能实时响应
        return;
      }

      const now = (performance.now() - startedAt) / 1000;
      const dt = elapsed > 0 ? Math.min(0.5, now - elapsed) : 1 / 25;
      elapsed = now;
      frames++;
      ticks++;
      if (now - fpsWindowStart >= 0.5) {
        if (now > fpsWindowStart) fps = clamp(frames / (now - fpsWindowStart), 5, 60);
        frames = 0;
        fpsWindowStart = now;
      }

      analyze();
      pushSeries(now);
      detectReps(now);
      updateHold(dt);
      updateHint();
      paintOverlay();

      motionSum += live.motion;
      motionFrames++;
      if (live.motion > peakMotion) peakMotion = live.motion;

      emit();   // 每帧都发：减少 UI 延迟，骨架跟着手走
    }

    /* ---------- 对外接口 ---------- */

    function getLive() {
      return Object.assign({}, live, {
        fps, reps, tempo: tempo(), elapsed,
        intensity: intensity(), calibrating: calibrating(),
        previewing
      });
    }

    // 骨架快照：给界面/测试看"系统认出了几个人体、关节在哪"
    function skeletonSnapshot() {
      const diag = { maskThresh: lastMaskThresh, otsuRaw: lastOtsuRaw, fgRatio: Math.round(lastFgRatio * 1000) / 1000 };
      if (!skel.has) return Object.assign({ has: false, jointCount: 0, joints: {} }, diag);
      const out = {};
      Object.keys(skel.joints).forEach(name => {
        const p = skel.joints[name];
        out[name] = {
          x: Math.round(p.x * 1000) / 1000,
          y: Math.round(p.y * 1000) / 1000,
          energy: Math.round((skel.energy[name] || 0) * 100) / 100
        };
      });
      return Object.assign({
        has: true,
        area: Math.round(skel.area * 10000) / 10000,
        bbox: skel.bbox,
        jointCount: Object.keys(out).length,
        visibleJointCount: Object.keys(out).filter(n => !VIRTUAL_JOINTS[n]).length,
        joints: out,
        /* 逐带轮廓快照（只读诊断用）。手臂识别与"双手张开"检查都依赖
         * bandList 的宽度/split，回归探针必须能直接看到它 —— 否则只能看到
         * 最终 bbox，无法判断"手臂是被裁了、还是被量到了但判据没认"。
         * 这里只做浅拷贝，不参与任何计算。 */
        bands: bandList.map(b => ({
          ok: b.ok, L: b.L, R: b.R, C: b.C, oL: b.oL, oR: b.oR,
          split: b.split, cnt: b.cnt, energy: b.energy
        }))
      }, diag);
    }

    function attach(sourceEl) {
      source = sourceEl;
      if (!canvas) initBuffers();
    }

    function attachOverlay(canvasEl) {
      overlay = canvasEl;
      overlayCtx = canvasEl ? canvasEl.getContext("2d") : null;
    }

    // 接上深度来源（DepthLink.createLink({width:W, height:H})）。
    // 传 null 就退回纯彩色分析。桥接服务没跑时链接自己会一直 available()===false。
    function attachDepth(link) {
      depthLink = link || null;
      if (!canvas) initBuffers();
      depthOn = false;
      structureReset();      // 换了深度源 → 房间可能变了，重采结构基线
    }

    function setProfile(p) {
      profile = p ? Object.assign({}, DEFAULT_PROFILE, p) : null;
      resetCounters(true);   // 换动作时保留背景：房间没变，不用重新学
    }

    function setGoal(g) {
      goal = g || null;
    }

    // keepVision = true 时保留背景模型与已学到的画面统计。
    // 从"预览"切到"正式计时"必须保留：否则背景要重新学，开头一两秒
    // 整幅画面都会被当成前景，骨架会糊成一大块。
    function resetCounters(keepVision) {
      repCounters = {};
      reps = 0;
      repTimes = [];
      holdSeconds = 0;
      series = [];
      elapsed = 0;
      frames = 0;
      ticks = 0;
      fpsWindowStart = 0;
      motionSum = 0;
      motionFrames = 0;
      peakMotion = 0;
      if (keepVision) return;
      framesSeen = 0;
      if (bg) bg.fill(-1);
      if (bgShape) bgShape.fill(-1);
      bgShapeInit = -1;
      skelSmooth = {};
      trails = {};
      skel.has = false;
      skel.root = 0;
      structureReset();      // 重新开始 → 重采房间结构基线
    }

    function reset() {
      resetCounters();
      live = {
        motion: 0, area: 0, energy: 0,
        centroidX: 0.5, centroidY: 0.5,
        width: 0, height: 0, top: 0, bottom: 0, bottomL: 0, bottomR: 0,
        left: 0, right: 0, upper: 0, lower: 0, thresh: 0
      };
      hint = "站到画面中间，让全身都能看到";
      hintLevel = "info";
      pose = null;
    }

    // 预览：摄像头一打开就跑起来，只做分析 + 画骨架。
    // 目的是让孩子立刻看到"系统看到我了"，而不是点完开始才有反馈。
    function preview() {
      if (!canvas) initBuffers();
      resetCounters();
      previewing = true;
      running = true;
      startedAt = performance.now();
      if (!raf) raf = requestAnimationFrame(loop);
    }

    // 正式开始计时计分：保留已经学好的背景，只清统计量
    function start() {
      if (!canvas) initBuffers();
      const wasRunning = running;
      resetCounters(wasRunning);      // 已经在预览跑着 → 保住背景
      previewing = false;
      running = true;
      startedAt = performance.now();
      if (!wasRunning || !raf) raf = requestAnimationFrame(loop);
    }

    // 结束一组后回到预览态：骨架继续显示，但不再计分
    function pause() {
      resetCounters(true);
      previewing = true;
      startedAt = performance.now();
      if (!running) { running = true; raf = requestAnimationFrame(loop); }
    }

    function stop() {
      running = false;
      previewing = false;
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    }

    function onTick(cb) { listeners.push(cb); }

    return {
      attach, attachOverlay, attachDepth, setProfile, setGoal,
      start, stop, pause, preview, reset, getLive, getState, onTick,
      getSkeleton: skeletonSnapshot,
      getPose: function () { return pose; },
      depthStats: function () { return depthLink ? depthLink.stats() : null; },
      depthDebug: function () { return depthDebugInfo; },
      beginRoomScan: beginRoomScan,
      roomScanInfo: function () {
        return {
          ready: stReady, armed: stArmed, samples: stSamples, need: ST_WARM_FRAMES,
          coverage: stCoverage
        };
      },
      roomScanReset: structureReset,
      structureInfo: function () {
        return {
          ready: stReady, armed: stArmed, samples: stSamples, warm: ST_WARM_FRAMES,
          coverage: stCoverage,
          linkAvail: !!(depthLink && depthLink.available && depthLink.available()),
          gen: stGen
        };
      },
      // 诊断：查某一格的结构基线，核对"为什么这一格被剔/被留"
      structureProbe: function (x, y) {
        const i = (y | 0) * W + (x | 0);
        return {
          x: x | 0, y: y | 0,
          ok: stOk[i], bg: Math.round(stBg[i]),
          min: Math.round(stMin[i]), max: Math.round(stMax[i]),
          dep: dep ? Math.round(dep[i]) : 0,
          stripped: !!(stOk[i] && dep && Math.abs(dep[i] - stBg[i]) < ST_MATCH_TOL)
        };
      },
      WIDTH: W, HEIGHT: H
    };
  }

  /* ---------- 打分 ---------- */

  // 把一次体感跟练的统计量算成 0-100 分 + 分项 + 中文反馈
  //   profile: 动作的 motion 参数（mode / tempoBand / expectedAmplitude …）
  //   stats:   getState() 的快照
  //   goal:    { reps } | { seconds } | { holdSeconds }
  function scoreSession(profile, stats, goal) {
    const g = goal || {};
    const s = stats || {};
    const parts = {};
    const hints = [];

    if (!profile || profile.mode === "none") {
      return { total: 0, parts: {}, hints: ["这个动作是慢速拉伸，摄像头测不出动作质量，不计入体感评分。"] };
    }

    const elapsed = Math.max(0, s.elapsed || 0);

    if (profile.mode === "hold") {
      const target = Math.max(5, g.holdSeconds || profile.holdSeconds || 30);
      const held = Math.max(0, s.holdSeconds || 0);
      const ratio = clamp(held / target, 0, 1);

      parts["完成"] = Math.round(ratio * 100);
      parts["稳定"] = clamp(Math.round((s.stability || 0) * 100), 0, 100);
      parts["连续"] = clamp(Math.round((s.activeRatio || 0) * 100), 0, 100);

      if (ratio >= 1) hints.push(`保持满了 ${Math.round(held)} 秒，目标 ${target} 秒，达标。`);
      else hints.push(`保持住了 ${Math.round(held)} 秒，目标 ${target} 秒，还差 ${Math.max(1, Math.round(target - held))} 秒。撑不住可以歇一下再来一组。`);
      if (parts["稳定"] < 55) hints.push("身体晃得比较多，注意把核心收紧，肩膀放松。");
      if (parts["连续"] < 50) hints.push("中间停顿偏多，尽量连贯地保持，别一会儿放松一会儿收紧。");
      if (held < 3) hints.push("几乎没检测到保持时间。保持类动作需要身体有一点点用力的微动，别完全僵住不动。");
    } else if (profile.mode === "burst") {
      // 高频动作（高抬腿、小步跑、登山跑…）数不准次数，
      // 改成测"有没有一直在动、动得有多猛"——这也正是这些动作的训练目的。
      const seconds = Math.max(5, g.seconds || profile.burstSeconds || 30);
      const active = (s.activeRatio || 0) * elapsed;
      parts["完成"] = clamp(Math.round((Math.min(active, seconds) / seconds) * 100), 0, 100);
      parts["强度"] = clamp(Math.round((s.intensity || 0) * 100), 0, 100);
      parts["连续"] = clamp(Math.round((s.activeRatio || 0) * 100), 0, 100);

      if (active < seconds * 0.8) hints.push(`这段时间里只有约 ${Math.round(active)} 秒在动，目标 ${seconds} 秒，中间休息多了些。`);
      else hints.push(`坚持动了约 ${Math.round(active)} 秒，时间做满了。`);
      if (parts["强度"] < 45) hints.push("动作偏轻，幅度再大一点、频率再快一点，效果会更好。");
      if (parts["连续"] < 60) hints.push("中间停下来的时间比较多，尽量连着做，喘不上气可以放慢但别停。");
      const sym0 = s.symmetry || 0;
      if (sym0 > 0 && sym0 < 0.72) hints.push("左右两边不太均衡，注意两侧都要用上力。");
    } else {
      const band = profile.tempoBand || [20, 60];
      const reps = Math.max(0, Math.round(s.reps || 0));
      const targetReps = Math.max(1, g.reps || profile.targetReps || 10);

      parts["完成"] = clamp(Math.round((reps / targetReps) * 100), 0, 100);

      if (reps < targetReps) hints.push(`数到 ${reps} 次，目标 ${targetReps} 次，还差 ${targetReps - reps} 次。`);
      else hints.push(`数到 ${reps} 次，达到目标 ${targetReps} 次。`);

      // 节奏分：落在 tempoBand 区间里给满分
      const t = s.tempo || 0;
      if (t <= 0) parts["节奏"] = 0;
      else if (t >= band[0] && t <= band[1]) parts["节奏"] = 100;
      else if (t < band[0]) parts["节奏"] = clamp(Math.round(60 + 40 * (t / band[0])), 0, 100);
      else parts["节奏"] = clamp(Math.round(100 - 60 * ((t - band[1]) / band[1])), 0, 100);

      if (t > 0 && t < band[0] * 0.75) hints.push(`节奏是每分钟 ${Math.round(t)} 次，建议练到 ${band[0]}-${band[1]} 次，再快一点。`);
      else if (t > band[1] * 1.3) hints.push(`每分钟 ${Math.round(t)} 次偏快了，动作容易做不完整，稍微放慢一点。`);

      // 规范分 = 节奏均匀 + 幅度 + 左右对称 + 连续性
      const rhythm = clamp(s.rhythm || 0, 0, 1);
      const amp = clamp(s.amplitude || 0, 0, 1);
      const sym = clamp(s.symmetry || 0, 0, 1);
      const cont = clamp(s.activeRatio || 0, 0, 1);
      parts["规范"] = Math.round((rhythm * 0.35 + amp * 0.3 + sym * 0.2 + cont * 0.15) * 100);

      if (reps > 0 && rhythm > 0 && rhythm < 0.5) hints.push("每一拍的间隔不太均匀，试着跟着一个固定的节拍做。");
      if (amp > 0 && amp < 0.35) hints.push("动作幅度偏小，做开一点、做充分一点。");
      if (sym > 0 && sym < 0.72) hints.push("左右两边不太均衡，注意两侧都要用上力。");
      if (cont < 0.6) hints.push("中间停下来的时间比较多，尽量连着做。");
    }

    const weights = profile.mode === "hold"
      ? { "完成": 0.5, "稳定": 0.3, "连续": 0.2 }
      : profile.mode === "burst"
        ? { "完成": 0.5, "强度": 0.25, "连续": 0.25 }
        : { "完成": 0.5, "节奏": 0.2, "规范": 0.3 };

    let total = 0;
    Object.keys(weights).forEach(k => { total += (parts[k] || 0) * weights[k]; });
    total = clamp(Math.round(total), 0, 100);

    // 时间太短直接压分，避免"点一下开始再点结束"就拿到高分
    if (elapsed < 3 && total > 30) total = 30;

    if (!hints.length) hints.push("动作完成得不错，继续保持。");
    return { total, parts, hints: hints.slice(0, 3) };
  }

  window.MotionEngine = { createEngine, scoreSession, SIGNALS, DEFAULT_PROFILE };
})();
