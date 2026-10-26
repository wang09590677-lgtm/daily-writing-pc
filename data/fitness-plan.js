/* ------------------------------------------------------------------
 * 体能训练计划（室内为主，目标：提升 11 岁女孩的跑步成绩）
 *
 * ★ 2026-10-21 运动量重算（老李要求"科学安排运动量"）——
 *   定标依据（儿童青少年体能训练共识，非拍脑袋）：
 *
 *   ① 总量。WHO 建议 5-17 岁每天 ≥60 分钟中高强度活动。本计划是**结构化训练**，
 *      只占其中一部分，其余靠课间、走路、玩耍补足。按"每天 15~20 分钟结构化 +
 *      日常活动"定标，一周 6 练 ≈ 100 分钟。**不追量**：11 岁仍在发育，
 *      过量会抑制生长板、也会让孩子厌恶运动。
 *   ② 强度分布。高强度日（心肺/爆发）不与高强度日相邻，中间必须夹恢复日；
 *      周日完全休息。肌肉是在休息时变强的，这一点比多练一组更重要。
 *   ③ 力量动作次数。NSCA/ACSM 对儿童青少年力量训练的共识：自体重动作从
 *      **12~15 次/组**起步，重"动作模式"不重负荷。所以深蹲/臀桥/提踵都定在
 *      12~18 次，弓步定在每侧 10 次 —— 原 8 次/侧偏少，达不到刺激阈值。
 *   ④ 等长保持（静蹲/平板/单腿）。11 岁女孩的可行区间：靠墙静蹲 20~30 秒、
 *      平板 20~30 秒、单腿 20~30 秒/侧。**宁短勿长**：姿势一塌，练的就是腰
 *      不是核心，还不如短一点保持标准。原 30 秒静蹲偏长，下调到 25 秒。
 *   ⑤ 有氧/高频动作（高抬腿、小步跑、后踢腿、登山跑）。⚠️ 这一类现在的
 *      `reps` 是**左右两条腿之和**（探针 _probe-armfalse 证实：多信号
 *      ankleY_L/ankleY_R 各自独立累加），所以"20 次"实际只等于 10 个完整
 *      周期 ≈ 5 秒，远达不到有氧效果。已全部**翻倍到 40 次**（=20 轮≈20 秒），
 *      与自测项"30 秒高抬腿数两条腿一共多少次"的口径保持一致。
 *   ⑥ 跳绳。对 11 岁，单组 30 跳只等于 15~20 秒，量不够。上调到 50 跳/组
 *      （约 30 秒），3 组 150 跳，接近真实跳绳练习量。
 *   ⑦ 波比跳。高强度复合动作，6~8 次/组即可；原组间休息 45 秒过长，
 *      把强度稀释了，降到 35 秒。
 *
 * 设计依据：
 *   8-12 岁是儿童协调与速度素质的敏感期，训练应以**动作质量、动作频率、
 *   协调性**为主，不做大负荷力量、不做长时间高强度无氧、不做大量跳深。
 *   跑步成绩 ≈ 心肺耐力 × 步频 × 步幅（腿力+柔韧）× 核心稳定 × 踝关节刚性。
 *   因此本计划把一周拆成 6 个主题日，把上述素质分开练、隔天轮换。
 *
 * 单次训练结构固定为：热身（约 5 分钟）→ 主训练（15-20 分钟）→ 放松（约 5 分钟）。
 * 每个"动作块"是一个可勾选单元，孩子做完一块打一个勾。
 * 完成度按块加权：热身每块 1 分、主训练每块 3 分、放松每块 1 分。
 *
 * 周期：8 周 4 阶段，按孩子第一次开始训练的日期自动推进。
 *
 * 注意：整个文件用 IIFE 包起来。浏览器里多个经典 <script> 共享同一个全局
 * 词法作用域，如果这里用顶层 const，会和 app.js 里同名的 const 撞车报
 * "Identifier has already been declared"。
 * ------------------------------------------------------------------ */

