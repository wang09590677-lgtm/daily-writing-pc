// 3D 体感猫角色：加载 assets/models/cat_fitness_avatar.glb（38 骨骼蒙皮模型），
// 用引擎给出的关节位置**逐骨骼瞄准（aim-based FK）**驱动，让猫跟着孩子做动作。
//
// ---- 为什么从「程序化拼几何」换成「真模型 + 骨骼」 ----
// 老版本用 CylinderGeometry/SphereGeometry 现拼一只猫，每个骨段每帧摆到两个关节
// 之间。孩子反馈"模型太简单了"，换成美术给的蒙皮模型。换的时候下面几件事真踩过：
//
//   1. **文件里的 LeftUpperArm 在 +X**（模型面朝 +Z，即面朝镜头）。
//      而引擎的 `shoulderL` = **图像 x 较小侧 = 屏幕左侧**。
//      所以引擎 L/R 与模型 L/R 是**交叉**的：引擎 shoulderL ↔ 模型 RightUpperArm。
//      对应关系写在 BONE_AIM 表里（键=模型骨骼名，值=引擎关节名），
//      别"顺手把名字对齐"，否则动作左右反。
//
//   2. **老版本的 `(0.5 - joint.x)` 是历史包袱，这里不用**。
//      新实现直接 `(joint.x - 0.5)` 不翻转：模型 +X 在屏幕上就是右侧，
//      引擎 shoulderR（图像右侧）驱动模型 LeftUpperArm（+X=屏幕右）→ 同侧，符合直觉。
//
//   3. **模型 rest 是 T-pose（双臂水平）**，不是自然站姿。
//      所以每帧必须**先把所有骨骼重置回 rest，再施加目标旋转**；否则旋转会累积，
//      几秒后拧成麻花。而"没识别到人"时也不能直接用 rest（那是"举手投降"），
//      要用 IDLE_JOINTS 摆自然站姿 —— 走的还是**同一条驱动路径**，
//      这样两种情况不会出现两套代码互相漂移。
//
//   4. **aim 依赖父级世界矩阵已更新**，必须**自顶向下**遍历（TOP_DOWN 在 init 里
//      DFS 排好），每改一根就 updateMatrixWorld，否则子骨骼永远慢一帧、动作发飘。
//
//   5. **three.min.js 里没有 GLTFLoader**（官方 r150 已移除 UMD 版），
//      所以 assets/vendor/GLTFLoader.js 是单独补的（r147 官方 UMD 版，
//      挂 THREE.GLTFLoader，与 r150 核心 API 兼容，已实测通过）。
//      加载走 fetch，在 file:// 下**依赖 start-app.bat 的
//      --allow-file-access-from-files**；没有这个 flag 会静默挂起 → 见 6。
//
//   6. **加载失败绝不能让屏幕空着**：异步加载最坏会挂到超时才放弃，
//      所以有 loadFailed 分支退回"程序化兜底猫"，保证孩子永远看得见东西；
//      加载过程中也先摆 IDLE 姿势而不是黑屏。
(function () {
  "use strict";

  /* ---------- 世界坐标约定 ----------
   * 相机是正交、从 +Z 看向原点，视口 y ∈ [-0.9, 0.9]、x ∈ [-0.9·aspect, 0.9·aspect]。
   * 模型原始约 3.08 × 3.13 × 1.42（T-pose，含耳朵），要整体缩放、再上移让脚底落地。
   *
   * ⚠️ **猫必须落在"UI 安全区"里**，否则会被全屏层的两块 UI 压住：
   *   · 顶部 `.motion-avatar-progress`（次数/时间面板）——**孩子的核心信息**，不能被压
   *   · 底部 `.motion-avatar-controls`（含「结束并评分」）——按钮要能点，也不能被压
   *   实测（1440×900）：面板占 24~198px、控制栏占 809~876px，安全区只剩
   *   世界坐标 y ∈ [-0.90, 0.46]，高 1.36。
   *   **这个区间随窗口高度变化**（窗口越矮，固定像素的 UI 占比越大、安全区越小），
   *   所以不能写死 MODEL_H / FOOT_Y —— 必须按当前窗口**动态算**（见 layoutFor）。
   *   写死过一次的代价：720p 下猫头超出安全区 0.13，头顶被面板切掉（截图抓到）。
   *
   * UI_TOP_PX    = 顶部面板下沿到窗口顶的距离（24 外边距 + 面板高）
   * UI_BOTTOM_PX = 底部控制栏上沿到窗口底的距离（24 外边距 + 控制栏高）
   * 这两个数由 CSS 的 `inset: 24px` + 内容高度决定，改样式时要跟着更新。 */
  const RAW_H = 2.96;          // 模型原始身高（GLB rest 数据：头顶 y≈2.96、脚底 y≈0）
  /* 模型里**最低的骨骼**（Toes）的 rest 高度 = 0.08（来自 GLB：LeftToes y=0.08）。
   * 为什么需要它：sp.bot 取的是引擎给的"最低踝/趾"的 y，而它对应的应该是**模型的 Toes 骨骼**，
   * 不是"网格脚底"（网格脚底在 rest y≈0，比 Toes 还低 0.08）。
   * 少了这 0.08，整条腿的目标就系统性地偏低 0.08×scale ≈ 0.035 ——
   * 实测这就是 squat 那个 0.027 的基线误差来源（脚"够不到"的那部分）。 */
  const REST_LOWEST = 0.08;
  const UI_TOP_PX = 198;
  const UI_BOTTOM_PX = 91;
  /* 安全区内缩比例（上下各留这么多）。
   * 取 4% 而不是更小，是为了给"举手过顶"留地方 —— 开合跳张臂时手大致与头顶齐平，
   * 但举手/伸展类动作的手会**高过头顶**，贴边站位就会被顶部面板切到。
   * 实测（1000×720）：留 2.5% 时，一个"单手举过顶"的姿势手会伸进面板；
   * 留 4% 后正常动作都在内，只有极端过顶姿势才会压到面板边缘一点，可接受。 */
  const SAFE_INSET = 0.03;

  /* 按窗口高度算出"猫该多大、站多高"（返回世界单位的 { H, footY }）。
   * 导出到 window.MotionAvatar.__layoutFor 供测试核对，别在测试里重算一遍公式 ——
   * 两处各算一套迟早漂移（本项目已有教训）。 */
  function layoutFor(winH) {
    const h = Math.max(240, winH || 720);
    const safeTop = 0.9 - (2 * UI_TOP_PX) / h;
    const safeBot = 0.9 - (2 * (h - UI_BOTTOM_PX)) / h;
    const avail = Math.max(0.2, safeTop - safeBot);
    return { H: avail * (1 - SAFE_INSET * 2), footY: safeBot + avail * SAFE_INSET, avail: avail };
  }
  let layout = layoutFor(720);   // 当前生效的布局（init / resize 时刷新）

  const MODEL_URL = "../assets/models/cat_fitness_avatar.glb";

  /* 两段 IK 开关（末端优先）。
   * 为什么需要它：**aim-only 只能对齐"方向"，而骨骼长度是模型固定的** ——
   * 于是"膝/肘"落在"起点 + 骨长×方向"上，与目标的膝/肘位置有偏差，且越往下累积越大，
   * 结果**脚/手到不了位**（孩子反馈"动作不如之前流畅、模拟不到位"）。
   * 旧模型是把圆柱**直接摆到两个关节之间**、长度随关节距离伸缩，所以能精确到位；
   * 蒙皮骨骼不能改长度（会拉伸网格变丑），所以改用 IK 按"末端优先"重新分配角度。
   * 设 false 可退回纯 aim，便于 A/B。 */
  const USE_IK = true;

  /* 目标位置的一阶低通系数。摄像头关节有抖动，骨架直吃生数据会"抽"。
   * 0.45 ≈ 时间常数 1~2 帧，够跟手又能压掉高频抖。调大更跟手、更抖。 */
  let JOINT_SMOOTH = (typeof window!=="undefined"&&Number.isFinite(window.__DIAG_SMOOTH))?window.__DIAG_SMOOTH:0.45;

  /* ---------- 骨骼段落表：模型骨骼 → 对应"哪两个关节之间" ----------
   * 键 = 模型骨骼名，值 = [父端关节, 子端关节, (可选)再上一级关节]。
   * 骨骼朝向 = 从父端关节指向子端关节的**方向**。
   *
   * ⚠️ 这里是本文件最容易做错的地方，一定要**瞄"关节之间的方向"而不是"绝对位置"**。
   * 第一版瞄的是绝对世界位置，结果站姿就左右不对称（实测左手高 0.45、右手高 0.04）：
   * 因为**模型骨架比例和真人不一样**（模型肩在身高 67% 处，真人约 80%），
   * 一根骨骼的起点位置跟目标的期望起点差得很远时，"指向那个点"算出来的方向就完全错了
   * —— 肩会被瞄成朝上、手臂整条翻掉。
   * 改成瞄方向后，骨骼朝向只取决于关节间的相对方向，与模型比例、骨骼绝对位置都无关，
   * 左右也天然镜像对称。
   *
   * ⚠️ 左右仍然**交叉**对应（见文件头第 1 条），别改直。 */
  const BONE_SEG = {
    Spine: ["hipMid", "neck"], Chest: ["hipMid", "neck"], UpperChest: ["hipMid", "neck"],
    Neck: ["neck", "head"], Head: ["neck", "head"],
    RightShoulder: ["neck", "shoulderL"],
    RightUpperArm: ["shoulderL", "elbowL"],
    RightLowerArm: ["elbowL", "wristL", "shoulderL"],
    RightHand: ["wristL", "handL", "elbowL"],
    LeftShoulder: ["neck", "shoulderR"],
    LeftUpperArm: ["shoulderR", "elbowR"],
    LeftLowerArm: ["elbowR", "wristR", "shoulderR"],
    LeftHand: ["wristR", "handR", "elbowR"],
    RightUpperLeg: ["hipL", "kneeL"],
    /* ⚠️ 第三项（兜底关节）**不能省**。孩子反馈"看不到膝盖之下的动作"，
     * 就是这个位置缺兜底引起的：第二项 ankleL 一旦拿不到（MediaPipe 偶尔漏、
     * 掩码链路插值不到），segDir() 会返回 null → 这根小腿**完全不瞄准**，
     * 只剩"跟着大腿被动旋转"，看起来就是膝盖以下僵住了。
     * 补上 hipL 后：缺踝时用"髋→膝"的反方向（= 沿大腿继续伸直），
     * 至少小腿会跟着大腿走，而不是整段死住。脚掌同理。 */
    RightLowerLeg: ["kneeL", "ankleL", "hipL"],
    RightFoot: ["ankleL", "toeL", "kneeL"],
    LeftUpperLeg: ["hipR", "kneeR"],
    LeftLowerLeg: ["kneeR", "ankleR", "hipR"],
    LeftFoot: ["ankleR", "toeR", "kneeR"]
  };

  const TAIL_BONES = ["Tail_01", "Tail_02", "Tail_03", "Tail_04", "Tail_05", "Tail_06"];

  /* 没识别到人时的自然站姿（归一化画面坐标，与引擎同一套）。
   * 手臂**下垂** —— 不能用模型自带 T-pose，那是"举手投降"，
   * 孩子一动没被识别到就看到猫举着双手，会以为坏了。 */
  const IDLE_JOINTS = {
    head: { x: 0.500, y: 0.098 }, neck: { x: 0.500, y: 0.215 },
    shoulderL: { x: 0.428, y: 0.262 }, shoulderR: { x: 0.572, y: 0.262 },
    elbowL: { x: 0.418, y: 0.362 }, elbowR: { x: 0.582, y: 0.362 },
    foreL: { x: 0.414, y: 0.410 }, foreR: { x: 0.586, y: 0.410 },
    wristL: { x: 0.412, y: 0.452 }, wristR: { x: 0.588, y: 0.452 },
    handL: { x: 0.411, y: 0.474 }, handR: { x: 0.589, y: 0.474 },
    hipMid: { x: 0.500, y: 0.545 }, hipL: { x: 0.462, y: 0.548 }, hipR: { x: 0.538, y: 0.548 },
    kneeL: { x: 0.458, y: 0.700 }, kneeR: { x: 0.542, y: 0.700 },
    shinL: { x: 0.457, y: 0.790 }, shinR: { x: 0.543, y: 0.790 },
    ankleL: { x: 0.456, y: 0.880 }, ankleR: { x: 0.544, y: 0.880 },
    toeL: { x: 0.456, y: 0.925 }, toeR: { x: 0.544, y: 0.925 }
  };

  /* ---------- 状态 ---------- */
  let scene, camera, renderer, container, bgMesh;
  let modelRoot = null;
  let bones = {};
  let topDown = [];
  let rest = {};                 // name → { quat, pos, worldQuat, headDir }
  let restBasis = null;          // 躯干 rest 基（供 Hips 旋转用）
  let smoothPos = {};
  let tailBase = [];
  let info = { ready: false, failed: false, boneCount: 0, skinnedCount: 0, reason: "" };
  let axisMismatch = [];   // 骨轴与"第一个子骨骼方向"夹角过大的骨骼（诊断用）
  const boneAlias = {};    // 逻辑名 → 实际骨骼（GLTFLoader 重名会加 _1 后缀，见 onModelLoaded）
  let running = false, rafId = 0, clockMs = 0, hasPose = false;
  let fallbackGroup = null;
  let lastJoints = null;

  /* 复用的临时对象：每帧要算几十次，避免持续分配造成 GC 卡顿。
   * ⚠️ 它们是**共享**的，嵌套调用会互相覆盖 —— 用之前确认没有别的调用还在用。 */
  const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  const _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();

  /* 三.js r150 有 THREE.MathUtils.clamp，但早期 UMD 版不一定有；自己带一个最省心。 */
  function clamp(a, lo, hi) { return a < lo ? lo : (a > hi ? hi : a); }
  const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
  const _q4 = new THREE.Quaternion();
  const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();

  /* 把 layout 作用到模型上（首次加载与窗口 resize 时调用）。
   * 只需改根节点的缩放与位置 —— rest 里记的 worldQuat / headDir 是**旋转量**，
   * 一様缩放和平移都不改变它们；restBasis 由方向差构造，同理不受影响。 */
  function applyLayout() {
    layout = layoutFor(window.innerHeight || 720);
    if (!modelRoot) return;
    modelRoot.scale.setScalar(layout.H / RAW_H);
    modelRoot.position.set(0, layout.footY, 0);
    modelRoot.updateMatrixWorld(true);
  }

  /* ---------- 背景 ---------- */
  function makeBackgroundTexture() {
    const cv = document.createElement("canvas");
    cv.width = 4; cv.height = 256;
    const g = cv.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "#1b2740");
    grad.addColorStop(1, "#0d1420");
    g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
    return new THREE.CanvasTexture(cv);
  }

  /* 状态条文案。提成模块级函数而不是直接用 window.MotionAvatar.setStatus ——
   * 后者归 window 那个对象字面量所有，模块作用域里直接写 `setStatus(...)`
   * 会抛 "setStatus is not defined"，而且**恰好发生在加载初始化中途**，
   * 会把后面的 rest 记录/首帧渲染整段打断（实测踩过：模型加载"失败"其实是这句报错）。 */
  function setStatusText(text) {
    const el = document.getElementById("motionAvatarStatus");
    if (el) el.textContent = text;
  }

  /* ---------- UI ---------- */
  function buildUI() {
    container = document.createElement("div");
    container.id = "motionAvatar";
    container.className = "motion-avatar hidden";
    document.body.appendChild(container);

    // 全屏猫不能遮住"结束并评分"入口，否则开始训练后无法退出。
    const controls = document.createElement("div");
    controls.className = "motion-avatar-controls";
    const status = document.createElement("span");
    status.id = "motionAvatarStatus";
    status.textContent = "等待可靠的人形轮廓";
    controls.appendChild(status);
    const back = document.createElement("button");
    back.type = "button"; back.textContent = "返回画面";
    back.addEventListener("click", hide);
    controls.appendChild(back);
    const finish = document.createElement("button");
    finish.type = "button"; finish.textContent = "结束并评分";
    finish.addEventListener("click", () => { if (typeof motionFinishSet === "function") motionFinishSet(); });
    controls.appendChild(finish);
    container.appendChild(controls);

    /* 达标进度面板。**必须放在全屏层里**：开练后这只猫铺满窗口，
     * 页面里的读数区全被盖住，孩子站两米外只看得见这一块。
     *
     * ⚠️ 初始必须带 `hidden`。原因：预览态（`st.previewing`）下 app.js **不会**调
     * `renderMotionProgress()`（见 app.js 的 `if (motionChoice && !st.previewing)`），
     * 所以 `setProgress(null)` 也不会被调用 —— 若不在这里加 hidden，
     * 猫一 show() 就会顶着一个**空面板**（灰色空进度条）挡住头顶，
     * 而且会一直挡到孩子真正开始这一组为止。（实测截图里抓到的。） */
    const progress = document.createElement("div");
    progress.className = "motion-avatar-progress hidden";
    progress.id = "motionAvatarProgress";
    const pName = document.createElement("div");
    pName.className = "map-name"; pName.id = "motionAvatarProgressName";
    const pNum = document.createElement("div");
    pNum.className = "map-num"; pNum.id = "motionAvatarProgressNum";
    const pBar = document.createElement("div"); pBar.className = "map-bar";
    const pFill = document.createElement("i"); pFill.id = "motionAvatarProgressFill";
    pBar.appendChild(pFill);
    const pSeq = document.createElement("div");
    pSeq.className = "map-seq"; pSeq.id = "motionAvatarProgressSeq";
    progress.appendChild(pName); progress.appendChild(pNum);
    progress.appendChild(pBar); progress.appendChild(pSeq);
    container.appendChild(progress);
  }

  /* ---------- 兜底简易猫（GLB 加载失败时）---------- */
  function buildFallback() {
    const g = new THREE.Group();
    const fur = new THREE.MeshStandardMaterial({ color: 0xb8b1ac, roughness: 0.88 });
    const light = new THREE.MeshStandardMaterial({ color: 0xdcd5d0, roughness: 0.9 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.23, 0.62, 16), fur);
    body.position.y = 0.62; g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 18, 14), fur);
    head.position.y = 1.06; g.add(head);
    [-1, 1].forEach(s => {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.15, 12), fur);
      ear.position.set(s * 0.12, 1.22, 0); ear.rotation.z = -s * 0.28; g.add(ear);
    });
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), light);
    muzzle.scale.set(1.1, 0.8, 0.7); muzzle.position.set(0, 1.03, 0.15); g.add(muzzle);
    [-1, 1].forEach(s => {
      const a = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.058, 0.40, 10), fur);
      a.position.set(s * 0.27, 0.70, 0); g.add(a);
      const l = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.066, 0.40, 10), fur);
      l.position.set(s * 0.10, 0.22, 0); g.add(l);
    });
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.02, 0.44, 9), fur);
    tail.position.set(0.27, 0.72, -0.16); tail.rotation.z = -0.9; g.add(tail);
    g.name = "fallbackCat";
    return g;
  }

  /* ---------- 初始化（同步部分）---------- */
  function init() {
    if (renderer || typeof THREE === "undefined") return !!renderer;
    buildUI();

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1420);

    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.OrthographicCamera(-0.9 * aspect, 0.9 * aspect, 0.9, -0.9, 0.1, 20);
    camera.position.set(0, 0, 3);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);

    bgMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: makeBackgroundTexture(), depthWrite: false })
    );
    bgMesh.position.z = -1;
    scene.add(bgMesh);

    /* 三点布光。模型是**纯色 PBR 材质、无贴图**（GLB 里 textures=0），
     * 明暗全靠灯光 —— 强度不够整只猫会糊成一团灰。 */
    scene.add(new THREE.AmbientLight(0xffffff, 0.74));
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(1.6, 3.0, 4.0); scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd8ff, 0.55);
    rim.position.set(-2.2, 1.0, -2.6); scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffffff, 0.30);
    fill.position.set(-1.0, 1.2, 3.0); scene.add(fill);

    applyLayout();          // 先按当前窗口定好布局（模型到货后 applyLayout 会再作用一次）
    window.addEventListener("resize", resize);
    loadModel();
    return true;
  }

  function resize() {
    if (!renderer || !camera) return;
    const aspect = window.innerWidth / window.innerHeight;
    camera.left = -0.9 * aspect; camera.right = 0.9 * aspect;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    sizeBackground();
    applyLayout();          // 窗口一变，安全区就变 → 猫的尺寸/站位要跟着重算
  }
  function sizeBackground() {
    if (!bgMesh || !camera) return;
    bgMesh.scale.set((camera.right - camera.left) * 1.02, (camera.top - camera.bottom) * 1.02, 1);
  }

  /* ---------- 加载 GLB ---------- */
  function loadModel() {
    if (typeof THREE.GLTFLoader !== "function") {
      info.reason = "no-loader";
      useFallback("缺少模型加载器（assets/vendor/GLTFLoader.js 未加载）");
      return;
    }
    const loader = new THREE.GLTFLoader();
    let settled = false;
    /* 超时闸：file:// 下若缺 --allow-file-access-from-files，fetch 可能
     * **既不返回也不报错**、一直挂着。那种"静默半死"比报错更难查，必须自设上限。 */
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      info.reason = "timeout";
      useFallback("模型加载超时（检查 start-app.bat 是否带 --allow-file-access-from-files）");
    }, 15000);

    loader.load(MODEL_URL, gltf => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { onModelLoaded(gltf); }
      catch (e) {
        info.reason = "init-error:" + (e && e.message ? e.message : e);
        useFallback("模型初始化失败：" + (e && e.message ? e.message : e));
      }
    }, undefined, err => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      info.reason = "load-error:" + (err && err.message ? err.message : err);
      useFallback("模型加载失败（file:// 下需要 --allow-file-access-from-files）");
    });
  }

  function useFallback(msg) {
    info.failed = true; info.ready = false;
    console.warn("[motion-avatar] " + msg);
    if (modelRoot) { scene.remove(modelRoot); modelRoot = null; }
    if (!fallbackGroup) { fallbackGroup = buildFallback(); scene.add(fallbackGroup); }
    setStatusText("动作模型不可用，已切换简版形象");
  }

  /* ---------- 模型就绪：记录 rest、排定自顶向下顺序 ---------- */
  function onModelLoaded(gltf) {
    modelRoot = gltf.scene;
    scene.add(modelRoot);
    applyLayout();                                      // 按当前窗口算尺寸/站位（不再写死）

    let skinnedCount = 0;
    modelRoot.traverse(o => {
      if (o.isBone) bones[o.name] = o;
      if (o.isSkinnedMesh) { skinnedCount++; o.frustumCulled = false; }
    });
    info.boneCount = Object.keys(bones).length;
    info.skinnedCount = skinnedCount;
    axisMismatch = [];

    /* ---- 骨骼名解析：GLTFLoader 会给**重名节点**自动加 `_1` 后缀 ----
     * 本模型里头部**骨骼节点**与头部**网格**同名 "Head"，于是骨骼被改名成 "Head_1"；
     * 而 BONE_SEG 里写的是 "Head" → `bones["Head"]` 为 undefined → 那一条**静默失效**：
     * 不报错、不警告，只是头骨永远不被瞄准（点头/转头丢失）。
     * 这是本轮被独立验证抓到的真实缺陷（我自己的自测没断言头骨，所以没暴露）。
     *
     * 所以取名一律走 resolveBone()：先精确匹配，再退回去掉 `_数字` 后缀的名字。
     * 只在"没有同名骨骼"时才建别名，避免把 Head_1 / Head_2 这类真正的兄弟骨骼搞混。 */
    Object.keys(bones).forEach(actual => {
      const logical = actual.replace(/_\d+$/, "");
      if (logical !== actual && !bones[logical] && !boneAlias[logical]) boneAlias[logical] = bones[actual];
    });

    /* 自顶向下顺序：aim 依赖父级已更新，必须按层级排。 */
    topDown = [];
    const all = Object.keys(bones).map(n => bones[n]);
    const roots = all.filter(b => !b.parent || !b.parent.isBone);
    const walk = b => { topDown.push(b); (b.children || []).forEach(c => { if (c.isBone) walk(c); }); };
    roots.forEach(walk);

    /* 记录 rest。「骨轴 headDir」= **骨骼自身的局部 +Y 轴在世界中的方向**。
     * Blender 导出的骨架，骨骼的局部 Y 轴就是沿骨长（head→tail）的方向，
     * 所以它等价于"指向下一个骨骼"。
     *
     * ⚠️ 但**不能**直接用"第一个子骨骼的方向"来代替 —— UpperChest 的子节点是
     * [LeftShoulder, Neck, RightShoulder]，第一个子偏偏是偏左上方的 LeftShoulder，
     * 拿它当骨轴会把整条躯干带歪。实测表现：站姿时左右手高度差 0.30、肩一高一低。
     * 用局部 Y 轴就与子节点分布无关了。axisCheck 里会持续盯着两者差异。 */
    topDown.forEach(b => {
      b.updateMatrixWorld(true);
      const wq = new THREE.Quaternion(); b.getWorldQuaternion(wq);
      const wp = new THREE.Vector3(); b.getWorldPosition(wp);
      const headDir = new THREE.Vector3(0, 1, 0).applyQuaternion(wq).normalize();
      // 诊断：与"第一个子骨骼方向"的夹角，用来发现还有没有别的骨骼踩同一个坑
      let altDir = null, altAngle = 0;
      const kid = (b.children || []).find(c => c.isBone);
      if (kid) {
        const kp = new THREE.Vector3(); kid.getWorldPosition(kp);
        const d = kp.sub(wp);
        if (d.lengthSq() > 1e-9) {
          altDir = d.normalize();
          altAngle = Math.acos(Math.min(1, Math.max(-1, headDir.dot(altDir)))) * 180 / Math.PI;
        }
      }
      /* 骨长 = 到第一个子骨骼的距离。IK 需要它（两段链的长度）。
       * 没有子骨骼的末端骨骼长度为 0，它们本来也不参与 IK。 */
      let boneLen = 0;
      if (kid) {
        const kp2 = new THREE.Vector3(); kid.getWorldPosition(kp2);
        boneLen = kp2.distanceTo(wp);
      }
      rest[b.name] = {
        quat: b.quaternion.clone(), pos: b.position.clone(), worldQuat: wq.clone(),
        headDir, axisGap: altAngle, len: boneLen
      };
      if (altAngle > 15) axisMismatch.push(b.name + "(" + altAngle.toFixed(0) + "°)");
    });

    // 躯干 rest 基：x = 引擎 hipL→hipR 方向（对应模型 RightUpperLeg→LeftUpperLeg），y = 胯→颈
    restBasis = makeTorsoBasis(
      worldOf("Hips"), worldOf("RightUpperLeg"), worldOf("LeftUpperLeg"), worldOf("Neck")
    );

    tailBase = TAIL_BONES.map(n => { const bb = resolveBone(n); return bb ? bb.quaternion.clone() : null; });

    info.ready = true; info.reason = "";
    setStatusText("等待可靠的人形轮廓");
    applyPose(lastJoints);
  }

  /* 取名统一入口：先精确匹配，再退回去掉 `_数字` 后缀的别名。
   * 为什么必须有它 —— 见 onModelLoaded 里 boneAlias 的注释（GLTFLoader 重名加后缀，
   * 导致 BONE_SEG 里写的 "Head" 查不到实际骨骼 "Head_1"，静默失效）。 */
  function resolveBone(name) {
    return bones[name] || boneAlias[name] || null;
  }

  function worldOf(name) {
    const b = resolveBone(name);
    if (!b) return null;
    b.updateMatrixWorld(true);
    const p = new THREE.Vector3(); b.getWorldPosition(p);
    return p;
  }

  /* ---------- 坐标映射：引擎归一化坐标 → 世界坐标 ----------
   * 缩放按**全身高**匹配：k2 = layout.H / (最低踝 − 头)。
   *
   * 试过的另一条路（记录下来免得再走一遍）：曾改成"按**腿长**匹配"，想让脚更容易够到
   * 目标（模型腿长占身高 36%，真人约 45%）。**实测更差** —— 踝误差从 0.12 推到 0.24。
   * 说明推导里有一步不成立（没时间在真机外查清），所以保持全身高匹配。
   * 剩下的"腿伸直时脚差一点"是**模型比例与真人不同**造成的物理限制，
   * 靠 IK 补不回来（IK 只能重新分配角度，不能改骨长）；方向正确即可接受。 */
  function bodySpan(j) {
    const top = (j.head && Number.isFinite(j.head.y)) ? j.head.y : 0.12;
    let bot = -Infinity;
    ["ankleL", "ankleR", "toeL", "toeR"].forEach(k => {
      if (j[k] && Number.isFinite(j[k].y)) bot = Math.max(bot, j[k].y);
    });
    if (!Number.isFinite(bot)) bot = top + 0.72;       // 看不到脚时给保守估计
    return { span: Math.min(1.15, Math.max(0.32, bot - top)), bot };
  }

  function rawWorld(j, k, sp) {
    const p = j[k];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    if (p.x < -0.35 || p.x > 1.35 || p.y < -0.35 || p.y > 1.35) return null;
    const k2 = layout.H / sp.span;                     // 归一化身高 → 世界高度
    // + REST_LOWEST*scale：把"目标最低踝/趾"对到模型的 Toes 骨骼（见常量处注释）
    const scale = layout.H / RAW_H;
    return _v1.set((p.x - 0.5) * k2, layout.footY + REST_LOWEST * scale + (sp.bot - p.y) * k2, 0);
  }

  /* 取关节目标世界位置（带低通平滑）。返回值是 smoothPos 里的常驻对象，
   * **立刻用**，别存起来等以后用（下次调用会改写它）。 */
  function jointTarget(j, k, sp) {
    const raw = rawWorld(j, k, sp);
    if (!raw) return null;
    const key = k;
    let s = smoothPos[key];
    if (!s) { s = smoothPos[key] = raw.clone(); }
    else { s.lerp(raw, JOINT_SMOOTH); }
    return s;
  }

  /* ---------- 两段 IK（末端优先）----------
   * 让"脚/手"尽量到达引擎给出的目标位置。
   *
   * 为什么必须做 —— 纯 aim 只能对齐**方向**：
   *   UpperLeg 指向"髋→膝"方向是对的，但它的**长度**是模型固定的，
   *   于是实际膝位置 = 髋 + L₁×方向 ≠ 目标的膝位置；小腿从**错的膝**出发，
   *   误差继续累积 → 脚到不了位。孩子反馈的"动作不如之前流畅、模拟不到位"就是这个。
   *   （旧模型用 `mesh.scale.y = 长度` 把圆柱直接摆到两个关节之间，所以能精确到位；
   *     蒙皮骨骼不能改长度，只能改角度分配。）
   *
   * 做法（标准 2-bone IK）：
   *   1. 根位置 = 上段骨骼的世界位置；d = |目标 − 根|，夹到可达范围 [|L₁−L₂|, L₁+L₂]
   *   2. 余弦定理求"上段与「根→目标」连线的夹角" A
   *   3. 绕弯曲轴转 A 得到**新的膝/肘位置**（而不是用引擎给的那个）
   *   4. 上段 aim 到新膝、下段 aim 到目标
   * 弯曲轴由 `poleWorld`（引擎给的膝/肘位置）确定 —— 它天然落在正确的弯曲平面里，
   * 拿它当参考就不用猜"膝盖该往哪边弯"，也就不会出现反关节。
   *
   * ⚠️ poleWorld 与"根→目标"共线时（腿完全伸直）轴会退化，此时随便取一个稳定参考轴，
   *    反正这时膝盖本来就不该弯。
   */
  function solveTwoBoneIK(rootBone, midBone, target, poleWorld) {
    if (!USE_IK || !rootBone || !midBone || !target) return false;
    const rA = rest[rootBone.name], rB = rest[midBone.name];
    if (!rA || !rB) return false;
    const L1 = rA.len, L2 = rB.len;
    if (!(L1 > 1e-4) || !(L2 > 1e-4)) return false;

    /* ⚠️ 全程用 _ik* 专用缓冲。**不能借用 aimBone 的 _v1/_v2/_v4** ——
     * aimBone 内部会改写它们（`_v2.copy(rd.headDir)`、`_v4.copy(dir)`），
     * 而本函数要在两次 aimBone 调用之间跨用中间结果，借用就会互相踩。 */
    rootBone.getWorldPosition(_ikRoot);              // 根（髋/肩）
    _ikU.copy(target).sub(_ikRoot);
    const dRaw = _ikU.length();
    if (!(dRaw > 1e-5)) return false;
    _ikU.divideScalar(dRaw);                         // 单位向量 u
    const d = clamp(L1 + L2 - 1e-4, Math.abs(L1 - L2) + 1e-4, dRaw);
    const cosA = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);   // 余弦定理
    const A = Math.acos(clamp(-1, 1, cosA));

    // 弯曲轴 = u × poleDir（poleDir = 根→引擎给的膝/肘）
    if (poleWorld) _ikPole.copy(poleWorld).sub(_ikRoot);
    else _ikPole.set(0, 0, 1);
    if (_ikPole.lengthSq() < 1e-8) _ikPole.set(0, 0, 1);
    _ikAxis.crossVectors(_ikU, _ikPole);
    if (_ikAxis.lengthSq() < 1e-8) {
      // 退化（完全伸直 / pole 与目标共线）：取一个稳定参考轴，此时本来也不该弯
      _ikAxis.crossVectors(_ikU, _ikPole.set(0, 0, 1));
      if (_ikAxis.lengthSq() < 1e-8) _ikAxis.crossVectors(_ikU, _ikPole.set(1, 0, 0));
    }
    _ikAxis.normalize();

    // 新的膝/肘位置 = 根 + rotate(u, A) × L1
    _ikMid.copy(_ikU).applyAxisAngle(_ikAxis, A).multiplyScalar(L1).add(_ikRoot);
    _ikDir.copy(_ikMid).sub(_ikRoot);
    aimBone(rootBone, _ikDir);                       // 上段指向新膝
    midBone.getWorldPosition(_ikRoot2);
    _ikDir.copy(target).sub(_ikRoot2);
    if (_ikDir.lengthSq() > 1e-8) aimBone(midBone, _ikDir);   // 下段把余差收在末端
    return true;
  }

  /* ---------- 单骨骼瞄准 ----------
   * 推导（**这里错一次就会让四肢甩到错误的平面里，务必照着推**）：
   *   世界旋转  W = W_parent · L
   *   想让世界朝向多一个世界旋转 q：W' = q · W
   *   ⇒ W_parent · L' = q · W_parent · L
   *   ⇒ **L' = W_parent⁻¹ · q · W_parent · L**
   * 注意中间的 W_parent 与 W_parent⁻¹ 是**一对夹住 q 的**，不能省 ——
   * 少了它们就变成 L' = q · L，含义完全不同：那是"把世界旋转直接当局部旋转用"，
   * 只在父级恰好没转的时候才对。
   *
   * ⚠️ 我第一版就写成了 `premultiply(Wp⁻¹)` 后接连乘 q 和 L，实际算出 L' = L·q·L。
   *    站姿、镜像对称这些粗判据**都照样通过**（因为左右是镜像对称映射，错误是对称的），
   *    只有按"子骨骼是否落在目标方向上"这条严格判据才露出来 ——
   *    实测喂"双臂平举"，手被甩到了 z=-0.33 的身后，而不是 x=+0.53 的外侧。
   *    所以本文件的自测里有一条 aim 正确性断言，别删。
   *
   * q 由「当前骨轴方向」与「期望方向 dir」用 setFromUnitVectors 得出；
   * 当前骨轴 = rest 骨轴 经过一帧旋转增量 Δ = W_now · W_rest⁻¹ 后的方向。
   * 传入的是**方向**（不是目标点），所以与模型实际骨长/骨骼位置无关。 */
  function aimBone(bone, dir) {
    const rd = rest[bone.name];
    if (!rd || !dir) return;
    bone.getWorldQuaternion(_q1);                                  // W_now
    _q2.copy(_q1).multiply(_q3.copy(rd.worldQuat).invert());       // Δ = W_now · W_rest⁻¹
    _v2.copy(rd.headDir).applyQuaternion(_q2).normalize();         // 当前骨轴
    _v4.copy(dir);
    if (_v4.lengthSq() < 1e-8) return;
    _v4.normalize();
    if (_v2.dot(_v4) > 0.99995) return;                            // 已对齐，省运算
    _q2.setFromUnitVectors(_v2, _v4);                              // q
    if (bone.parent) {
      bone.parent.getWorldQuaternion(_q1);                         // W_parent
      _q3.copy(_q1).invert();                                      // W_parent⁻¹
      // L' = Wp⁻¹ · q · Wp · L
      _q4.copy(_q3).multiply(_q2).multiply(_q1).multiply(bone.quaternion);
      bone.quaternion.copy(_q4);
    } else {
      bone.quaternion.premultiply(_q2);
    }
    bone.updateMatrixWorld(true);
  }

  /* 躯干基：x = 左→右，y = 胯→颈，z = x×y（右手系） */
  function makeTorsoBasis(hipMid, hipL, hipR, neckT) {
    if (!hipMid || !hipL || !hipR || !neckT) return null;
    const y = new THREE.Vector3().subVectors(neckT, hipMid);
    if (y.lengthSq() < 1e-8) return null; y.normalize();
    const xr = new THREE.Vector3().subVectors(hipR, hipL);
    if (xr.lengthSq() < 1e-8) return null; xr.normalize();
    const z = new THREE.Vector3().crossVectors(xr, y);
    if (z.lengthSq() < 1e-8) return null; z.normalize();
    const x = new THREE.Vector3().crossVectors(y, z).normalize();
    return new THREE.Matrix4().makeBasis(x, y, z);
  }

  function usable(joints) {
    if (!joints) return false;
    let ok = 0;
    ["head", "neck", "hipMid", "hipL", "hipR", "shoulderL", "shoulderR", "kneeL", "kneeR"].forEach(n => {
      const p = joints[n];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > -0.35 && p.x < 1.35 && p.y > -0.35 && p.y < 1.35) ok++;
    });
    return ok >= 5;
  }

  /* ---------- 摆一帧 ---------- */
  function applyPose(source) {
    lastJoints = source || null;
    if (!modelRoot) {
      // 兜底猫：只做轻微上下浮动，别让屏幕完全静止
      if (fallbackGroup) fallbackGroup.position.y = Math.sin(clockMs / 500) * 0.012;
      return;
    }
    const ok = !!(source && usable(source));
    hasPose = ok;
    const j = ok ? source : IDLE_JOINTS;
    const sp = bodySpan(j);

    /* ① 先全部复位到 rest。**必须每帧做**（文件头第 3 条）：
     * 否则旋转会在骨骼上累积，几秒后拧成麻花。 */
    for (let i = 0; i < topDown.length; i++) {
      const b = topDown[i], rd = rest[b.name];
      if (rd) { b.quaternion.copy(rd.quat); b.position.copy(rd.pos); }
    }

    /* ② 根骨骼 Hips：位置跟随胯中点；旋转由「胯左右 + 胯→颈」定基，
     * 只瞄一个方向的话，孩子扭腰/侧身时躯干朝向是错的。 */
    const hips = resolveBone("Hips");
    const hipMid = jointTarget(j, "hipMid", sp);
    const hL = jointTarget(j, "hipL", sp);
    const hR = jointTarget(j, "hipR", sp);
    const neckT = jointTarget(j, "neck", sp);
    if (hips && hipMid && hips.parent) {
      const local = new THREE.Vector3().copy(hipMid);
      hips.parent.updateMatrixWorld(true);
      hips.parent.worldToLocal(local);
      hips.position.copy(local);
      hips.updateMatrixWorld(true);

      if (hL && hR && neckT && restBasis) {
        const want = makeTorsoBasis(hipMid, hL, hR, neckT);
        if (want) {
          // Δ(世界) = 目标基 · rest基⁻¹
          // Δ(世界) = 目标基 · rest基⁻¹
          _q1.setFromRotationMatrix(_m1.copy(want).multiply(_m2.copy(restBasis).invert()));
          hips.parent.getWorldQuaternion(_q2);          // W_parent
          _q3.copy(_q2).invert();                       // W_parent⁻¹
          // L' = Wp⁻¹ · q · Wp · L（与 aimBone 同一推导，别省中间那对 Wp）
          _q4.copy(_q3).multiply(_q1).multiply(_q2).multiply(hips.quaternion);
          hips.quaternion.copy(_q4);
          hips.updateMatrixWorld(true);
        }
      }
    }

    /* ③ 自顶向下逐骨骼瞄方向（见 BONE_SEG 上方注释：瞄方向、不瞄位置）
     * 注意顺序：IK 链（上下段成对）**必须在这里跳过**，等下面单独处理 ——
     * 否则先 aim 一遍、再 IK 一遍，中间那次 aim 的结果会被浪费，
     * 而且"下段的方向"会被 aim 用错的目标污染。 */
    const ikHandled = {};
    IK_CHAINS.forEach(c => { ikHandled[c[0]] = 1; ikHandled[c[1]] = 1; });
    for (let i = 0; i < topDown.length; i++) {
      const b = topDown[i];
      if (ikHandled[b.name]) continue;
      const seg = BONE_SEG[b.name];
      if (!seg) continue;
      const dir = segDir(j, seg, sp);
      if (dir) aimBone(b, dir);
    }

    /* ④ 两段 IK：末端优先（脚/手尽量落到引擎给的位置）。
     * 放在纯 aim 之后 —— IK 只动"上下段"这四根骨骼（大腿/小腿、上臂/前臂），
     * 它们本来就要被末端约束覆盖；其余骨骼仍走 aim，互不冲突。 */
    if (USE_IK) {
      IK_CHAINS.forEach(c => {
        const [upName, loName, targetJoint, poleJoint] = c;
        const up = resolveBone(upName), lo = resolveBone(loName);
        if (!up || !lo) return;
        const tgt = jointTarget(j, targetJoint, sp);
        if (!tgt) return;
        const pole = poleJoint ? jointTarget(j, poleJoint, sp) : null;
        /* targetJoint 的返回值是共享临时对象，IK 里会用到；先拷一份免得被后续
         * jointTarget 调用改写（同一个 _v1 缓冲区）。 */
        solveTwoBoneIK(up, lo, _ikTarget.copy(tgt), pole ? _ikPole.copy(pole) : null);
      });
      /* IK 之后末端骨骼（脚/手）再 aim 一次：它们的目标可能因为上面重算而更清楚了 */
      for (let i = 0; i < topDown.length; i++) {
        const b = topDown[i];
        const seg = BONE_SEG[b.name];
        if (!seg || !IK_TAILS[b.name]) continue;
        const dir = segDir(j, seg, sp);
        if (dir) aimBone(b, dir);
      }
    }
  }

  /* IK 链定义：[上段骨骼, 下段骨骼, 末端目标关节, 弯曲参考关节]
   * 左右仍是**交叉**对应（见文件头第 1 条）。
   * 末端目标选"踝/腕"（而不是脚趾/指尖）—— 它们是两段链的自然末端；
   * 脚掌/手掌再单独 aim 到趾/指尖。 */
  const IK_CHAINS = [
    ["RightUpperLeg", "RightLowerLeg", "ankleL", "kneeL"],
    ["LeftUpperLeg", "LeftLowerLeg", "ankleR", "kneeR"],
    ["RightUpperArm", "RightLowerArm", "wristL", "elbowL"],
    ["LeftUpperArm", "LeftLowerArm", "wristR", "elbowR"]
  ];
  /* IK 之后需要重新 aim 的末端骨骼（脚掌/手掌），用它们的"上一级 → 目标"方向 */
  const IK_TAILS = { RightFoot: 1, LeftFoot: 1, RightHand: 1, LeftHand: 1 };
  const _ikTarget = new THREE.Vector3(), _ikPole = new THREE.Vector3();
  // IK 专用缓冲（绝不与 aimBone 的 _v1/_v2/_v4 混用，见 solveTwoBoneIK 内注释）
  const _ikRoot = new THREE.Vector3(), _ikRoot2 = new THREE.Vector3(), _ikU = new THREE.Vector3();
  const _ikMid = new THREE.Vector3(), _ikDir = new THREE.Vector3(), _ikAxis = new THREE.Vector3();

  /* 段落方向：父端关节 → 子端关节。子端缺失（掩码链路不给 hand/toe）时，
   * 退化为用"再上一级 → 父端"的方向顶替（等于把末梢沿上一节继续伸直）。 */
  function segDir(j, seg, sp) {
    const a = jointTarget(j, seg[0], sp);
    if (!a) return null;
    const b = jointTarget(j, seg[1], sp);
    if (b) {
      _v5.copy(b).sub(a);
      if (_v5.lengthSq() > 1e-8) return _v5.normalize();
    }
    if (seg[2]) {
      const p = jointTarget(j, seg[2], sp);
      if (p) {
        _v5.copy(a).sub(p);
        if (_v5.lengthSq() > 1e-8) return _v5.normalize();
      }
    }
    return null;
  }

  function updateFromSkeleton(joints) {
    lastJoints = joints || null;
    if (modelRoot || fallbackGroup) applyPose(joints || null);
  }

  /* ---------- 渲染循环 ---------- */
  function animate() {
    if (!running) return;
    rafId = requestAnimationFrame(animate);
    clockMs += 16.7;

    // 尾巴摆动：各节相位错开的正弦叠在 rest 上，整条变成波浪往尾尖传
    if (info.ready) {
      const t = clockMs / 1000;
      for (let i = 0; i < TAIL_BONES.length; i++) {
        const b = resolveBone(TAIL_BONES[i]), base = tailBase[i];
        if (!b || !base) continue;
        const ph = i * 0.55;
        b.quaternion.copy(base);
        b.rotateZ(Math.sin(t * 1.6 + ph) * 0.16);
        b.rotateX(Math.sin(t * 1.05 + ph * 0.7) * 0.06);
        b.updateMatrixWorld(true);
      }
    }
    renderer.render(scene, camera);
  }

  function show() {
    if (!init()) return false;               // THREE 未加载时保留原视频，不要黑屏
    if (running) return true;
    if (!hasPose) applyPose(lastJoints);
    sizeBackground();
    container.classList.remove("hidden");
    running = true;
    animate();
    return true;
  }

  function hide() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (container) container.classList.add("hidden");
    hasPose = false;
    setProgress(null);
  }

  /* ---------- 达标进度面板 ---------- */
  function setProgress(info2) {
    const box = document.getElementById("motionAvatarProgress");
    if (!box) return;
    if (!info2) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    box.classList.toggle("is-done", !!info2.done);
    box.classList.toggle("is-resting", !!info2.resting);

    const name = document.getElementById("motionAvatarProgressName");
    const num = document.getElementById("motionAvatarProgressNum");
    const fill = document.getElementById("motionAvatarProgressFill");
    const seq = document.getElementById("motionAvatarProgressSeq");

    if (name) name.textContent = info2.name || "";
    if (num) {
      if (info2.resting) num.textContent = `休息 ${Math.max(0, Math.round(info2.restLeft || 0))} 秒`;
      else if (info2.done) num.textContent = "完成！";
      else {
        const cur = info2.current == null ? 0 : info2.current;
        const tgt = info2.target == null ? 0 : info2.target;
        const fmt = v => (info2.unit === "次" ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1));
        num.textContent = tgt > 0 ? `${fmt(cur)} / ${fmt(tgt)} ${info2.unit || ""}` : `${fmt(cur)} ${info2.unit || ""}`;
      }
    }
    if (fill) fill.style.width = Math.max(0, Math.min(100, Math.round(info2.percent || 0))) + "%";
    if (seq) {
      const showSeq = info2.seqTotal > 1 && info2.seqIndex > 0;
      seq.textContent = showSeq ? `今天第 ${info2.seqIndex} / ${info2.seqTotal} 项` : "";
      seq.classList.toggle("hidden", !showSeq);
    }
  }

  window.MotionAvatar = {
    show, hide, isVisible: () => running, updateFromSkeleton, setProgress,
    setStatus: setStatusText,

    /* 仅供测试：强制同步重绘一帧。WebGL 默认 preserveDrawingBuffer=false，
     * 不重绘就读到脏数据（老版本也踩过这个坑）。 */
    __renderNow: () => { if (renderer && scene && camera) renderer.render(scene, camera); },

    /* 仅供测试：模型/骨架是否就绪，以及失败原因。 */
    __skeleton: () => ({
      ready: info.ready, failed: info.failed, reason: info.reason,
      boneCount: info.boneCount, skinnedCount: info.skinnedCount,
      boneNames: Object.keys(bones), topDownLen: topDown.length,
      tail: TAIL_BONES.filter(n => resolveBone(n)).length,
      usingFallback: !!fallbackGroup,
      axisMismatch: axisMismatch.slice()
    }),

    /* 仅供测试：取单根骨骼的世界坐标 —— 验证"跟着动"就靠它。 */
    __boneWorld: name => {
      const b = resolveBone(name);
      if (!b) return null;
      b.updateMatrixWorld(true);
      const p = new THREE.Vector3(); b.getWorldPosition(p);
      return { x: +p.x.toFixed(4), y: +p.y.toFixed(4), z: +p.z.toFixed(4) };
    },

    /* 仅供测试：一次交出若干代表骨骼的世界坐标，
     * 方便断言"喂了抬手数据 → 对应那只手真的抬高了"。 */
    __poseSnapshot: () => {
      const out = {};
      ["Hips", "Spine", "Neck", "Head",
        "LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand",
        "RightShoulder", "RightUpperArm", "RightLowerArm", "RightHand",
        "LeftUpperLeg", "LeftLowerLeg", "LeftFoot",
        "RightUpperLeg", "RightLowerLeg", "RightFoot", "Tail_06"].forEach(n => {
        const b = resolveBone(n); if (!b) return;
        b.updateMatrixWorld(true);
        const p = new THREE.Vector3(); b.getWorldPosition(p);
        out[n] = [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)];
      });
      return out;
    },

    __usingFallback: () => !!fallbackGroup,

    /* ---- 以下为**诊断专用**钩子（仅存在于 build/_diag-cat-lab-mod.js，产品文件里没有） ---- */
    __setSmooth: v => { if (Number.isFinite(v)) JOINT_SMOOTH = v; },
    __getSmooth: () => JOINT_SMOOTH,
    /* 给某根骨骼设沿骨长(Y)的缩放（拉伸）。子骨骼会继承 → 整条链变长。 */
    __setBoneScaleY: (n, s) => { const b = resolveBone(n); if (!b) return false; b.scale.set(1, s, 1); b.updateMatrixWorld(true); return true; },
    /* 拉伸后重算 rest.len（IK 依赖它，否则 IK 仍按旧骨长分配角度）。 */
    __rescaleRest: () => {
      topDown.forEach(b => {
        const kid = (b.children || []).find(c => c.isBone);
        let len = 0;
        if (kid) {
          b.updateMatrixWorld(true);
          const p = new THREE.Vector3(), q = new THREE.Vector3();
          b.getWorldPosition(p); kid.getWorldPosition(q); len = q.distanceTo(p);
        }
        if (rest[b.name]) rest[b.name].len = len;
      });
      return true;
    },
    __chainLen: (upName, loName) => {
      const u = resolveBone(upName), l = resolveBone(loName);
      if (!u || !l) return null;
      u.updateMatrixWorld(true); l.updateMatrixWorld(true);
      const p = new THREE.Vector3(), q = new THREE.Vector3();
      u.getWorldPosition(p); l.getWorldPosition(q);
      return +p.distanceTo(q).toFixed(4);
    },
    __restLen: n => (rest[n] ? +rest[n].len.toFixed(4) : null),
    /* 骨骼的父链（用来查"耳朵骨是不是挂在手臂骨下面"）。 */
    __parentChain: name => {
      const b = resolveBone(name);
      if (!b) return null;
      const out = []; let x = b;
      while (x) { out.push(x.name); x = (x.parent && x.parent.isBone) ? x.parent : null; }
      return out;
    },
    /* 每个蒙皮网格实际受哪些骨骼影响（权重>0.05 的顶点数）——用来查"谁在驱动耳朵"。 */
    __meshBones: () => {
      const out = [];
      if (!modelRoot) return out;
      modelRoot.traverse(o => {
        if (!o.isSkinnedMesh || !o.skeleton) return;
        const si = o.geometry.getAttribute("skinIndex"), sw = o.geometry.getAttribute("skinWeight");
        if (!si || !sw) { out.push({ mesh: o.name, bones: [] }); return; }
        const ia = si.array, wa = sw.array, isz = si.itemSize || 4;
        const cnt = {};
        for (let i = 0; i < si.count; i++) {
          for (let c = 0; c < isz; c++) {
            const bi = ia[i * isz + c], w = wa[i * isz + c];
            if (w > 0.05) { const nm = o.skeleton.bones[bi] ? o.skeleton.bones[bi].name : ("#" + bi); cnt[nm] = (cnt[nm] || 0) + 1; }
          }
        }
        out.push({ mesh: o.name || "(unnamed)", bones: Object.keys(cnt).map(n => n + "×" + cnt[n]) });
      });
      return out;
    },
    /* 哪些蒙皮网格受了某根骨骼的影响（权重>0.05 的顶点数）。用来解释"拉伸手臂骨却把耳朵拉长"。 */
    __boneInfluence: name => {
      const b = resolveBone(name);
      if (!b || !modelRoot) return null;
      const out = [];
      modelRoot.traverse(o => {
        if (!o.isSkinnedMesh || !o.skeleton) return;
        const idx = o.skeleton.bones.indexOf(b);
        if (idx < 0) return;
        const si = o.geometry.getAttribute("skinIndex"), sw = o.geometry.getAttribute("skinWeight");
        if (!si || !sw) return;
        const ia = si.array, wa = sw.array, isz = si.itemSize || 4;
        let wsum = 0, n = 0;
        for (let i = 0; i < si.count; i++) {
          for (let c = 0; c < isz; c++) {
            if (ia[i * isz + c] === idx) { const w = wa[i * isz + c]; if (w > 0.05) { wsum += w; n++; } }
          }
        }
        if (n > 0) out.push({ mesh: o.name || "(unnamed)", verts: n, avgW: +(wsum / n).toFixed(3) });
      });
      return out;
    },

    /* 仅供测试：量「骨骼链末端实际位置」与「引擎给的关节目标位置」的误差。
     * 这是验证"跟得准不准"的**唯一绝对判据** ——
     * "有没有动""左右是否对称"这类相对判据，对"手脚到不了位"完全无感
     * （纯 aim 时代它们全绿，但孩子一看就说"不到位"）。
     * 返回 { 关节名: 误差(世界单位) }，越接近 0 越好。 */
    __ikError: () => {
      if (!modelRoot || !lastJoints) return null;
      const j = usable(lastJoints) ? lastJoints : IDLE_JOINTS;
      const sp = bodySpan(j);
      const out = {};
      // 骨骼起点 ≈ 上一段的末端：小腿骨骼的起点就是膝、脚骨骼的起点就是踝
      const probe = (boneName, jointKey) => {
        const b = resolveBone(boneName);
        if (!b) return;
        const tgt = rawWorld(j, jointKey, sp);
        if (!tgt) return;
        const tv = new THREE.Vector3().copy(tgt);   // rawWorld 用共享缓冲，先拷走
        b.updateMatrixWorld(true);
        const p = new THREE.Vector3(); b.getWorldPosition(p);
        out[jointKey] = +p.distanceTo(tv).toFixed(4);
      };
      probe("RightFoot", "ankleL"); probe("LeftFoot", "ankleR");
      probe("RightHand", "wristL"); probe("LeftHand", "wristR");
      probe("RightLowerLeg", "kneeL"); probe("LeftLowerLeg", "kneeR");
      probe("RightLowerArm", "elbowL"); probe("LeftLowerArm", "elbowR");
      return out;
    },
    __ikOn: () => USE_IK,
    __layoutFor: h => layoutFor(h),
    __layout: () => ({ H: layout.H, footY: layout.footY, avail: layout.avail, top: layout.footY + layout.H }),
    __idleJoints: () => JSON.parse(JSON.stringify(IDLE_JOINTS)),

    /* 兼容老接口 debug()。老版本用"骨段 mesh 列表"表示骨架，新模型是骨骼层级，
     * 但字段名保留（links/points/parts）以免既有测试与排查脚本集体报错 ——
     * 这类"推翻兼容接口"的代价是会让别人以为是产品坏了，值不值要单独判断。
     * 这里的语义映射：links = 驱动表里每根骨骼及其实测长度；points = 骨骼名清单。 */
    debug: () => {
      const worldPos = b => {
        b.updateMatrixWorld(true);
        return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
      };
      const links = Object.keys(BONE_SEG).map(name => {
        const b = resolveBone(name);
        if (!b) return { name, visible: false, length: 0, resolved: false };
        const kid = (b.children || []).find(c => c.isBone);
        // 叶子骨骼（如 *Hand / *Toes）没有子骨骼，就量"父→自身"这一段，
        // 否则长度恒为 0，会被"长度合法"的断言当成异常。
        const other = kid || (b.parent && b.parent.isBone ? b.parent : null);
        const length = other ? worldPos(b).distanceTo(worldPos(other)) : 0;
        return { name, visible: true, length, resolved: true, actualName: b.name };
      });
      return {
        ready: info.ready, failed: info.failed, usingFallback: !!fallbackGroup,
        links, points: Object.keys(bones),
        parts: { tailSegments: TAIL_BONES.length, hasModel: !!modelRoot, skinnedMeshes: info.skinnedCount },
        boneCount: info.boneCount, skinnedCount: info.skinnedCount,
        // 名字解析结果：BONE_SEG 里哪些条目需要靠别名才找得到（Head 就是这个坑）
        aliased: Object.keys(BONE_SEG).filter(n => boneAlias[n]).map(n => n + "→" + boneAlias[n].name),
        unresolved: Object.keys(BONE_SEG).filter(n => !resolveBone(n))
      };
    }
  };
})();