(function () {

/* 每个动作除了"怎么做"，还带一份**体感参数**（motion），给摄像头体感分析用。
 *
 * motion.mode：
 *   "rep"  周期性动作 —— 靠峰值检测数次数（开合跳、高抬腿、深蹲、波比跳…）
 *   "hold" 静态保持动作 —— 测保持时长与身体稳定性（靠墙静蹲、平板支撑、单腿站立）
 *   "none" 帧差测不准的动作 —— 慢速拉伸、呼吸放松，不参与体感评分（不夸大能力）
 *
 * motion.signal：这么多信号里，哪个最能反映"一次完整的动作"
 *   energy      整幅画面的运动量（默认，最稳）
 *   lowerEnergy 画面下半部分的运动量（抬腿、踏步、登山跑这类靠腿的动作）
 *   width       运动区域的横向宽度（开合跳、侧向跳靠"张开"来计次）
 *   centroidY   运动区域重心的纵向位置（深蹲、弓步、提踵靠"上下起伏"来计次）
 *
 * motion.tempoBand：[慢, 快] 次/分钟。落在这个区间里节奏分满分。
 * motion.minRepGap：两次计数之间至少隔多少秒，防止一个动作被数成两次。
 * motion.expectedAmplitude：该信号"做满幅度"时典型的波动范围。
 *   ⚠️ 它同时承担**两个职责**，改这个值会同时影响两件事：
 *     ① 幅度评分 —— amplitude() 用"实测波动范围 / expectedAmplitude"折算幅度分；
 *     ② 计次灵敏度 —— detectReps() 的**绝对幅度闸门**以它为基准：实测峰峰值
 *        达不到 expectedAmplitude × 0.5 × 人形尺度时，这一拍**不计次**。
 *        这正是"动作正确完成一次才计一次"的实现方式（防止摄像头噪声被数成动作）。
 *   所以：调大它 = 幅度分更难拿满 + 计次更严（动作做小了不数）；
 *         调小它 = 更容易拿满分 + 更容易被噪声/微动触发计数。两件事必须一起权衡。
 *   该值随信号量纲变化（width 是画面宽度比例，centroidY 是画面高度比例），
 *   不是"角度"或"像素"，别按绝对物理量来估。
 * motion.holdSeconds：hold 模式的默认目标保持时长（秒）。
 */
const FITNESS_EX = {
  /* ---- 热身 ---- */
  jointCircle: {
    name: "关节绕环", emoji: "🔄", unit: "秒",
    how: "脖子、肩膀、手腕、脚踝依次慢慢绕圈，每个关节都转到。",
    // 绕环幅度小、速度慢，帧差几乎看不出来，硬测会误判成"没在做"
    motion: { mode: "none" }
  },
  marchInPlace: {
    name: "原地踏步", emoji: "🚶", unit: "次",
    how: "抬膝到腰高，手臂跟着摆，先把身体热起来。",
    // ★ 2026-10-21：信号从 bottomL/bottomR 换成 ankleY_L/ankleY_R。
    // 根因：bottomL/bottomR 取"该半侧所有可见关键点最低者"，含手腕 ——
    // 孩子站着只抬手臂就被计成踏步（老李真机反馈）。踝只来自脚踝，
    // 腿不动则踝绝对不动。抬左腿→ankleY_L 上冲、抬右腿→ankleY_R 上冲。
    motion: { mode: "rep", signal: "ankleY_L", signals: ["ankleY_L", "ankleY_R"], tempoBand: [60, 160], minRepGap: 0.3, expectedAmplitude: 0.15 }
  },
  dynamicKick: {
    name: "动态踢腿", emoji: "🦵", unit: "次/侧",
    how: "扶墙站稳，腿向前踢到最高，慢慢放下，不要甩。",
    // 单侧踢腿：只认本侧踝的峰（同上，不用含手腕的 bottomL/bottomR）
    motion: { mode: "rep", signal: "ankleY_L", signals: ["ankleY_L", "ankleY_R"], tempoBand: [20, 60], minRepGap: 0.8, expectedAmplitude: 0.18 }
  },
  halfSquatWarm: {
    name: "半蹲热身", emoji: "🪑", unit: "次",
    how: "只蹲一半，动作慢，让膝盖和髋关节先活动开。",
    motion: { mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: 0.9, expectedAmplitude: 0.06 }
  },

  /* ---- 心肺 ---- */
  jumpingJacks: {
    name: "开合跳", emoji: "⭐", unit: "次",
    how: "双脚开合，手臂上举过头；落地要轻，用前脚掌缓冲。",
    motion: { mode: "rep", signal: "width", tempoBand: [40, 90], minRepGap: 0.45, expectedAmplitude: 0.18 }
  },
  fastFeet: {
    name: "原地小步跑", emoji: "👟", unit: "次",
    how: "步幅很小、频率很快，前脚掌着地，手臂快速前后摆。",
    // 交替峰计次，tempoBand 放宽到 280 以覆盖高频。
    // ★ 信号用踝 y：小步跑时手臂摆得最快，用含手腕的 bottomL/bottomR
    // 会被手臂带着乱数。
    motion: { mode: "rep", signal: "ankleY_L", signals: ["ankleY_L", "ankleY_R"], tempoBand: [120, 280], minRepGap: 0.2, expectedAmplitude: 0.08 }
  },
  highKnees: {
    name: "原地高抬腿跑", emoji: "🦿", unit: "次",
    how: "原地快速交替抬膝，身体保持直立、自然摆臂；膝盖抬至舒适高度，不后仰。",
    // ★ 交替峰计次，信号只用踝 y（根因同 marchInPlace：bottomL/bottomR 含手腕，
    // 老李实测"抬手臂就数高抬腿"）。
    motion: { mode: "rep", signal: "ankleY_L", signals: ["ankleY_L", "ankleY_R"], tempoBand: [60, 180], minRepGap: 0.25, expectedAmplitude: 0.15 }
  },
  buttKicks: {
    name: "后踢腿跑", emoji: "🏃", unit: "次",
    how: "脚跟向后踢到臀部，膝盖朝下，上身不要前趴。",
    // 交替峰计次（后踢时同侧踝上升）；信号只用踝 y，理由同上
    motion: { mode: "rep", signal: "ankleY_L", signals: ["ankleY_L", "ankleY_R"], tempoBand: [60, 200], minRepGap: 0.25, expectedAmplitude: 0.12 }
  },
  jumpRope: {
    name: "跳绳", emoji: "🪢", unit: "次",
    how: "手腕摇绳（不是整条手臂），前脚掌轻轻跳，膝盖微屈。",
    /* ★★ 2026-10-21：signal 从 height 换成 centroidY。
     * 根因：height 是**包围盒高度**（maxY-minY，统计所有可见关键点，
     * 含手腕）。孩子站着只把手臂抬高放下，包围盒顶边就跟着升降，
     * height 出现周期性起伏 → 被当成"身体在弹跳"→ 数成跳绳
     * （老李真机反馈："手臂抬高放下会触发跳绳、高抬腿的计数"）。
     * centroidY = **双髋中点的 y**，只由躯干位置决定，手臂再怎么动都不影响；
     * 每跳一次髋就起伏一次，一拍 = 一次跳跃。
     * 幅度从 0.05 降到 0.04：跳绳是"前脚掌轻轻跳"，髋的起伏本来就比
     * 开合跳/深蹲小，门限跟着放一点，否则按 0.05 会大面积漏数。 */
    motion: { mode: "rep", signal: "centroidY", tempoBand: [60, 120], minRepGap: 0.3, expectedAmplitude: 0.04 }
  },

  /* ---- 腿力 ---- */
  wallSit: {
    name: "靠墙静蹲", emoji: "🧱", unit: "秒",
    how: "背贴墙，大腿与地面平行，膝盖不超过脚尖，坚持住不要滑下来。",
    /* ★ 2026-10-21：回到读秒，但加 holdCheck 姿态判据（老李："还是应该按读秒
     * 计算，不过要体感到正确运动才能计时，感应不到正确动作不可以计时"）。
     * wallSit 的判据 = **大腿接近水平**（|膝y-髋y| < 0.10）。
     * 站着或只弯一点点 → 不计秒；蹲到大腿水平 → 才开始计秒。 */
    motion: { mode: "hold", signal: "centroidY", holdSeconds: 25, holdCheck: "wallSit" }
  },
  squat: {
    name: "徒手深蹲", emoji: "🪑", unit: "次",
    how: "屁股向后坐，膝盖朝脚尖方向，起身时夹一下屁股。",
    motion: { mode: "rep", signal: "height", tempoBand: [15, 45], minRepGap: 0.9, expectedAmplitude: 0.12 }
  },
  lunge: {
    name: "弓步蹲", emoji: "🦵", unit: "次/侧",
    how: "前后脚分开一大步，后膝降到快碰地面，上身保持直立。",
    motion: { mode: "rep", signal: "height", tempoBand: [12, 36], minRepGap: 1.1, expectedAmplitude: 0.12 }
  },
  calfRaise: {
    name: "提踵", emoji: "🦶", unit: "次",
    how: "踮到最高点停 1 秒，再慢慢落下。这是跑步最关键的踝关节力量。",
    motion: { mode: "rep", signal: "height", tempoBand: [20, 55], minRepGap: 0.7, expectedAmplitude: 0.045 }
  },
  gluteBridge: {
    name: "臀桥", emoji: "🌉", unit: "次",
    how: "躺平屈膝，用臀部把髋顶起来，顶点停 1 秒再落下。",
    motion: { mode: "rep", signal: "height", tempoBand: [15, 40], minRepGap: 1.0, expectedAmplitude: 0.08 }
  },
  stepUp: {
    name: "台阶踏步", emoji: "🪜", unit: "次/侧",
    how: "踩上稳固的矮凳或楼梯第一级，全脚掌踩实再下来。",
    motion: { mode: "rep", signal: "centroidY", tempoBand: [15, 40], minRepGap: 1.1, expectedAmplitude: 0.09 }
  },

  /* ---- 核心 ---- */
  plank: {
    name: "平板支撑", emoji: "🧘", unit: "秒",
    how: "肘撑地，身体从头到脚一条直线，不塌腰、不撅屁股。",
    /* ★ 读秒 + 姿态判据（老李同上要求）。
     * plank 的判据 = **躯干接近水平**（|Δy|/|Δx| < 0.55）且**肩-髋-踝近共线**
     * （2D 内角 >150°，即不塌腰不撅屁股）。
     * 站着、跪着、半跪都过不了第一条；趴着但塌腰/撅屁股过不了第二条。 */
    motion: { mode: "hold", signal: "centroidY", holdSeconds: 25, holdCheck: "plank" }
  },
  abWheel: {
    name: "跪姿健腹轮", emoji: "🛞", unit: "次",
    how: "双膝跪在防滑软垫上，双手握住健腹轮缓慢向前推一小段，收紧腹部、保持腰背平直后缓慢拉回；不要强求推到地面，腰痛立刻停，需家长看护。",
    motion: { mode: "rep", signal: "centroidY", tempoBand: [8, 25], minRepGap: 1.2, expectedAmplitude: 0.10 }
  },
  mountainClimber: {
    name: "登山跑", emoji: "⛰️", unit: "次",
    how: "俯撑姿势，两腿交替快速收膝，屁股不要翘高。",
    // 俯撑时交替收膝 → 同侧踝前后/上下动；信号只用踝 y（理由同 marchInPlace）
    motion: { mode: "rep", signal: "ankleY_L", signals: ["ankleY_L", "ankleY_R"], tempoBand: [50, 180], minRepGap: 0.3, expectedAmplitude: 0.08 }
  },
  deadBug: {
    name: "死虫式", emoji: "🐞", unit: "次/侧",
    how: "仰卧，对侧手脚同时慢慢伸展，腰要一直贴住地面。",
    motion: { mode: "rep", signal: "height", tempoBand: [10, 30], minRepGap: 1.2, expectedAmplitude: 0.06 }
  },

  /* ---- 爆发 / 协调 ---- */
  burpee: {
    name: "波比跳", emoji: "💥", unit: "次",
    how: "下蹲手撑地→两脚向后跳→收回→站起向上跳。初学可以不做俯卧撑。",
    motion: { mode: "rep", signal: "height", tempoBand: [12, 35], minRepGap: 1.4, expectedAmplitude: 0.16 }
  },
  lateralHop: {
    name: "侧向跳", emoji: "↔️", unit: "次",
    how: "双脚并拢左右跳，落地轻，膝盖微屈缓冲。",
    motion: { mode: "rep", signal: "width", tempoBand: [40, 100], minRepGap: 0.45, expectedAmplitude: 0.18 }
  },
  sideShuffle: {
    name: "侧滑步", emoji: "🔀", unit: "次",
    how: "半蹲姿势，左右横向滑步，练跑步的侧向稳定。",
    // burst→rep：用 centroidX 过零计次（左移→右移算 1 次）
    motion: { mode: "rep", signal: "centroidX", tempoBand: [30, 120], minRepGap: 0.4, expectedAmplitude: 0.12 }
  },

  /* ---- 恢复 / 平衡 ---- */
  singleLegBalance: {
    name: "单腿站立", emoji: "🦩", unit: "秒/侧",
    how: "单脚站稳，另一只脚抬起来，站得稳了可以闭上眼睛。",
    /* ★ 读秒 + 姿态判据（老李同上要求）。
     * singleLeg 的判据 = **两踝高度差 > 0.08**（一只脚真的离地了）。
     * 双脚都踩地 → 不计秒；抬起一只脚 → 才开始计秒。
     * unit 是"秒/侧"，motionGoalFor 会把秒数×2（左右各做一遍）。 */
    motion: { mode: "hold", signal: "centroidY", holdSeconds: 20, holdCheck: "singleLeg" }
  },
  // 下面这些是"慢慢拉开"的静态拉伸，本来就不该有明显运动量，
  // 用帧差去测只会得到噪声，所以统一标 none，不参与体感评分。
  sitReach: {
    name: "坐姿体前屈", emoji: "🧘‍♀️", unit: "秒",
    how: "坐直，双腿伸直，慢慢向前够，够到哪算哪，不要弹振。",
    motion: { mode: "none" }
  },
  calfStretch: {
    name: "小腿拉伸", emoji: "🦵", unit: "秒/侧",
    how: "手扶墙，后腿伸直脚跟踩地，感觉小腿后面被拉开。",
    motion: { mode: "none" }
  },
  quadStretch: {
    name: "大腿前侧拉伸", emoji: "🦿", unit: "秒/侧",
    how: "单手扶墙，另一只手抓住脚踝往臀部靠，膝盖并拢。",
    motion: { mode: "none" }
  },
  hamStretch: {
    name: "大腿后侧拉伸", emoji: "🦵", unit: "秒/侧",
    how: "一腿伸直脚跟点地，上身慢慢前倾，感觉大腿后面拉开。",
    motion: { mode: "none" }
  },
  hipStretch: {
    name: "髋部拉伸", emoji: "🧎", unit: "秒/侧",
    how: "弓步姿势下压髋部，后腿尽量伸直，感觉大腿根被拉开。",
    motion: { mode: "none" }
  },
  backStretch: {
    name: "腰背拉伸", emoji: "🙆", unit: "秒",
    how: "双手上举向一侧慢慢侧弯，两边都要做。",
    motion: { mode: "none" }
  },
  breathe: {
    name: "深呼吸放松", emoji: "🌬️", unit: "秒",
    how: "鼻子吸气 4 秒、嘴巴呼气 6 秒，把心跳慢慢降下来。",
    motion: { mode: "none" }
  },
  fullStretch: {
    name: "全身拉伸", emoji: "🧘", unit: "秒",
    how: "从上到下把肩、背、腿都拉一遍，每个位置慢慢来。",
    motion: { mode: "none" }
  }
};

/* 动作块写法：
 *   [动作id, 组数, 目标数, 组间休息秒]      —— 常规组次
 *   { circuit: 轮数, rest: 轮间休息, items: [[动作id, 目标数], ...] } —— 循环
 */
const FITNESS_PLAN = [
  {
    id: "sun",
    weekday: 0,
    name: "休息日",
    icon: "🌤️",
    focus: "恢复",
    rest: true,
    why: "肌肉是在休息的时候变强的。今天什么都不用练，去户外随便走走、晒晒太阳就好。",
    warmup: [],
    main: [],
    cooldown: []
  },
  {
    id: "mon",
    weekday: 1,
    name: "心肺耐力日",
    icon: "❤️",
    focus: "有氧基础",
    why: "跑步跑不远，多半是心肺跟不上。今天用连续的中低强度动作，把呼吸和心跳练稳，这是 800 米不喘的基础。",
    warmup: [["jointCircle", 1, 30], ["marchInPlace", 1, 60], ["dynamicKick", 1, 10]],
    /* 跳绳 30→50 跳/组（约 30 秒，才够有氧刺激）；波比跳休息 45→35 秒
     * （原 45 秒把高强度稀释了）。开合跳 30 次/组 ≈30 秒，保持不变。 */
    main: [["jumpingJacks", 3, 30, 30], ["highKnees", 3, 40, 40], ["fastFeet", 3, 40, 30], ["jumpRope", 3, 50, 40], ["burpee", 3, 6, 35]],
    cooldown: [["calfStretch", 1, 30], ["quadStretch", 1, 30], ["breathe", 1, 60]]
  },
  {
    id: "tue",
    weekday: 2,
    name: "腿部力量日",
    icon: "🦵",
    focus: "腿力 · 步幅",
    why: "步幅靠腿蹬得动。今天练大腿、臀部和小腿，跑步时每一步都能推得更远。",
    warmup: [["jointCircle", 1, 30], ["marchInPlace", 1, 60], ["halfSquatWarm", 1, 10]],
    /* 静蹲 30→25 秒（11 岁女孩 20~30 秒是可行区间，宁短勿长，姿势一塌就白练）；
     * 弓步 8→10 次/侧（原 8 次低于儿童自体重训练 12~15 次的刺激阈值下限）；
     * 提踵 15→18 次（踝耐力需要更多重复）；深蹲 12 次、臀桥 12 次保持
     * （NSCA 共识：儿童自体重力量从 12~15 次/组起步）。 */
    main: [["wallSit", 3, 25, 40], ["squat", 3, 12, 40], ["lunge", 2, 10, 40], ["calfRaise", 3, 18, 30], ["gluteBridge", 3, 12, 30]],
    cooldown: [["quadStretch", 1, 30], ["hamStretch", 1, 30], ["hipStretch", 1, 30]]
  },
  {
    id: "wed",
    weekday: 3,
    name: "恢复活动日",
    icon: "🌿",
    focus: "柔韧 · 平衡",
    rest: false,
    light: true,
    why: "昨天练完腿会有点酸，今天只做轻的：柔韧和平衡。脚踝稳了，跑步才不容易崴脚。",
    warmup: [["marchInPlace", 1, 60]],
    /* 死虫式 8→10 次/侧（儿童核心控制 10~12 次/侧才有刺激）；
     * 单腿站立 20 秒/侧保持不变（11 岁女孩 20~30 秒/侧是合适区间）；
     * 侧滑步 20 次保持不变。恢复日总量刻意压在 12 分钟以内。 */
    main: [["singleLegBalance", 3, 20, 20], ["deadBug", 2, 10, 30], ["sitReach", 3, 30, 20], ["sideShuffle", 2, 20, 30]],
    cooldown: [["fullStretch", 1, 180]]
  },
  {
    id: "thu",
    weekday: 4,
    name: "速度爆发日",
    icon: "⚡",
    focus: "步频 · 爆发",
    why: "今天在充分热身后练步频与协调：原地高抬腿跑、开合跳等快动作分组进行；最后的平板支撑与跪姿健腹轮改为慢速、控制动作，不追求速度。",
    warmup: [["jointCircle", 1, 30], ["marchInPlace", 1, 60], ["dynamicKick", 1, 10]],
    /* ⚠️ 交替类动作的次数全部翻倍（20→40）：reps 现在是**左右两腿之和**，
     * 原 20 次只等于 10 个周期 ≈5 秒，达不到步频训练效果。
     * 平板支撑 20→15 秒：周四已有高抬腿/跳绳/后踢腿三项高强度，
     * 核心负担叠加，且次日周五还有 3×25 秒平板，周四要减压（老李原话：
     * "平板支撑这种还是应该按读秒计算"——读秒的前提是姿势标准，短一点更稳）。 */
    main: [["jumpingJacks", 2, 20, 40], ["highKnees", 3, 40, 45], ["fastFeet", 3, 40, 45], ["jumpRope", 3, 50, 45], ["buttKicks", 2, 40, 30], ["plank", 2, 15, 40], ["abWheel", 2, 4, 60]],
    cooldown: [["calfStretch", 1, 30], ["hamStretch", 1, 30]]
  },
  {
    id: "fri",
    weekday: 5,
    name: "核心稳定日",
    icon: "🎯",
    focus: "核心 · 稳定",
    why: "跑到后面身体开始晃、手乱摆，就是核心不够。核心稳住了，手臂和腿的力量才不浪费。",
    warmup: [["jointCircle", 1, 30], ["marchInPlace", 1, 60]],
    /* 登山跑 20→40 次（左右之和，同高抬腿的理由）；
     * 平板 3×25 秒保持不变（核心日的重头戏，25 秒在 11 岁女孩可行区间内）；
     * 死虫式 10 次/侧、臀桥 15 次保持不变（已在刺激阈值之上）。 */
    main: [["plank", 3, 25, 40], ["abWheel", 2, 4, 60], ["mountainClimber", 3, 40, 40], ["deadBug", 3, 10, 30], ["gluteBridge", 3, 15, 30]],
    cooldown: [["hipStretch", 1, 30], ["backStretch", 1, 30]]
  },
  {
    id: "sat",
    weekday: 6,
    name: "综合挑战日",
    icon: "🏆",
    focus: "综合 · 趣味",
    why: "把这一周学到的动作串成一个循环，像闯关一样连做 3 轮。可以拉上爸爸妈妈一起做，比一比谁先做完。",
    warmup: [["jointCircle", 1, 30], ["marchInPlace", 1, 60], ["dynamicKick", 1, 10]],
    main: [
      /* 循环里同样处理：跳绳 30→50 跳、静蹲 30→25 秒、平板 20→25 秒
       * （周六是综合挑战，核心可以比周四多给一点）。 */
      { circuit: 3, rest: 90, items: [["jumpingJacks", 30], ["squat", 12], ["jumpRope", 50], ["wallSit", 25], ["plank", 25]] },
      ["abWheel", 2, 4, 60]
    ],
    cooldown: [["fullStretch", 1, 180], ["breathe", 1, 60]]
  }
];

/* 8 周 4 阶段：按训练天数自动推进，目标数按比例放大 */
const FITNESS_PHASES = [
  { id: "adapt", name: "适应期", from: 1, to: 2, scale: 1.0, extraSets: 0, note: "先把每个动作做对，不追求数量，做得慢一点没关系。" },
  { id: "build", name: "积累期", from: 3, to: 4, scale: 1.15, extraSets: 0, note: "动作熟练了，时间稍微加长一点，注意呼吸不要憋气。" },
  { id: "power", name: "强化期", from: 5, to: 6, scale: 1.3, extraSets: 1, note: "每个动作多加一组，做完会有点累，这是正常的。" },
  { id: "peak", name: "巩固测试期", from: 7, to: 8, scale: 1.4, extraSets: 1, note: "保持强度，每周末做一次自测，看看自己进步了多少。" }
];

/* 自测项目：用来量化“跑步能力有没有变强”。成绩存在本机，只跟自己比。 */
const FITNESS_TESTS = [
  { id: "highKnees30", name: "30 秒高抬腿", unit: "次", hint: "数一数 30 秒内两条腿一共抬了多少次，直接反映步频。" },
  { id: "jumpRope60", name: "1 分钟跳绳", unit: "次", hint: "记录 1 分钟跳了多少个，练的是心肺和脚踝弹性。" },
  { id: "wallSitHold", name: "靠墙静蹲保持", unit: "秒", hint: "蹲到坚持不住为止，练的是腿部耐力。" },
  { id: "plankHold", name: "平板支撑保持", unit: "秒", hint: "撑到姿势变形为止，练的是核心稳定。" }
];

/* 体感跟练的通用说明文案（界面上直接显示，避免和动作库混在一起） */
const FITNESS_MOTION_GUIDE = {
  canDo: [
    "人形估计：深度流可用时显示深度剪影，彩色回退时显示彩色画面的轮廓估计。没有做深度与彩色配准，也没有使用精确姿态模型；肢体贴近躯干时手肘会隐藏。",
    "次数：深蹲、弓步、提踵、臀桥、台阶、波比、开合跳、侧向跳、跳绳都能一次次数出来。",
    "★ 高抬腿、小步跑、后踢腿、登山跑、原地踏步这类交替抬腿动作，用**左右脚踝**分别计次，两条腿的次数相加。所以「40 次」= 左右各 20 次 = 20 个完整周期。只抬手臂不会计数——信号只看脚踝，不看手。",
    "节奏：算出每分钟做了多少次，太快太慢都会提醒。",
    "幅度：动作做开没做开，只看相对幅度，不测具体角度。",
    "对称：左右两边用力是不是均衡，一侧偷懒会被看出来。",
    "保持：靠墙静蹲、平板支撑、单腿站立这类测保持了多少秒、身体稳不稳。**只有姿势做对了才计秒**——平板要趴平不塌腰、静蹲要蹲到大腿水平、单腿要真的抬起一只脚；站着不动是不计秒的。"
  ],
  cannotDo: [
    "关节角度与手臂交叠：膝盖有没有内扣、肘腕的位置、蹲得够不够深，需要真正的姿态模型或经授权的骨骼追踪 SDK。这里是轮廓估计，不是解剖学关节。",
    "精确位置：手抬到多高、脚迈出多远，只能看大概。",
    "次数会有 ±1~2 次的误差：摄像头只看到二维画面，人离得远近、衣服颜色深浅都会影响判断。动作分用来督促孩子把动作做到位，不适合当成精确成绩。",
    "所以动作分只反映「做了多少次、节奏对不对、幅度够不够、稳不稳」，不替代教练的眼睛。"
  ],
  setup: [
    "把电脑放在椅子上或桌面上，屏幕大概在腰到胸口的高度。",
    "站在约 2~3 米处，让头到脚都在深度剪影内，左右各留空间；深度视角与彩色视角并不完全相同。",
    "背后尽量是白墙或空地面，画面里不要有走来走去的人或飘动的窗帘。",
    "光线亮一点，人不要逆着窗户站，不然会变成一团黑影。",
    "穿贴身的运动服效果最好，太宽松的衣服会被当成一直在动。"
  ]
};

if (typeof window !== "undefined") {
  window.FITNESS_EX = FITNESS_EX;
  window.FITNESS_PLAN = FITNESS_PLAN;
  window.FITNESS_PHASES = FITNESS_PHASES;
  window.FITNESS_TESTS = FITNESS_TESTS;
  window.FITNESS_MOTION_GUIDE = FITNESS_MOTION_GUIDE;
}

})();
