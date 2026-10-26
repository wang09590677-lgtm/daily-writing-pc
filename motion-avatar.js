// 3D 体感跟练角色：加载 `体能训练动作演示/体感跟练模型.glb`（Mixamo 标准人形，65 骨骼），
// 用引擎给出的关节位置**逐骨骼瞄准（aim-based FK）+ 两段 IK**驱动，让角色跟着孩子做动作。
//
// ---- 模型沿革 ----
// 程序化拼几何 → assets/models/cat_fitness_avatar.glb（38 骨猫）→ **本文件当前的 Mixamo 人形**。
// 2026-10-09 用户要求："用 体能训练动作演示/体感跟练模型.glb 替换人形猫咪；这是一个人形模型，
// 务必要做到动作与感应出的玩家一致"。换模型时下面几件事真踩过：
//
//   0. **换成外部资源后，先把实际骨名打印一遍**（踩坑第 3 条，已经栽过两次）：
//      GLTFLoader 会**洗掉骨名里的冒号** —— GLB 里叫 `mixamorig:Neck`，到 three 里变成
//      `mixamorigNeck`。所以本文件所有骨名走 `resolveBone()` 的**别名表**（见 onModelLoaded
//      里的 boneAlias），BONE_SEG 里只写可读的 `RightArm` 这类短名。
//      工具：`build/_probe-glb-structure.js` / `_probe-glb-deep.js` / `_probe-human-rig.{html,js}`。
//
//   1. **模型面朝 +Z（面朝镜头）、自身左侧在 +X** —— 与旧猫模型**完全同一套约定**，实测：
//      趾 z − 踝 z = +0.1999（脚趾朝 +Z）、左肩 x = +0.0457（左侧在 +X）。侧视图复核过。
//      而引擎的 `shoulderL` = **图像 x 较小侧 = 屏幕左侧**（相机在 +Z 看向原点，世界 -X 在屏幕左）。
//      ⇒ 引擎 L/R 与模型 L/R **交叉**：引擎 shoulderL ↔ 模型 `RightArm`。
//      对应关系写在 BONE_SEG 表里（键=模型骨骼名，值=引擎关节名），
//      别"顺手把名字对齐"，否则动作左右反。
//
//   2. **模型 rest 是 T-pose（双臂水平）**，不是自然站姿。
//      所以每帧必须**先把所有骨骼重置回 rest，再施加目标旋转**；否则旋转会累积，
//      几秒后拧成麻花。而"没识别到人"时也不能直接用 rest（那是"举手投降"），
//      要用 IDLE_JOINTS 摆自然站姿 —— 走的还是**同一条驱动路径**，
//      这样两种情况不会出现两套代码互相漂移。
//
//   3. **aim 依赖父级世界矩阵已更新**，必须**自顶向下**遍历（TOP_DOWN 在 onModelLoaded 里
//      DFS 排好），每改一根就 updateMatrixWorld，否则子骨骼永远慢一帧、动作发飘。
//
//   4. **three.min.js 里没有 GLTFLoader**（官方 r150 已移除 UMD 版），
//      所以 assets/vendor/GLTFLoader.js 是单独补的（r147 官方 UMD 版，
//      挂 THREE.GLTFLoader，与 r150 核心 API 兼容，已实测通过）。
//      加载走 fetch，在 file:// 下**依赖 start-app.bat 的
//      --allow-file-access-from-files**；没有这个 flag 会静默挂起 → 见 5。
//
//   5. **加载失败绝不能让屏幕空着**：异步加载最坏会挂到超时才放弃，
//      所以有 loadFailed 分支退回"程序化兜底人形"，保证孩子永远看得见东西；
//      加载过程中也先摆 IDLE 姿势而不是黑屏。
//
//   6. **两段 IK 的"弯角"曾经恒为 0（一行 clamp 参数写反）**。`solveTwoBoneIK` 里
//      原写 `Math.acos(clamp(-1, 1, cosA))`，而 clamp 的签名是 `clamp(a, lo, hi)` ——
//      这样写时 a=-1 恒小于 lo=1，**永远返回 1 → 弯角 A 恒为 0**，IK 从不弯肘/膝，
//      两段链永远伸得笔直指向目标：目标比臂展短时末端**冲过头**（猫的站姿腕误差 0.139
//      就是它），比腿长时停在最大伸展。改成 `clamp(cosA, -1, 1)` 后站姿腕误差 → 0。
//      **教训**：`__ikError()` 自称"唯一绝对判据"，但验收脚本从没调用过它 ——
//      所有相对判据（动没动 / 左右对称 / 在不在平面内）全绿也照样漏。
//      现在验收脚本里钉了它（绝对几何判据那一节），别删。
//
//   7. **尺寸/最低点一律"实测"，别照假设写死**（RAW_H / REST_LOWEST）。
//      旧猫模型这两个常量是手抄 GLB 数值的；换模型时手抄值很容易忘改、且**静默失效**
//      （动作只是"略微不对"，程序化断言全绿）。现在改为加载后用**真蒙皮顶点**量出
//      世界包围盒（`measureModelMetrics()`，`SkinnedMesh.applyBoneTransform` 逐顶点），
//      再解析出"身高"和"最低关节相对网格底部的高度"。常量只作兜底。
//      ⚠️ **别用 `Box3.setFromObject()` 量蒙皮网格** —— 它拿 `geometry.boundingBox × matrixWorld`，
//      而本模型 `Armature` 节点带 **scale 0.01**，量出来是 0.018（真值 1.81），差 100 倍。
//
//   8. **腿骨不需要拉伸**（旧猫模型需要，`LEG_STRETCH=1.18`）。Mixamo 人形是**标准真人比例**
//      （实测，相对身高：髋 0.536 / 膝 0.292 / 踝 0.048 / 肩 0.792 / 颈 0.826，
//      腿长(髋→踝) 0.488 —— 对真人 0.49）→ 站姿"髋→踝"目标不会超过腿的可达长度，
//      IK 不饱和。所以 `LEG_STRETCH = 1.0`。
//      ⚠️ 文件里曾写过"模型腿长占身高 36%"——那是**旧猫模型**的数，别拿它推理。
//      机制保留（拉伸 → 重算 rawBottom → 重排 layout 三件套仍在 onModelLoaded 里按序跑），
//      因为**换模型时它可能又需要**；只是当前取 1.0（此时 rawBottom 恒为 0，等价于关闭）。
//
//   9. **左右要镜像**（用户："左右动作需要镜像一下方便我观察"）。摄像头画面在
//      styles.css 里已经 `transform: scaleX(-1)`（照镜子），但本模块是**自己
//      新建画布挂到 document.body** 的，不在 `.motion-screen` 里、吃不到那条镜像 →
//      孩子抬右手时视频里手在右、角色却在左。修法是给**这块画布本身**加 CSS
//      `transform: scaleX(-1)`（见 init 里的注释）：视觉上等价于"绕模型 x=0 镜像"，
//      但**世界坐标一个都不变**，所以不牵动那些绝对几何断言，也绕开了"只翻 x 不交换
//      左右映射会让四肢交叉"的雷（第 1 条）。只镜像画布、不镜像容器（容器里还有文字与按钮）。
//
//  10. **模型自带 2 段动画 `jumpingjacks`(1.10s) / `jumprope`(2.60s)**，各 195 通道
//      （65 骨 × T/R/S，含 Hips 位移）。**不要拿来直接播** —— 那是"放录像"，
//      不满足"动作与感应出的玩家一致"。它们只作**参考真值**（可用来核对代码驱动的幅度）。
//      另外 GLB 里还有 2 个蒙皮网格 `Beta_Joints`/`Beta_Surface`、2 材质、无贴图。
//
//  11. ★ **IDLE_JOINTS 必须按模型自己的比例写**（它是"没识别到人"时的**唯一**姿势来源）。
//      旧表是照旧猫模型手写的：髋在归一化 0.545（离地只有身高的 46%），人形模型要 **0.482**
//      （离地 53.6%）。髋位低了 7 个身高的百分点 = 命令角色**微蹲**：换人形后立刻显形 ——
//      膝内角被 IK 压到 82°、小腿前倾 39°，脚掌继承小腿旋转变成**踮脚**，
//      脚趾掉到 footY 以下（截图里脚沉进底部控制栏）。新表由模型静止骨架反推：
//      `build/_probe-human-rest-norm.js`（纯 Node 读 GLB，**别在页面里读** ——
//      `animate()` 每帧都在驱动骨骼，读到的永远是被 IDLE 驱动后的结果，不是 rest）。
//      手臂链是**手写**的（模型 rest 是 T-pose，没有"下垂"可抄），用实测骨长从肩往下挂。
//
//  12. ★ **相机竖直视野是 1.8，不是 2**。`layoutFor()` 曾写成 `0.9 - (2 * UI_TOP_PX) / h`，
//      等于把视野当成 [-1,1] → 角色被放大 2/1.8 = 11.1% 并整体下移同样的比例，
//      **脚沉进底部控制栏 81px**，而程序化断言全绿（只有量像素才看得出来）。
//      现在像素↔世界只有一个来源 `WORLD_VIEW_H = HALF_VIEW_H * 2 = 1.8`，相机与布局共用。
//      核对：`screen_y = (0.9 − worldY) × innerHeight / 1.8`，拿 `__boneWorld()` 的值代进去
//      必须与截图里量到的像素对得上。
//
//  13. ★ **角色尺寸要按"脚底→指尖"定，不是"脚底→头顶"**。孩子做开合跳把手举过头顶时，
//      指尖比头顶还高 ~21%（实测：肩 1.4406 + 臂链 0.7530 = 2.1936，网格头顶 1.8092
//      ⇒ 相对身高 0.2125）。只按头顶定尺寸时**指尖会被顶部进度面板整个吃掉**：
//      实测 1280×800 指尖到 166px、面板下沿 197.6px —— 手直接消失
//      （截图 `build/shots/avatar-overhead.png`）。
//      这个缺陷被一条**假判据**掩盖了很久：构图那一节原本只喂"抬 30°"的张臂姿势，
//      它的最高点其实还是**头顶** —— "举手会不会被切"量到的是头，等于没验。
//      修法：`REACH_UP`（见常量处），尺寸按 `1/(1+REACH_UP)` 分配。验收在
//      `accept-human-glb.js` ⑧，**必须**用 `_avatar-fixtures.js` 的 `armsOverhead()`
//      去顶边界，别用 `armSpread()`。
//      教训（已进 PITFALLS）：**断言的"输入"到不了它声称要测的边界，这条断言就是假的** ——
//      和"恒真阈值"是同一类错误，光看 PASS 永远发现不了。
//
//  14. ★★ **上面那条第一版修完**还是错的 —— 量错了对象（第二次踩）。
//      第一版把"指尖"当成 `__poseSnapshot().RightHand`，但那是**腕**（骨 origin）：
//      `IK_TAILS` 与 `__ikError()` 都拿 `RightHand` 当手臂 IK 的**末端**，它就是腕。
//      于是 ⑧ 报的"指尖 226.6px"其实是腕，**真指尖还要再高约 45px**
//      （腕→中指尖 = 0.19129 模型单位 = 0.0874 归一化；而 IDLE/夹具里手长写的是
//      0.026 —— **差 236%**，两处都没有真值锚点，所以一起错了很久没人发现）。
//      ⇒ 第一版的 REACH_UP = 0.1306 仍然不够，真值 ≈ **0.2125**，手还是被面板吃掉 ~35px。
//      **教训**：① "改完就绿了"不等于改对了 —— 必须换一个**独立的度量对象**复算
//      （这里就是"腕 vs 指尖"，两条断言都叫"指尖"，但一个量的是腕）；
//      ② 同一个常量在多个文件各写一份、又都没有真值锚点，就会**一起错**。
//      现在的做法：
//        · `REACH_UP` **运行时从模型自身骨架实测**（`reachUpFromModel()`）；
//        · 指尖由 `fingertipName()` 在骨骼树里**发现**（取距腕最远的子骨），
//          不硬编码 Mixamo 指骨名（踩坑第 3 条：外部资源的名字不能照自己的假设写）；
//        · 夹具的 `hand` 段与 `IDLE_JOINTS.handL/handR` 都改成实测的 **0.0874**；
//        · ⑧ 改成量 `RightFingertip`（真·指尖骨），并补一条**与夹具无关**的
//          "模型最大伸展"解析判据。
//      真值来源：`node build/_probe-human-hand.js`。
//
//  15. ★★ **真人伸直、模型却是弯的**（第三次独立发现，本轮真机反馈）。
//      孩子原话：「我手臂与腿是直的时候他的动作是弯的，也就是说我双臂平举时他虽然也是
//      举起双臂，但是双臂都向下弯折；腿也是我直着站立，它腿向外弯」。
//      根因是**目标距离的用法**，不是 IK 公式本身：
//        · 旧写法 `d = |腕目标 − 模型肩|`。真人骨长比例 ≠ Mixamo 比例是**必然**的
//          （孩子不是标准身材），MediaPipe 的肘/膝关键点也还有零点几的偏移，
//          这些"比例差"全被塞进了 d 里，IK 只能**弯着肘/膝去够**；
//        · 更糟的是近伸直处 IK 把距离误差**开平方放大**：
//            A = acos(d/(2L))，d/(2L) = 1−ε ⇒ A ≈ √(2ε) ⇒ 关节弯曲角 ≈ 2√(2ε)
//          实测 ε = 0.0054（0.54%）⇒ 弯曲角 **11.9°**。
//        · 还有一处**预先就存在**的余量：d 被夹到 `L1+L2-1e-4`，这 1e-4 就够
//          造出 √(2×1e-4/0.277) ≈ 1.53° 的 A ⇒ **3.1°** 的弯曲（实测正是 3.1°）。
//      修法（`solveTwoBoneIK`）：
//        · **改由引擎自己的关节内角换算 d**，不再用"目标到模型根的世界距离" ——
//          角度是无量纲的，1:1 传给模型，**没有放大**；引擎说伸直模型就伸直，
//          引擎说弯 90° 模型就弯 90°；
//        · 减掉 `BEND_BIAS = 12°` 的**关键点系统偏差**（真值来自真实照片实测：
//          站姿四条链 2.7/8.8/11.6/3.5° —— 真人明明伸直，引擎自己就报出最多 11.6°，
//          因为 MediaPipe 的肘/膝关键点不落在关节连线上）。**减偏差而不是硬死区**：
//          硬死区在边界会跳变，孩子会看到腿突然弹一下；
//        · 上界余量 `-1e-4` 去掉（下界保留，那是防"完全折叠"的退化）。
//      验收：`build/_diag-straight.js`（几何严格伸直 ⇒ 模型必须 0°）+
//            `build/_probe-real-angle.js`（真实照片站姿 ⇒ 模型四肢 0.0~0.1°）。
//      教训：**"引擎给的绝对距离"里混着模型与真人的比例差，不能直接拿来驱动 IK**；
//            要传递的是**比例/角度**这类无量纲量。
//  16. ★★ **纯角度法的已知盲区：正面下蹲时脚会穿地**（不修，2D 传感器原理性看不到）。
//      引擎是**纯 2D**（`rawWorld()` 的 z 恒为 0）。真人正面下蹲时膝盖往**相机方向**走，
//      2D 投影里膝盖仍在"髋→踝"连线上 ⇒ 引擎报的内角 ≈180°（看着是直的），
//      只有"髋→踝投影变短"这一个线索。而纯角度法在"引擎说直"时直接给 d = L1+L2，
//      于是腿伸得笔直、**脚比目标低**（实测 `squat` 踝误差 0.0606、"只沉髋"变体 0.1101
//      —— 脚穿到地面线以下，肉眼可见）。沉入量 ≈ `Δy_hip × (1 − off/span)`。
//      ⚠️ "变短"单帧**分不开**两种原因：(a) 前后方向缩短（该弯）、
//         (b) 这孩子本来就比模型矮一截（**不该弯** —— 那正是第 15 条要修的 bug）。
//         **单帧无解。**
//      修过一版（`IK_REF`，见下面 `solveTwoBoneIK` 前那段留档），合成夹具上完全成功
//        （下蹲膝弯 60.3°、踝误差 0.0016；伸直姿势连"腿短 30% 的孩子"都保持 0.0°），
//        但**在真实数据上被否决**：关键点抖动 σ 最大 0.00521，而"取最大值"这个估计量
//        **天然偏高** ⇒ 把一张**站着不动、绝对伸直**的真实照片喂 11 次，肘R 弯曲
//        0.0~**24.0°**、膝R 每帧 ≈10°。合成全绿而真实 10~24° —— 正是 R2 要抓的假阳性。
//        更致命：**参考偏高会直接制造弯曲**，方向正好是本轮要修的那个 bug。
//      ⇒ 整段回退，只保留纯角度法；本条**作为已知、有界局限留档**，不再尝试近似。
//      ⚠️ 通用结论：`A = acos(d/(2L))` 对距离**开平方敏感** ⇒ **任何**基于位置距离的方法
//        都会放大抖动，抖动本身就能造出 ~12° 的幻影弯曲。旧"位置法"不是更好，
//        它只是**从来没问过这个问题**。
//      留档脚本：`build/_probe-squat-foreshorten.js`（盲区量化 + 回归护栏）、
//        `build/_probe-real-jitter.js`（抖动 ⇒ 平方根放大 ⇒ 幻影弯曲，否决证据）。
//        （当年还写过 `_probe-ikref.js` / `_dbg-ikref-frame.js` 查"哪个姿势污染参考"，
//          已随机制一起删除 —— 它们依赖的运行时钩子没了，留着只会崩。）
//  17. ★★ **"对前后方向（矢状面）动作无法识别"—— z 在链路上被丢三次**（本轮真机反馈）。
//      孩子原话：「跟练模型只是对正面平面的运动识别比较准，对前后方向动作无法识别，
//                比如我正对着摄像头跑步、双臂正向举起落下、正对镜头高抬腿」。
//      根因：MediaPipe 的 33 点**本来就有 `z`**，但
//        `pose-vision.makePt()` → 只返回 {x,y}（第 1 次丢）
//        `motion-engine.visionGeometry()` → `{x,y}`（第 2 次）
//        本文件 `rawWorld()` → `_v1.set(..., ..., 0)`（第 3 次，写死）
//      ⇒ 角色**没有"前后"这一维**。而且 2D 投影不是"缺信息"，是**给错几何**：
//        前平举 90° ⇒ 肩→手投影塌缩到真长的 7.8% ⇒ IK 的安全网推翻角度法 ⇒
//        手臂**折成一团（肘 168.5°）**；高抬腿 ⇒ 2D 膝内角报 180°（真值 100° 弯）；
//        正对镜头跑步 ⇒ 前后分量只剩 0.034（真值 0.707）。
//      **已做**：z 全链路打通（`POSE_DEPTH`，`?poseDepth=1` 门控；缺 z 补 0 ⇒ 与旧行为
//        逐字节一致）。几何验收 `build/_probe-sagittal.js`：喂 3D ⇒ **PASS**
//        （前平举上臂前伸 0.997 vs 真值 0.993；高抬腿 0.996 vs 0.985；肘弯 0.1°）。
//      ⚠️⚠️ **但 MediaPipe 自带的 z 被实测否决**（`build/_probe-z-quality.js`，平面插画上
//        物理真值 z≡0）：z 随高度**单调**（鼻 0.787 → 髋 0.00 → 踝 −0.20）、骨段
//        3D/2D 比值最大 **1.640**；喂给角色 ⇒ **站直的人躯干后仰 58.2°、肘弯 36.4°**、
//        末端误差反而变大。**它会重新制造第 15 条那个 bug。**
//        ⇒ 默认**关**。判据：**伪影量级 vs 待检信号量级，同量级就不能用**（同第 16 条 `IK_REF`）。
//      **已定案（10-10 老李选型）**：z 源走 **Astra 深度**，链路是
//        桥 `registered`（D2C 对齐标志）→ `depth-link.sampleMM()` →
//        `motion-engine.applyDepthZ()` → **`skeletonSnapshot()` 带 z**（★ 这里曾经漏拷 z，
//        而 app 驱动角色走的正是这份快照 ⇒ 整条链路在最后一跳被丢掉）→
//        本文件 `rawWorld()` 的 `useZ = POSE_DEPTH || j.__depthZ`（**生产走 `__depthZ`**，
//        不用再加 URL 参数；`POSE_DEPTH` 留给 `_probe-sagittal.js` 那种直接喂 3D 夹具的几何验收）。
//        未对齐时（`registered=false`，含老版本桥不发这个字段）**一律不给 z** ——
//        未对齐的深度按 (x,y) 采样取到的是**别的物理位置**的深度，给了比没有更糟。
//        验收：`build/_probe-depthz.js`（19/19，密闭：只换设备、不换模块）。
//  18. ★★ **相机改 3/4 斜视角**（10-10，老李第 2 条决定；配合第 17 条）。
//      为什么需要：**正对镜头的视角下，z 只表现为"变大变小"**，屏幕上几乎没有位移 ——
//      孩子做原地跑/前平举/高抬腿时自己看着"没动"。转过去 30° 后 z 才变成横向位移。
//      **转相机，不转模型**：`camera.position = (CAM_DIST·sinθ, 0, CAM_DIST·cosθ)` + `lookAt` 原点。
//      转模型会改掉所有骨骼的世界坐标 ⇒ `__poseSnapshot()` 上的绝对几何断言（尤其 4c 的
//      `|z| < 0.05`）、IK 目标、"世界 +z 朝相机"这套约定全都要跟着改，风险大得多。
//      ⚠️ **y 投影不受 Y 旋转影响** ⇒ 构图安全区（按屏幕 y）与 `screenY()` 换算**全部照旧**，
//        `avatar-portrait` / `accept-human-glb` ⑥⑧ 的断言**不用改**（已逐条核对）。
//        横向被压缩 `cos30° = 0.866`，⑥ 的横向阈值（居中 0.35~0.65、宽度 > 5%）只会更宽松。
//      ⚠️ **背景板必须跟着相机转**：原来写死 `bgMesh.position.z = -1`，相机一斜就斜着看它、
//        两侧露出 `scene.background` 的深色缝。改成"沿相机前向 `BG_DIST` 处 + `rotation.y = CAM_YAW`"。
//        验证：截图左右边缘列 **0/1560** 命中纯色。
//      ⚠️ 符号取 **正**（相机在模型自身左侧 +X 侧）⇒ `scaleX(-1)` 的镜像语义与原来一致
//        （模型自身左侧仍落屏幕左侧，见第 0/2 条）。**改符号要连带复核镜像**。
//      ★ 灵敏度实测（`build/_probe-yaw-view.js`）：**0.20 世界单位的 z ≈ 45px 横向位移**
//        （角色身高约 380px ⇒ 约 12%）。**别把位移方向写进断言**（符号由 yaw 正负 + 镜像共同
//        决定，属实现细节）；要保护的方向不变量只有一条：**镜像后模型自身右侧仍在屏幕右半**。
//      量测口：`__camera()` / `__project(x,y,z)`（借 three 自己的投影，别在测试里复刻公式）。
(function () {
  "use strict";

  /* ---------- 世界坐标约定 ----------
   * 相机是正交、从 +Z 看向原点，视口 y ∈ [-0.9, 0.9]、x ∈ [-0.9·aspect, 0.9·aspect]。
   * 模型要整体缩放、再上移让脚底落地。
   *
   * ⚠️ **角色必须落在"UI 安全区"里**，否则会被全屏层的两块 UI 压住：
   *   · 顶部 `.motion-avatar-progress`（次数/时间面板）——**孩子的核心信息**，不能被压
   *   · 底部 `.motion-avatar-controls`（含「结束并评分」）——按钮要能点，也不能被压
   *   实测（1440×900）：面板占 24~198px、控制栏占 809~876px。
   *   换算成世界坐标要**除以视野高度 1.8**（见 HALF_VIEW_H 处）：安全区是
   *   y ∈ [-0.718, 0.504]，高 1.222（⚠️ 曾经按"视野高 2"算成 [-0.90, 0.46]，
   *   那是错的，代价见 HALF_VIEW_H 的注释）。
   *   **这个区间随窗口高度变化**（窗口越矮，固定像素的 UI 占比越大、安全区越小），
   *   所以不能写死 MODEL_H / FOOT_Y —— 必须按当前窗口**动态算**（见 layoutFor）。
   *   写死过一次的代价：720p 下头顶超出安全区 0.13，头顶被面板切掉（截图抓到）。
   *
   * UI_TOP_PX    = 顶部面板下沿到窗口顶的距离（24 外边距 + 面板高）
   * UI_BOTTOM_PX = 底部控制栏上沿到窗口底的距离（24 外边距 + 控制栏高）
   * 这两个数由 CSS 的 `inset: 24px` + 内容高度决定，改样式时要跟着更新。
   * 核对办法：`build/_dbg-cat-layout.js`（名字里的 "cat" 是历史遗留）量出两块 UI 的实际像素边界，
   * 与这两个常量比。更硬的一条判据在 `build/accept-human-glb.js` 第 8 节：
   * 它**不信任何常量**，直接从 DOM 取安全区、把骨骼世界坐标投影成像素，两边对得上才算过。 */
  /* 模型原始身高与"最低关节离网格底多高"。
   * ⚠️ 这两个值**加载后会被实测覆盖**（见 measureModelMetrics）——常量只是兜底，
   *    免得在模型到货前用到未定义的值。手抄值（1.809 / 0）来自 Mixamo 人形 GLB 的
   *    静止包围盒：脚底 y=0、头顶 y=1.809；最低关节是 `Toe_End`（y=0）。
   *    **换模型务必重新实测**，别信这两个手抄数（踩坑第 3 条：外部资源的数值不能照假设写）。 */
  let RAW_H = 1.809;
  /* 模型里**最低的骨骼**（Toe_End/ToeBase）的 rest 高度（相对网格底部）。
   * 为什么需要它：`sp.bot` 取的是引擎给的"最低踝/趾"的 y，而它对应的应该是**模型的趾骨**，
   * 不是"网格脚底"。人形模型的趾骨恰好就在地面上（y=0），所以这个偏移是 0；
   * 旧猫模型的 Toes 骨骼在 y=0.08（网格脚底在 0），所以那时是 0.08。
   * 少了这个偏移，整条腿的目标就系统性地偏了 offset×scale。 */
  let REST_LOWEST = 0;

  /* ---------- 腿骨拉伸（旧猫模型需要，Mixamo 人形不需要 → 1.0）----------
   * 机制背景：旧猫模型腿比真人短 15%（小腿短 25%），而本驱动是"瞄真人关节的绝对世界位置
   * + 骨长固定" → 站姿下"髋→踝"目标就已超过模型腿可达长度，**腿从第一帧起就 IK 饱和、
   * 膝盖永远弯不了**，腿的幅度只剩身高的 16%。修法：把**近端**腿骨（大腿）沿骨长
   * `scale.y` 拉长，子骨骼**继承父缩放** → 整条腿链按同一比例变长，比例保持不变。
   * **只拉近端**是必须的：若同时拉大腿+小腿，小腿会被叠乘两次、比例更糟。
   *
   * 换成 Mixamo 人形后**不再需要**：实测髋高/身高 = 0.536、肩高/身高 = 0.792，
   * 与真人比例一致（真人髋高约 0.53、肩高约 0.80），站姿"髋→踝"目标不会超过腿长。
   * 所以取 1.0 —— 此时 rawBottom 恒为 0，等价于关闭。
   * ⚠️ **不要拉手臂**：无论哪个模型，手臂都不会太短；拉手臂会让站姿腕误差变大（旧模型实测
   *    0.135→0.178，是反效果）。
   * 三件套顺序（在 onModelLoaded 里，缺一不可）：
   *   ① 施加拉伸 → ② 算最低点下移量 rawBottom → ③ 重排 layout；
   * 且必须在**记录 rest.len 之前**做 —— IK 拿 rest.len 做余弦定理，先记再拉会按旧骨长算。 */
  const LEG_STRETCH = 1.0;
  const LEG_STRETCH_BONES = ["RightUpLeg", "LeftUpLeg"];
  /* ---------- 相机竖直视野（世界单位）----------
   * 正交相机的 top/bottom = ±HALF_VIEW_H，所以**整块画布恰好覆盖世界 y ∈ [-0.9, 0.9]**，
   * 竖直高度 = 1.8。像素↔世界的换算是 `worldY = 0.9 - screenY * (1.8 / innerHeight)`。
   *
   * ⚠️ **安全区换算必须用这个 1.8，不能用"看起来该是 2"的直觉**。
   * 这里曾经写成 `0.9 - (2 * UI_TOP_PX) / h`（把视野当成 [-1,1]），后果是**静默的**：
   * 角色被放大 2/1.8 = 11.1%、并整体下移同样的比例 → 头顶离顶部面板远了一大截、
   * **脚沉进下方控制栏里**。程序化断言全绿，只有量像素才看得出来。
   * 实测（1280×800，脚踩地站姿）：头顶 screen y=298、脚底 790；而控制栏上沿在 709
   * → 脚压住控制栏 81px。用 1.8 重算后脚底 694、头顶 213，上下各留 ~15px，正好。
   * 判据：`screen_y = (0.9 - worldY) * innerHeight / 1.8` —— 拿 `__boneWorld()` 的 y 代进去
   * 应当与截图里量到的像素**对得上**（对不上就是这里又漂了）。 */
  const HALF_VIEW_H = 0.9;
  const WORLD_VIEW_H = HALF_VIEW_H * 2;      // 1.8
  const UI_TOP_PX = 198;
  const UI_BOTTOM_PX = 91;
  /* 安全区内缩比例（上下各留这么多）。
   * 只负责"别贴着面板/控制栏的边"这一件事 —— 给举手过顶留的余量**不在这里**，
   * 而在下面的 REACH_UP（见那条注释）。这里曾经写着"取 4% 是为了给举手过顶留地方"，
   * 但代码是 3%、且 3% 根本不够（实测举手时手被顶部面板吃掉 32px）。 */
  const SAFE_INSET = 0.03;

  /* ---------- 3/4 斜视角（绕世界 Y 转相机）----------
   * 为什么要它：正对镜头的视角下，**前后方向（矢状面）**的动作在屏幕上几乎不产生位移
   * —— 原地跑、双臂前平举、正对镜头高抬腿，孩子自己看着"没动"。深度打通之后 z 有了，
   * 但正视图里 z 只表现为"变大变小"，仍然看不出来，所以要把相机转过去一点。
   *
   * ⚠️ **转相机，不转模型**。转模型会改掉所有骨骼的世界坐标 ⇒
   *    `__poseSnapshot()` 上的绝对几何断言（尤其 4c 的 |z| < 0.05）、IK 的目标点、
   *    "世界 +z 朝相机"这套约定全都要跟着改，风险大得多。转相机只动投影矩阵，
   *    世界坐标一个都不变。
   * ⚠️ y 投影**不受 Y 旋转影响** ⇒ 构图安全区（按屏幕 y 算）与
   *    `screenY() = (0.9 - worldY) * h / 1.8` 全部照旧，
   *    `avatar-portrait` / `accept-human-glb` ⑧ 的断言不用改（已逐条核对过）。
   *    横向会被压缩 cos(30°) = 0.866 —— ⑥ 的横向阈值（居中 0.35~0.65、宽度 > 5%）
   *    只会更宽松，不会误报。
   * 符号取 **正**（相机在模型自身左侧 +X 侧）：`scaleX(-1)` 的镜像语义与原来一致
   * （模型自身左侧仍落在屏幕左侧），只是横向压缩。 */
  const CAM_YAW_DEG = 30;
  const CAM_YAW = CAM_YAW_DEG * Math.PI / 180;
  const CAM_DIST = 3;      // 相机到世界原点的距离（正交相机，只影响近远裁剪与背景板摆位）
  const BG_DIST = 2;       // 背景板放在相机正前方多远

  /* 角色**最高可达点**：双臂竖直上举时指尖**高过模型自身头顶**多少（占身高的比例）。
   *
   * ⚠️ 这是一个**运行时从模型实测**的量（`reachUpFromModel()`，在 onModelLoaded 里算一次），
   *    下面这个数只是"模型还没加载完"时的兜底。**别把它当手抄常量再写死** —— 它已经错过两次：
   *      · 第一版 0.108/0.827 = 0.1306：拿**腕**当指尖，而且手长写成 0.026（真值 0.0874）；
   *      · 实测真值 = (肩 1.4406 + 臂链 0.7530 − 网格头顶 1.8092) / 1.8092 ≈ **0.2125**。
   *    为什么必须算进尺寸：只按"脚底→头顶"定大小的话，孩子做开合跳**把手举起来**时
   *    指尖会被顶部进度面板整个吃掉（实测 1280×800 指尖 166px vs 面板下沿 197.6px，
   *    手直接消失）。修法：尺寸按"脚底→指尖"的总伸展分配，
   *    模型自身高度只占其中的 1/(1+REACH_UP)（角色因此比"只按头顶"小 ~17.5%）。
   *    验收在 `accept-human-glb.js` ⑧ —— 那里量的是 `RightFingertip`（真·指尖骨）。 */
  let REACH_UP = 0.2125;            // 兜底；模型加载后由 reachUpFromModel() 覆盖
  /* 模型实测的 REACH_UP（只在 onModelLoaded 里、骨骼仍是 rest 姿势时算一次）。
   * 为什么只算一次、不在 resize 里重算：它虽然是个**比值**（与缩放/窗口无关），
   * 但**肩高会随姿势变**（深蹲时肩会降）—— 拿一个下蹲的姿势去算会把 REACH_UP 算小。
   * 骨段长度本身是刚体量、与姿势无关，但肩高不是。 */
  let reachUpMeasured = null;

  /* 按窗口高度算出"角色该多大、站多高"（返回世界单位的 { H, footY }）。
   * 导出到 window.MotionAvatar.__layoutFor 供测试核对，别在测试里重算一遍公式 ——
   * 两处各算一套迟早漂移（本项目已有教训）。
   * 像素→世界的斜率用 WORLD_VIEW_H（见上），不是 2。
   * `H` = **脚底→头顶**的高度（模型按它缩放）；脚底→指尖 = H × (1 + REACH_UP)。 */
  function layoutFor(winH) {
    const h = Math.max(240, winH || 720);
    const k = WORLD_VIEW_H / h;                       // 世界单位 / 像素
    const safeTop = HALF_VIEW_H - UI_TOP_PX * k;      // 顶部面板下沿的世界 y
    const safeBot = HALF_VIEW_H - (h - UI_BOTTOM_PX) * k;  // 底部控制栏上沿的世界 y
    const avail = Math.max(0.2, safeTop - safeBot);
    const usable = avail * (1 - SAFE_INSET * 2);      // 扣掉上下留白后的净可用高度
    const H = usable / (1 + REACH_UP);                // 脚→头顶；举手余量按比例分给它
    return { H: H, footY: safeBot + avail * SAFE_INSET, avail: avail };
  }
  let layout = layoutFor(720);   // 当前生效的布局（init / resize 时刷新）
  /* 模型**最低点**在"模型局部空间"的 y（腿骨拉伸前 = 0，即网格脚底）。
   * 拉近端腿骨后，整条腿（及其网格）沿骨长被放大 → 脚底下移到负值。
   * 它只在模型加载时按实际腿根高度解析算一次（见 computeRawBottom），
   * 之后 layout 用它把"变高的模型"重新塞回 UI 安全区。 */
  let rawBottom = 0;

  /* 模型路径：用户指定放在「体能训练动作演示」目录里（与动作示范视频同目录）。
   * file:// 下中文路径实测可加载（已用 _probe-human-rig.js 验证过），不必改名或拷贝。
   * 好处：用户直接替换这个文件即可换模型，不会出现"改了目录里的、程序读的是副本"。 */
  const MODEL_URL = "体能训练动作演示/体感跟练模型.glb";

  /* 两段 IK 开关（末端优先）。
   * 为什么需要它：**aim-only 只能对齐"方向"，而骨骼长度是模型固定的** ——
   * 于是"膝/肘"落在"起点 + 骨长×方向"上，与目标的膝/肘位置有偏差，且越往下累积越大，
   * 结果**脚/手到不了位**（孩子反馈"动作不如之前流畅、模拟不到位"）。
   * 旧模型是把圆柱**直接摆到两个关节之间**、长度随关节距离伸缩，所以能精确到位；
   * 蒙皮骨骼不能改长度（会拉伸网格变丑），所以改用 IK 按"末端优先"重新分配角度。
   * 设 false 可退回纯 aim，便于 A/B。 */
  const USE_IK = true;

  /* ★★ 深度开关：把骨架关节的 `z`（前后方向）真的接到角色上。
   *
   * 为什么需要（孩子原话）：
   *   「跟练模型只是对正面平面的运动识别比较准，对前后方向动作无法识别，
   *    比如我正对着摄像头跑步、双臂正向举起落下、正对镜头高抬腿」
   *   `rawWorld()` 原来把 z **写死 0** —— 于是正对镜头的前平举/高抬腿/跑步
   *   在角色身上要么没反应、要么被折成一团。复现见 `build/_probe-sagittal.js`
   *   （喂 3D 与喂 2D 的结果**逐位相同**，直接证明 z 被丢掉）。
   *
   * ⚠️⚠️ **为什么默认关闭**（别急着改成 true）：
   *   MediaPipe 的 z 是它**最弱的一路输出**，而且带有明显的**先验伪影**。
   *   实测（`build/fixtures/pose-human.png`，一张**平面插画**，物理上 z 应当处处为 0）：
   *     头 z=+0.787 → 髋 z≈0.00 → 踝 z=−0.20 —— 随高度**单调**变化；
   *     同一条手臂内（肩 0.419 / 肘 0.363 / 腕 0.450）跨度 0.087，
   *     而这条手臂全长才 0.256 ⇒ **伪影达骨长的 34%**，与要检的"前后摆"同量级。
   *   直接把这样的 z 喂进来，站立时躯干会被"推歪"、手臂会变成锯齿。
   *   **必须先用真实相机数据验**（R2）—— 这正是 `?poseDepth=1` 存在的意义：
   *   它把 A/B 交给真机，而不是靠合成夹具拍板（上一轮 `IK_REF` 就是这么栽的）。
   *
   * 口径换算：MediaPipe `z` 是"**负 = 靠近相机**"；角色世界 **+z 朝向相机**
   *   （相机在 z=+3 朝 −z）。所以世界 z = `−p.z × k2`。**只在这里换一次**。
   * 缺 z（掩码链路 / 旧夹具 / 未开深度）⇒ z=0 ⇒ 与旧行为**逐字节一致**。 */
  const POSE_DEPTH = (function () {
    try {
      const s = String((typeof window !== "undefined" && window.location && window.location.search) || "");
      return /[?&]poseDepth=1(?:&|$)/.test(s);
    } catch (e) { return false; }
  })();

  /* ★★ 深度 z 的**总开关**（2026-10-11 真机反馈后加，默认 **关**）。
   *
   * 真机现象：老李反馈「会突然缩成一团、动作不如上一次准确」。
   * 根因（已量化，见 `build/_probe-z-bend.js`）：
   *   IK 的弯曲角由**引擎关节的三维内角**决定 ——
   *     `solveTwoBoneIK` 里 `interiorAngle(engRoot, pole, target)`
   *   而这三个点都是 `jointTarget()`（= `rawWorld()`，**含 z**）。
   *   肘/腕/膝这些细肢体的深度采样只要偏 **~79mm**，换算成世界 z 就是 0.05，
   *   足以把一条**绝对伸直**的手臂报成**弯 22.6°**（推导：见该探针的表格）。
   *   Astra 在细肢体上的深度噪声 + D2C 对齐残差**远大于**这个量级
   *   ⇒ 引擎报"假弯曲" ⇒ IK 照着弯 ⇒ 四肢往躯干里折 ⇒「缩成一团」。
   *   `BEND_BIAS = 12°` 是个**常量**，压不住几十度的噪声。
   *
   * ⚠️ 所以：**z 进"引擎关节"这件事本身是危险的**，不是"调参能救"。
   *   要重开必须先把深度质量在真人身上验过（`build/_probe-real-depthz.js`），
   *   并且把 z 改成**只进目标方向、不进内角**（或做重度时域平滑 + 可信度闸门）。
   *   打开方式：URL 加 `?depthZ=1`。
   *
   * `POSE_DEPTH`（`?poseDepth=1`）**不受影响** —— 它是给 `_probe-sagittal.js`
   * 这类直接喂 3D 夹具的**几何**验收用的，走的是另一条路（夹具自带 z，不经过深度采样）。 */
  const DEPTH_Z = (function () {
    try {
      const s = String((typeof window !== "undefined" && window.location && window.location.search) || "");
      return /[?&]depthZ=1(?:&|$)/.test(s);
    } catch (e) { return false; }
  })();

  /* 目标位置的一阶低通系数。摄像头关节有抖动，骨架直吃生数据会"抽"。
   * 0.45 ≈ 时间常数 1~2 帧，够跟手又能压掉高频抖。调大更跟手、更抖。 */
  const JOINT_SMOOTH = 0.45;

  /* ---------- 骨骼段落表：模型骨骼 → 对应"哪两个关节之间" ----------
   * 键 = 模型骨骼名（**短名**；实际骨名带 `mixamorig` 前缀，靠 resolveBone 的别名表解析），
   * 值 = [父端关节, 子端关节, (可选)再上一级兜底关节]。
   * 骨骼朝向 = 从父端关节指向子端关节的**方向**。
   *
   * ⚠️ 这里是本文件最容易做错的地方，一定要**瞄"关节之间的方向"而不是"绝对位置"**。
   * 第一版瞄的是绝对世界位置，结果站姿就左右不对称：因为**模型骨架比例和真人不完全一样**，
   * 一根骨骼的起点位置跟目标的期望起点差得很远时，"指向那个点"算出来的方向就完全错了
   * —— 肩会被瞄成朝上、手臂整条翻掉。
   * 改成瞄方向后，骨骼朝向只取决于关节间的相对方向，与模型比例、骨骼绝对位置都无关，
   * 左右也天然镜像对称。
   *
   * ⚠️ 左右仍然**交叉**对应（见文件头第 1 条），别改直。
   *
   * Mixamo 骨架的层级（本表要跟它对上）：
   *   Hips → Spine → Spine1 → Spine2 → Neck → Head → HeadTop_End
   *   Spine2 → {Left,Right}Shoulder → {Left,Right}Arm → ForeArm → Hand →（5 指各 4 节）
   *   Hips   → {Left,Right}UpLeg  → {Left,Right}Leg → Foot → ToeBase → Toe_End */
  const BONE_SEG = {
    /* 三段脊柱都瞄"胯中点→颈"：引擎只给 hipMid/neck，没有脊柱曲率信息，
     * 所以把躯干拉成一条直线 —— 这正确表达了"前倾/侧倾/扭腰"。 */
    Spine: ["hipMid", "neck"], Spine1: ["hipMid", "neck"], Spine2: ["hipMid", "neck"],
    Neck: ["neck", "head"], Head: ["neck", "head"],
    RightShoulder: ["neck", "shoulderL"],
    RightArm: ["shoulderL", "elbowL"],
    RightForeArm: ["elbowL", "wristL", "shoulderL"],
    RightHand: ["wristL", "handL", "elbowL"],
    LeftShoulder: ["neck", "shoulderR"],
    LeftArm: ["shoulderR", "elbowR"],
    LeftForeArm: ["elbowR", "wristR", "shoulderR"],
    LeftHand: ["wristR", "handR", "elbowR"],
    RightUpLeg: ["hipL", "kneeL"],
    /* ⚠️ 第三项（兜底关节）**不能省**。孩子反馈过"看不到膝盖之下的动作"，
     * 就是这个位置缺兜底引起的：第二项 ankleL 一旦拿不到（MediaPipe 偶尔漏、
     * 掩码链路插值不到），segDir() 会返回 null → 这根小腿**完全不瞄准**，
     * 只剩"跟着大腿被动旋转"，看起来就是膝盖以下僵住了。
     * 补上 hipL 后：缺踝时用"髋→膝"的反方向（= 沿大腿继续伸直），
     * 至少小腿会跟着大腿走，而不是整段死住。脚掌同理。
     * ⚠️ 趾骨（ToeBase/Toe_End）与**脚掌（Foot）故意不进本表** —— 原因见下面「脚不瞄」的说明。 */
    RightLeg: ["kneeL", "ankleL", "hipL"],
    LeftUpLeg: ["hipR", "kneeR"],
    LeftLeg: ["kneeR", "ankleR", "hipR"]
  };

  /* ---------- 为什么**不驱动脚掌骨骼**（Foot/ToeBase/Toe_End）----------
   * 旧猫模型把脚掌瞄到"踝→趾"方向，换成 Mixamo 人形后这个做法**肉眼可见地坏了**：
   * 角色一直踮着脚尖（脚掌朝下）。
   *
   * 根因：正面视角下**脚掌的俯仰角在 2D 图像里根本不可观测**。
   * `pose-vision.js` 把 `toeL` 映射到 MediaPipe 的 **foot_index（趾尖）**（第 179 行）；
   * 站姿正面拍摄时，趾尖就在踝的正下方（脚指向镜头，不是指向下），
   * 于是"踝→趾"在图像里是一条**几乎垂直向下**的短向量（实测真实照片：
   * 踝 f=0.0716、趾 f=0.0159，Δy 只占 span 的 5.6%，Δx≈0）。
   * 拿它当"脚掌朝向"去瞄，就等于命令脚掌**笔直向下** = 踮脚。
   * 而这个方向里的"深度分量"（脚到底朝前伸多少）是**缺失信息**，无法从单目 2D 恢复。
   *
   * 为什么"不瞄"反而是对的：
   *   · 踝关节的位置由 IK 精确定位（`__ikError()` 实测 ankle 误差 = 0），脚掌瞄不瞄都不影响；
   *   · 模型 rest 姿态本来就是**平脚站立**（脚掌沿 +Z 朝前），不瞄就自动正确；
   *   · 脚掌会**继承小腿的旋转** → 抬膝/踢腿时脚自然跟着小腿走，看起来正常；
   *   · 代价：真的踮脚（提踵）时模型不跟 —— 但那个动作在 2D 里同样不可观测，
   *     强行跟只会带来"站姿也踮脚"的副作用，得不偿失。
   * ⚠️ 别"顺手把 Foot 加回 BONE_SEG"——加了就会重新踮脚。
   *    `__ikError()` 的 ankle 探针量的是**脚骨起点（=踝）**，与脚掌自身旋转无关，不受此影响。 */

  /* Mixamo 人形**没有尾巴**（旧猫模型有 6 节 Tail 骨骼）。
   * 保留这个空数组而不是删掉引用点：`animate()` 里的摆动循环与 `__skeleton().tail`
   * 都以它为准，空数组自然全跳过 —— 换回带尾巴的模型时只需填名字。 */
  const TAIL_BONES = [];

  /* 没识别到人时的自然站姿（归一化画面坐标，与引擎同一套）。
   * 手臂**下垂** —— 不能用模型自带 T-pose，那是"举手投降"，
   * 孩子一动没被识别到就看到角色举着双手，会以为坏了。
   *
   * ---------- 这张表**必须按模型自己的比例写**（换模型就要重算）----------
   * 它是"没有相机数据"时的**唯一**姿势来源，所以它的比例就是角色看起来的样子。
   * 旧表是照着**旧猫模型**手写的：髋在 0.545（= 离地只有身高的 46%），
   * 而人形模型的髋在 **53.6%**。髋位低了 7 个身高的百分点，等于命令角色**微蹲**——
   * 换成人形模型后立刻显形：膝内角被 IK 压到 82°、小腿前倾 39°，
   * 脚掌继承小腿的旋转变成**踮脚**，脚趾掉到 footY 以下（截图里脚沉进底部控制栏）。
   *
   * 所以新表的每个**躯干/腿**关节都直接来自模型静止骨架的实测（换算公式见
   * `build/_probe-human-rest-norm.js`：`ny = 0.925 − (worldY − 脚底) / 身高 × 0.827`）：
   *   踝 0.885 / 膝 0.683 / 髋 0.482 / 盆 0.451 / 肩 0.270 / 颈 0.242
   *   （模型实测：踝 4.8%、膝 29.2%、髋 53.6%、肩 79.2% —— 标准真人比例，
   *     与真实照片量到的 7.2% / 38% / 56% 同量级，腿长 48.8% 对真人 49%）。
   * 这样模型会**原样复现自己的静止骨架** → 腿是直的、脚是平的、没有多余屈膝。
   *
   * ⚠️ 手臂链是手写的**方向 + 实测骨长**（模型静止姿态是 T-pose，没有"手臂下垂"可抄）：
   * 上臂 0.1265、前臂 0.1288（模型实测 0.1273 / 0.1295，差 0.6%），
   * 上臂外张 7°、前臂外张 3°（真人站姿就是这么略外张）。
   * 于是"肩→腕"目标距离 0.2552 ≈ 骨长之和 0.2553 → 手臂**正好伸直**，IK 不额外弯肘。
   * 旧表腕在 0.452，是因为猫的手臂短；人形要 0.525 才够长。
   *
   * ★ `handL/handR`（腕→**指尖**）曾经写 0.026（腕→"手心"？）—— 那是个**没有真值锚点**
   *   的数，而且和 `_avatar-fixtures.js` 的 `MODEL_SEG.hand` 是**同一份错误的两个副本**，
   *   所以一起错了很久。实测（`build/_probe-human-hand.js`）：
   *     腕→食指尖（引擎 `handL` 的语义 = MediaPipe landmark 19）0.1858 模型单位 = **0.0849**
   *     腕→中指尖（最长指 = 最高可达点）                0.1913 模型单位 = **0.0874**
   *   这里取 **0.0874（中指）**：引擎的 `handL` 是食指尖，但本表还要供构图边界使用，
   *   按"最高可达点"取值只会**偏保守**（差 2.9%，方向一致，对 aim 影响 <1.5°）。
   *   位置沿前臂延长线往下挂（真人垂手就是这个方向）：
   *     肘(0.416,0.396) → 腕(0.409,0.525)，单位方向 (−0.054, 0.9985) × 0.0874
   *     ⇒ handL = (0.4043, 0.6123)（镜像 handR = (0.5957, 0.6123)）。
   *
   * ⚠️ `head` / `toe` 这两个锚点**保持旧值（0.098 / 0.925）**：`bodySpan()` 用它们算
   * `span = 0.827`，而 `span` 决定整条"归一化身高 → 世界高度"的换算比例（`k2`）。
   * 动它等于改角色整体大小，会让所有与幅度/尺寸有关的断言一起漂 —— 单独一件事，别顺手改。 */
  const IDLE_JOINTS = {
    head: { x: 0.500, y: 0.098 }, neck: { x: 0.500, y: 0.242 },
    shoulderL: { x: 0.431, y: 0.270 }, shoulderR: { x: 0.569, y: 0.270 },
    midL: { x: 0.423, y: 0.333 }, midR: { x: 0.577, y: 0.333 },
    elbowL: { x: 0.416, y: 0.396 }, elbowR: { x: 0.584, y: 0.396 },
    foreL: { x: 0.412, y: 0.460 }, foreR: { x: 0.588, y: 0.460 },
    wristL: { x: 0.409, y: 0.525 }, wristR: { x: 0.591, y: 0.525 },
    handL: { x: 0.4043, y: 0.6123 }, handR: { x: 0.5957, y: 0.6123 },
    hipMid: { x: 0.500, y: 0.451 }, hipL: { x: 0.463, y: 0.482 }, hipR: { x: 0.537, y: 0.482 },
    kneeL: { x: 0.463, y: 0.683 }, kneeR: { x: 0.537, y: 0.683 },
    shinL: { x: 0.463, y: 0.784 }, shinR: { x: 0.537, y: 0.784 },
    ankleL: { x: 0.463, y: 0.885 }, ankleR: { x: 0.537, y: 0.885 },
    toeL: { x: 0.463, y: 0.925 }, toeR: { x: 0.537, y: 0.925 }
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

  /* 骨段长度 = "骨骼自身 → 第一个子骨骼"的世界距离（IK 的两段链长）。
   * 没有子骨骼的末端骨骼长度为 0，它们本来也不参与 IK。 */
  function boneSegmentLen(b) {
    const kid = (b.children || []).find(c => c.isBone);
    if (!kid) return 0;
    b.updateMatrixWorld(true);
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    b.getWorldPosition(p); kid.getWorldPosition(q);
    return q.distanceTo(p);
  }

  /* 重算所有 rest.len（按**当前**世界矩阵量的真实骨长）。
   * 为什么需要单独一个函数而不是在记录 rest 时量一次就完 —— 骨段世界长度会随
   * **模型整体缩放**变化（窗口 resize 会改 layout.H → modelRoot.scale），
   * 而 IK 是拿它和"世界坐标的目标距离"做余弦定理的。旧代码只在加载时量一次，
   * 一旦 resize 骨长就和世界目标不同尺度了（潜在的老 bug）。现在 applyLayout 每次
   * 都刷新，拉伸腿骨后也能拿到正确的世界骨长。
   * 注：骨骼被旋转不影响"父→子"距离，所以无论当前是什么姿势，量出来都是 rest 长度。 */
  function refreshRestLens() {
    for (let i = 0; i < topDown.length; i++) {
      const b = topDown[i];
      if (rest[b.name]) rest[b.name].len = boneSegmentLen(b);
    }
  }

  /* 模型整体缩放系数。分母是"模型在局部空间里的**真实**高度"：
   * RAW_H（头顶）减去 rawBottom（最低点；腿骨拉伸后为负 → 高度变大）。
   * 不能再用 RAW_H：腿拉长后脚底掉到 y<0，若仍按 RAW_H 缩放，模型会比 layout.H
   * 高一截、脚掉出安全区（实测 S=1.18 时脚下移约 0.10 世界单位）。 */
  function modelScale() { return layout.H / (RAW_H - rawBottom); }

  /* 把 layout 作用到模型上（首次加载与窗口 resize 时调用）。
   * 只需改根节点的缩放与位置 —— rest 里记的 worldQuat / headDir 是**旋转量**，
   * 一様缩放和平移都不改变它们；restBasis 由方向差构造，同理不受影响。
   * ⚠️ 但 rest.len（骨段世界长度）**不是**不变量，见 refreshRestLens。 */
  function applyLayout() {
    layout = layoutFor(window.innerHeight || 720);
    if (!modelRoot) return;
    const s = modelScale();
    modelRoot.scale.setScalar(s);
    // 站位：把"最低点"（rawBottom）落到 footY。rawBottom=0 时与旧行为完全一致。
    modelRoot.position.set(0, layout.footY - rawBottom * s, 0);
    modelRoot.updateMatrixWorld(true);
    refreshRestLens();
  }

  /* 由"腿根骨骼在模型局部空间的高度"解析地算拉伸后最低点下移多少。
   * 原理：只对 RightUpLeg 施加 scale.y=S，它的**整个子树**（小腿/脚/脚趾及其网格）
   * 沿骨长被放大 S 倍。网格脚底原本在模型 y=0，腿根在 y=h → 拉伸后脚底
   * y = h − S·h = −(S−1)·h。所以 rawBottom = −(S−1)·h（h 为腿根的模型局部 y）。
   * h 与模型整体缩放无关（是模型局部常量），用"世界 y 除以当前缩放"反推即可。
   * ⚠️ 当前 LEG_STRETCH = 1.0 → 本函数恒返回 0（等价关闭），但保留机制以便换模型时复用。 */
  function computeRawBottom() {
    const b = resolveBone("RightUpLeg");
    if (!b) return 0;
    b.updateMatrixWorld(true);
    const wp = new THREE.Vector3(); b.getWorldPosition(wp);
    const ms = modelRoot.scale.x || 1;
    const legRootRawY = (wp.y - modelRoot.position.y) / ms;
    return -(LEG_STRETCH - 1) * legRootRawY;
  }

  /* 施加腿骨拉伸：只动**近端**两根大腿骨（见 LEG_STRETCH 注释）。 */
  function applyLegStretch() {
    LEG_STRETCH_BONES.forEach(n => {
      const b = resolveBone(n);
      if (b) { b.scale.set(1, LEG_STRETCH, 1); b.updateMatrixWorld(true); }
    });
  }

  /* ---------- 实测模型尺寸（RAW_H / REST_LOWEST），别照假设写死 ----------
   * 为什么必须实测：换模型时手抄常量极易忘改，而后果是**静默的** ——
   * 角色只是"略大/略小、脚略微离地"，程序化断言全绿，只有肉眼看得出来。
   *
   * ⚠️ **不要用 `Box3.setFromObject()` 量蒙皮网格**：它拿
   * `geometry.boundingBox × matrixWorld` 算，而本模型 `Armature` 节点带 **scale 0.01**，
   * 量出来 0.018（真值 1.81）—— 差 100 倍，而且不报错。必须走**真蒙皮变换**：
   * 逐顶点调 `SkinnedMesh.applyBoneTransform`（r150 叫这个名，更早叫 `boneTransform`），
   * 它内部按 4 骨骼权重算，与渲染着色器完全一致。
   *
   * 量之前把 modelRoot 的缩放/位移临时归零，得到的是**模型局部空间**的包围盒，
   * 与窗口大小、layout 都无关（否则 resize 一次数值就变了）。 */
  function measureSkinnedBox() {
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    let measured = false;
    modelRoot.traverse(o => {
      if (!o.isSkinnedMesh || !o.geometry || !o.geometry.attributes.position) return;
      const pos = o.geometry.attributes.position;
      const skin = o.skeleton ? (o.applyBoneTransform || o.boneTransform) : null;
      if (!skin) {
        // 没拿到蒙皮接口时退回"原始几何包围盒"：本模型恰好可用（bind 空间与世界同尺度），
        // 但别把它当成通用做法 —— 见上面的 Armature scale 警告。
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
        measured = true;
        return;
      }
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        skin.call(o, i, v);
        o.localToWorld(v);
        box.expandByPoint(v);
      }
      measured = true;
    });
    return measured && !box.isEmpty() ? box : null;
  }

  /* 量出 { top, bottom, height, lowestJointY, lowestJointName }（模型局部空间）。
   * height  → RAW_H（模型真实身高）
   * lowestJointY − bottom → REST_LOWEST（最低关节相对网格底部的高度） */
  function measureModelMetrics() {
    if (!modelRoot) return null;
    const s0 = modelRoot.scale.clone(), p0 = modelRoot.position.clone();
    modelRoot.scale.set(1, 1, 1);
    modelRoot.position.set(0, 0, 0);
    modelRoot.updateMatrixWorld(true);

    const box = measureSkinnedBox();

    let lowestJointY = Infinity, lowestJointName = "";
    topDown.forEach(b => {
      const p = new THREE.Vector3(); b.getWorldPosition(p);
      if (p.y < lowestJointY) { lowestJointY = p.y; lowestJointName = b.name; }
    });

    modelRoot.scale.copy(s0);
    modelRoot.position.copy(p0);
    modelRoot.updateMatrixWorld(true);

    if (!box || !Number.isFinite(lowestJointY)) return null;
    return {
      top: box.max.y, bottom: box.min.y, height: box.max.y - box.min.y,
      lowestJointY: lowestJointY, lowestJointName: lowestJointName
    };
  }

  /* 加载后把实测值写回常量，并**在偏离兜底值太多时大声告警**（别静默）。
   * 用 `let` 而不是 `const` 就是为了这一步；`metrics` 也导出给测试核对。 */
  let metrics = null;
  function refreshModelMetrics() {
    const m = measureModelMetrics();
    if (!m) return;
    metrics = m;
    const driftH = Math.abs(m.height - RAW_H) / Math.max(1e-6, RAW_H);
    const newRestLowest = m.lowestJointY - m.bottom;
    const driftL = Math.abs(newRestLowest - REST_LOWEST);
    if (driftH > 0.05) console.warn("[motion-avatar] 模型身高实测 " + m.height.toFixed(3) +
      "，与兜底常量 " + RAW_H.toFixed(3) + " 差 " + (driftH * 100).toFixed(1) + "%，已改用实测值");
    if (driftL > 0.02) console.warn("[motion-avatar] 最低关节离地实测 " + newRestLowest.toFixed(3) +
      "，与兜底常量 " + REST_LOWEST.toFixed(3) + " 不符，已改用实测值（最低关节=" + m.lowestJointName + "）");
    RAW_H = m.height;
    REST_LOWEST = newRestLowest;
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

    // 全屏角色层不能遮住"结束并评分"入口，否则开始训练后无法退出。
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

    /* 达标进度面板。**必须放在全屏层里**：开练后角色铺满窗口，
     * 页面里的读数区全被盖住，孩子站两米外只看得见这一块。
     *
     * ⚠️ 初始必须带 `hidden`。原因：预览态（`st.previewing`）下 app.js **不会**调
     * `renderMotionProgress()`（见 app.js 的 `if (motionChoice && !st.previewing)`），
     * 所以 `setProgress(null)` 也不会被调用 —— 若不在这里加 hidden，
     * 角色一 show() 就会顶着一个**空面板**（灰色空进度条）挡住头顶，
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

  /* ---------- 兜底简易人形（GLB 加载失败时）----------
   * 换成"人形"而不是留旧版"简易猫"：跟练角色已改成人形，兜底也必须是同类，
   * 否则孩子看到猫会以为换错了。比例照 Mixamo 人形（身高 1.81、髋高 0.53×身高、
   * 肩高 0.80×身高），这样即便退到兜底，构图和 UI 安全区也一致。 */
  function buildFallback() {
    const g = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0xf2a48c, roughness: 0.85 });
    const suit = new THREE.MeshStandardMaterial({ color: 0x6f8ec9, roughness: 0.9 });
    const H = 1.81;
    const head = new THREE.Mesh(new THREE.SphereGeometry(H * 0.065, 18, 14), skin);
    head.position.y = H * 0.925; g.add(head);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(H * 0.026, H * 0.03, H * 0.045, 12), skin);
    neck.position.y = H * 0.865; g.add(neck);
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(H * 0.085, H * 0.072, H * 0.245, 16), suit);
    torso.position.y = H * 0.72; g.add(torso);
    const hips = new THREE.Mesh(new THREE.CylinderGeometry(H * 0.075, H * 0.07, H * 0.09, 16), suit);
    hips.position.y = H * 0.552; g.add(hips);
    [-1, 1].forEach(s => {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(H * 0.028, H * 0.024, H * 0.30, 12), skin);
      arm.position.set(s * H * 0.105, H * 0.635, 0); g.add(arm);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(H * 0.040, H * 0.032, H * 0.46, 12), suit);
      leg.position.set(s * H * 0.055, H * 0.28, 0); g.add(leg);
    });
    g.name = "fallbackHuman";
    return g;
  }

  /* ---------- 初始化（同步部分）---------- */
  function init() {
    if (renderer || typeof THREE === "undefined") return !!renderer;
    buildUI();

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1420);

    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.OrthographicCamera(
      -HALF_VIEW_H * aspect, HALF_VIEW_H * aspect, HALF_VIEW_H, -HALF_VIEW_H, 0.1, 20);
    /* 3/4 斜视角：绕世界 Y 转 CAM_YAW（见常量处的长注释）。
     * 相机落在以原点为心、半径 CAM_DIST 的圆上，始终看向原点 ⇒
     * 只改投影方向，世界坐标一个都不动。 */
    camera.position.set(CAM_DIST * Math.sin(CAM_YAW), 0, CAM_DIST * Math.cos(CAM_YAW));
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);

    /* ---------- 左右镜像（只翻这块 WebGL 画布本身）----------
     * 孩子看到的摄像头画面在 styles.css 里已经加了 `transform: scaleX(-1)`（video 与骨架
     * canvas 都加），是"照镜子"的效果。但角色层是**本模块自己新建画布挂到 document.body**
     * 的（appendChild(container) / 上面 appendChild(renderer.domElement)），
     * **不在 .motion-screen 里，吃不到那条镜像** → 孩子抬右手时，视频里手在右边、角色的手
     * 却在左边，看着别扭（用户原话"左右动作需要镜像一下方便我观察"）。
     *
     * 为什么用 **CSS 镜像画布**，而不是去翻世界坐标或交换左右映射：
     *   · 视觉上与"几何镜像"完全等价 —— 相机正交、看向世界原点，角色水平居中在 x=0，
     *     画布水平中心正对模型 x=0，所以"绕画布中心 scaleX(-1)"就等于"绕模型 x=0 镜像"。
     *   · **世界坐标一个都不变** → 不牵动验收脚本里那些绝对几何断言
     *     （尤其 4c 节的 `|z| < 0.05`），零测试改动。
     *   · 反过来，改 `rawWorld()` 的 `(p.x - 0.5)` 或交换 BONE_SEG/IK_CHAINS 的左右映射，
     *     都必须**同时**翻 x 与交换映射，否则四肢会交叉（见文件头第 1 条的血泪警告）。
     *     CSS 方案把这两个雷整个绕开。
     *
     * ⚠️ **只镜像画布，不要镜像 container**：container 里还有状态文字与「返回画面 /
     * 结束并评分」按钮，镜像了字就反了。进度面板是 container 的另一个子节点，也不受影响。
     * transform-origin 默认就是元素中心（50% 50%），正是我们要的"绕画布中心"。 */
    renderer.domElement.style.transform = "scaleX(-1)";

    bgMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: makeBackgroundTexture(), depthWrite: false })
    );
    /* ⚠️ 背景板必须**跟着相机转**。原来写死 `position.z = -1`（正对 +Z 的板子）：
     * 相机一转就会斜着看它，两侧露出 scene.background 的深色缝。
     * 做法：放到相机正前方 BG_DIST 处，并绕 Y 转到与相机正对。
     * 相机前向 = -normalize(position) ⇒ 板心 = camera.position + BG_DIST * 前向
     *                            = ((CAM_DIST - BG_DIST)·sinθ, 0, (CAM_DIST - BG_DIST)·cosθ)
     * 板法线（PlaneGeometry 默认 +Z）绕 Y 转 θ 后 = (sinθ, 0, cosθ) = 相机方向 ✓
     * CAM_YAW 是常量，所以只在 init 里摆一次就够（sizeBackground 只改 scale）。 */
    bgMesh.rotation.y = CAM_YAW;
    bgMesh.position.set(
      (CAM_DIST - BG_DIST) * Math.sin(CAM_YAW), 0, (CAM_DIST - BG_DIST) * Math.cos(CAM_YAW));
    scene.add(bgMesh);

    /* 三点布光。模型是**纯色 PBR 材质、无贴图**（GLB 里 textures=0），
     * 明暗全靠灯光 —— 强度不够整个角色会糊成一团灰。 */
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
    camera.left = -HALF_VIEW_H * aspect; camera.right = HALF_VIEW_H * aspect;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    sizeBackground();
    applyLayout();          // 窗口一变，安全区就变 → 角色的尺寸/站位要跟着重算
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

    /* ---- 骨骼名解析：GLTFLoader 会**改名**，别名表是唯一入口 ----
     * 已经踩过两次，都是**静默失效**（不报错、不警告，只是某根骨骼永远不被驱动）：
     *   · 旧猫模型：头部**骨骼**与头部**网格**同名 "Head" → GLTFLoader 自动把骨骼改名成
     *     "Head_1" → BONE_SEG 里写的 "Head" 查不到。
     *   · 本 Mixamo 模型：GLB 里骨名是 `mixamorig:Neck`，GLTFLoader **把冒号洗掉** →
     *     到 three 里变成 `mixamorigNeck`。
     * 所以取名一律走 resolveBone()。别名规则（两条，都很窄，不会误伤兄弟骨骼）：
     *   ① 去掉结尾的 `_数字`（Head_1 → Head）；
     *   ② 去掉开头的 `mixamorig` 前缀（mixamorigNeck → Neck）。
     * 只在"没有同名真骨骼"时才建别名，避免把 Head_1 / Head_2 这类真正的兄弟骨骼搞混。 */
    Object.keys(bones).forEach(actual => {
      const cands = [
        actual.replace(/_\d+$/, ""),                 // Head_1 → Head
        actual.replace(/^mixamorig:?/i, "")           // mixamorigNeck → Neck
      ];
      cands.forEach(logical => {
        if (logical && logical !== actual && !bones[logical] && !boneAlias[logical]) {
          boneAlias[logical] = bones[actual];
        }
      });
    });

    /* 自顶向下顺序：aim 依赖父级已更新，必须按层级排。 */
    topDown = [];
    const all = Object.keys(bones).map(n => bones[n]);
    const roots = all.filter(b => !b.parent || !b.parent.isBone);
    const walk = b => { topDown.push(b); (b.children || []).forEach(c => { if (c.isBone) walk(c); }); };
    roots.forEach(walk);

    /* ---- 实测模型尺寸（RAW_H / REST_LOWEST）----
     * 必须在**记录 rest / 施加拉伸 / 排 layout 之前**跑，因为后面三步都要用这两个值
     * （modelScale 用 RAW_H、rawWorld 用 REST_LOWEST）。 */
    refreshModelMetrics();

    /* 腿骨拉伸必须在**记录 rest 之前**施加，而且顺序不能反：
     *   ① 拉伸 → ② 算最低点下移量 rawBottom → ③ 重排 layout。
     * ② 必须在 ① 之后（拉伸改了腿的几何）；③ 必须在 ② 之后（要知道下移多少才好把
     * 变高的模型塞回安全区）；而 ① 在"记录 rest"之前，是为了让 rest.len 一量就是
     * **拉伸后的真实世界骨长** —— IK 拿它做余弦定理，先记再拉会让 IK 按旧骨长算，越修越坏。
     * 当前 LEG_STRETCH = 1.0（Mixamo 人形是真人比例，不需要拉），此时 rawBottom 恒为 0。 */
    applyLegStretch();
    rawBottom = computeRawBottom();
    applyLayout();

    /* ★ 实测 REACH_UP（"举手过顶时指尖比模型头顶高多少 / 身高"），再排一次 layout。
     * 时机不能挪：必须在 ①骨骼仍是 rest 姿势（applyPose 还没跑过，肩高才是真肩高）、
     * ②applyLayout 之后（要用 modelScale 把世界坐标折回局部）两个条件同时成立时做。
     * 它只算一次并缓存 —— 见 reachUpMeasured 处的注释（肩高会随姿势变）。 */
    const rMeasured = reachUpFromModel();
    if (rMeasured != null && rMeasured > 0.02 && rMeasured < 0.8) {
      reachUpMeasured = rMeasured;
      REACH_UP = rMeasured;
    } else {
      console.warn("[motion-avatar] 无法从模型实测 REACH_UP，沿用兜底值 " + REACH_UP +
        "（举手时手可能被顶部面板压住）");
    }
    shoulderFrac = shoulderFracFromModel();
    applyLayout();

    /* 记录 rest。「骨轴 headDir」= **骨骼自身的局部 +Y 轴在世界中的方向**。
     * Blender / Mixamo 导出的骨架，骨骼的局部 Y 轴就是沿骨长（head→tail）的方向，
     * 所以它等价于"指向下一个骨骼"。（本模型实测：除 Neck/Head/双手外，偏差都在 5° 内；
     * 双手偏 51.6° 是因为它的第一个子骨骼是**拇指**，天生偏在侧面，属正常。） */
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
       * 此时腿骨拉伸与 layout 重排都已生效，所以量到的是**最终的真实世界骨长**。
       * 没有子骨骼的末端骨骼长度为 0，它们本来也不参与 IK。 */
      rest[b.name] = {
        quat: b.quaternion.clone(), pos: b.position.clone(), worldQuat: wq.clone(),
        headDir, axisGap: altAngle, len: boneSegmentLen(b)
      };
      if (altAngle > 15) axisMismatch.push(b.name + "(" + altAngle.toFixed(0) + "°)");
    });

    /* 躯干 rest 基：x = 引擎 hipL→hipR 方向（对应模型 RightUpLeg→LeftUpLeg），y = 胯→颈 */
    restBasis = makeTorsoBasis(
      worldOf("Hips"), worldOf("RightUpLeg"), worldOf("LeftUpLeg"), worldOf("Neck")
    );

    tailBase = TAIL_BONES.map(n => { const bb = resolveBone(n); return bb ? bb.quaternion.clone() : null; });

    info.ready = true; info.reason = "";
    setStatusText("等待可靠的人形轮廓");
    applyPose(lastJoints);
  }

  /* 取名统一入口：先精确匹配，再退到别名表（去掉 `_数字` 后缀 / 去掉 `mixamorig` 前缀）。
   * 为什么必须有它 —— 见 onModelLoaded 里 boneAlias 的注释：GLTFLoader 会改名，
   * 而"查不到"的表现是**静默失效**（那根骨骼永远不被驱动，不报错）。 */
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

  /* ---------- 从模型自身骨架实测「举手过顶能伸多高」----------
   * 为什么必须实测：这个量决定角色大小，而它**没有真值锚点的两个副本**（IDLE_JOINTS.handL
   * 与夹具的 MODEL_SEG.hand）已经一起错了很久（写成 0.026，真值 0.0874，差 236%）。
   * 改成从骨架量之后，换模型不会再静默失效。
   *
   * ⚠️ 只在**骨骼处于 rest 姿势**时调用（onModelLoaded 里、applyPose 之前）：
   *    肩高会随姿势变（深蹲时肩会降），拿一个下蹲的姿势去算会把 REACH_UP 算小。
   *    骨段长度是刚体量、与姿势无关，但肩高不是。 */
  function reachUpFromModel() {
    if (!modelRoot) return null;
    const s = modelScale();
    if (!(s > 0)) return null;
    const sh = worldOf("RightArm");
    const chain = armChainWorld();
    if (!sh || !chain) return null;
    /* 参照系全部折回**模型局部**（÷s）。别用世界坐标直接减 —— 世界坐标里混着
     * layout.footY 与 modelRoot.position，一旦窗口变化就会把两个不同基准的量相减。 */
    const bodyLocal = RAW_H - rawBottom;                       // 拉伸后模型自身高度（局部）
    const shoulderLocal = (sh.y - modelRoot.position.y) / s;   // 肩在模型局部空间的高度
    const reachLocal = shoulderLocal + (chain.upperArm + chain.foreArm + chain.hand) / s;
    /* ★ 分子必须是「指尖局部 y − **网格顶**局部 y」= reachLocal − RAW_H。
     *   曾经写成 `reachLocal / bodyLocal - 1`，它在 rawBottom = 0 时**恰好等价**，
     *   但腿骨一拉长（rawBottom < 0）就少算了 |rawBottom|/bodyLocal ——
     *   拿 S=1.18 估一下偏差有 ~8.8 个百分点，是个**只在换模型时才现形**的静默错误。
     *   分母 = 网格高度（RAW_H − rawBottom），与 modelScale() 的分母同源。 */
    return (reachLocal - RAW_H) / bodyLocal;
  }

  /* 肩在"模型身高"里的位置（0~1，离地比例）。给验收脚本算"手臂完全竖直时指尖能到多高"用。
   * ⚠️ 只在 rest 时算一次并缓存 —— 肩高会随姿势变（深蹲时肩会降），现算会漂。
   * 实测 1.4406/1.8092 = 0.7963；而引擎 IDLE 的肩锚点换算过来是 0.655/0.827 = 0.7920，
   * 两者差 0.43%（≈1.7px@800）—— 构图上界要取**更高**的那个才真的是上界。 */
  let shoulderFrac = null;
  function shoulderFracFromModel() {
    if (!modelRoot) return null;
    const s = modelScale();
    const sh = worldOf("RightArm");
    if (!sh || !(s > 0)) return null;
    const bodyLocal = RAW_H - rawBottom;
    return ((sh.y - modelRoot.position.y) / s - rawBottom) / bodyLocal;
  }

  /* 手臂链（肩→肘→腕→指尖）三段在**当前世界尺度**下的长度。
   * 骨段是刚体 → 任何姿势下量都一样，所以不必挑 rest 时机。
   * 指尖由 fingertipName() 在骨骼树里**发现**，不硬编码 Mixamo 指骨名（踩坑第 3 条）。 */
  function armChainWorld() {
    const tip = fingertipName("RightHand");
    if (!tip) return null;
    const pts = ["RightArm", "RightForeArm", "RightHand", tip].map(worldOf);
    if (pts.some(p => !p)) return null;
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    return { upperArm: d(pts[0], pts[1]), foreArm: d(pts[1], pts[2]), hand: d(pts[2], pts[3]), tipName: tip };
  }

  /* 找出"手骨子树里离腕最远的骨" = 指尖。
   * 为什么不写死 `RightHandMiddle4`：骨名是**外部资源**的一部分，而本项目已经在
   * "GLTFLoader 洗掉骨名冒号"上栽过两次（踩坑第 3 条：外部资源的名字不能照假设写）。
   * 发现法对任何骨架都成立，而且手指骨是刚体（我们从不驱动它们）→ 结果与姿势无关。 */
  const tipCache = {};
  function fingertipName(handName) {
    /* ⚠️ **只缓存成功结果**。曾经写成 `if (tipCache[handName] !== undefined) return ...`
     * 并把 null 也写进缓存 —— 那样只要有人在模型加载完之前问过一次（`resolveBone` 返回 null），
     * 这个缓存就被**永久毒化**，之后 `reachUpFromModel()` 永远拿不到指尖、静默退回兜底值。
     * 子树里真的没有骨骼（best 仍为 null）时也不缓存：重走一遍很便宜，误缓存很贵。 */
    if (tipCache[handName]) return tipCache[handName];
    const hand = resolveBone(handName);
    if (!hand) return null;
    hand.updateMatrixWorld(true);
    const hp = new THREE.Vector3(); hand.getWorldPosition(hp);
    let best = null, bestD = -1;
    const walk = o => (o.children || []).forEach(c => {
      if (!c.isBone) return;
      const p = new THREE.Vector3(); c.getWorldPosition(p);
      const d = p.distanceTo(hp);
      if (d > bestD) { bestD = d; best = c.name; }
      walk(c);
    });
    walk(hand);
    if (best) tipCache[handName] = best;
    return best;
  }

  /* ---------- 坐标映射：引擎归一化坐标 → 世界坐标 ----------
   * 缩放按**全身高**匹配：k2 = layout.H / (最低踝 − 头)。
   *
   * 试过的另一条路（记录下来免得再走一遍）：曾改成"按**腿长**匹配"，想让脚更容易够到
   * 目标（**旧猫模型**腿长只占身高 36%，真人约 49%）。**实测更差** —— 踝误差从 0.12 推到 0.24。
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
    /* + REST_LOWEST*scale：把"目标最低踝/趾"对到模型的 Toes 骨骼（见常量处注释）。
     * ⚠️ 拉伸腿骨后这里**依然成立**，别改成别的：模型最低点从 y=0 下移到 rawBottom，
     * 而 Toes 骨骼（模型 y=0.08）也随之下移到 0.08+rawBottom。模型站位又被
     * applyLayout 上移了 −rawBottom·scale（把最低点顶回 footY）→ 两项恰好抵消，
     * Toes 骨骼最终仍落在 footY + 0.08·scale。推导：目标 = (footY − rawBottom·scale)
     * + scale·(0.08 + rawBottom) = footY + 0.08·scale。 */
    const scale = modelScale();
    /* ★ 深度（前后方向）：`useZ` 为 false 时恒为 0 ⇒ 与旧行为逐字节一致。
     * MediaPipe z 负 = 靠近相机；世界 +z 朝相机 ⇒ 取负号（见 POSE_DEPTH 处注释）。
     *
     * 两个来源：
     *   ① `POSE_DEPTH`（`?poseDepth=1`）：给 3D 夹具的**几何**验收用，直接喂。
     *   ② `DEPTH_Z`（`?depthZ=1`）+ `j.__depthZ`：Astra 深度算出来的生产路径。
     *      ⚠️ **默认关**！真机实测 z 噪声会把引擎的关节内角污染成"假弯曲"，
     *      IK 跟着折 ⇒「缩成一团」。详见 `DEPTH_Z` 常量处那段推导。 */
    const zN = (typeof p.z === "number" && isFinite(p.z)) ? p.z : 0;
    const useZ = POSE_DEPTH || (DEPTH_Z && j && j.__depthZ === true);
    const zW = useZ ? -zN * k2 : 0;
    return _v1.set((p.x - 0.5) * k2, layout.footY + REST_LOWEST * scale + (sp.bot - p.y) * k2, zW);
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
  function solveTwoBoneIK(rootBone, midBone, target, poleWorld, engineRoot) {
    if (!USE_IK || !rootBone || !midBone || !target) return false;
    const rA = rest[rootBone.name], rB = rest[midBone.name];
    if (!rA || !rB) return false;
    const L1 = rA.len, L2 = rB.len;
    if (!(L1 > 1e-4) || !(L2 > 1e-4)) return false;

    /* ⚠️ 全程用 _ik* 专用缓冲。**不能借用 aimBone 的 _v1/_v2/_v4** ——
     * aimBone 内部会改写它们（`_v2.copy(rd.headDir)`、`_v4.copy(dir)`），
     * 而本函数要在两次 aimBone 调用之间跨用中间结果，借用就会互相踩。 */
    rootBone.getWorldPosition(_ikRoot);              // 根（髋/肩）—— **模型自己的**
    _ikU.copy(target).sub(_ikRoot);
    const dRaw = _ikU.length();
    if (!(dRaw > 1e-5)) return false;
    _ikU.divideScalar(dRaw);                         // 单位向量 u

    /* ★★ 目标距离改由**引擎自己的关节内角**换算，不再用"目标到模型根的世界距离"。
     *   真人骨长比例 ≠ 模型骨长比例，这是**必然**的（Mixamo 是标准身材，孩子不是）；
     *   MediaPipe 的肘/膝关键点也还有零点几的偏移。旧写法
     *       d = |腕目标 − 模型肩|
     *   把这个"比例差"混进了距离里，IK 只好**弯着肘去够** —— 而 IK 在接近伸直时
     *   会把距离误差**开平方放大**：
     *       A = acos(d/(2L))，d/(2L) = 1 − ε  ⇒  A ≈ √(2ε)  ⇒  关节弯曲角 ≈ 2√(2ε)
     *   实测 ε = 0.0054（0.54%）⇒ 弯曲角 **11.9°**。
     *   证据（诊断脚本，输入是**几何上严格**的）：
     *       · 喂"肩-肘-腕严格共线、水平平举" → 模型肘仍弯 **11.9°**
     *       · 喂"髋-膝-踝严格竖直"（STAND 本来就是）→ 模型膝仍弯 **11.8°**
     *   孩子看到的正是「我手臂与腿是直的时候他的动作是弯的」。
     *
     * 换成引擎的**内角** θ 之后：θ 是无量纲的角度，**1:1** 传给模型，没有放大 ——
     *   引擎说伸直（θ→180°）模型就伸直；引擎说弯 90° 模型就弯 90°。
     * 代价：末端不再"尽力去够"引擎的绝对位置（差的就是那个骨长比例），
     *   但"动作与玩家一致"正是本需求要的东西；而且引擎说伸直时 d = L₁+L₂
     *   本来就是**模型的最大伸展**，位置误差反而是最小的。 */
    /* ★★ 用 `interiorAngleXY`（**丢 z**）而不是 `interiorAngle`（三维）。
     * 理由与实测数字见 `interiorAngleXY` 定义处那段推导 —— 一句话：
     * 深度在细肢体上偏十几毫米就能把"伸直"报成"弯 8°~40°"，
     * IK 照着弯就是孩子看到的「缩成一团」。z 只用来定"指向哪"，不参与"弯多少"。 */
    const th = engineRoot ? interiorAngleXY(engineRoot, poleWorld, target) : null;
    let d;
    if (th != null) {
      /* 减掉关键点的系统偏差（见 BEND_BIAS），再把角度换算成"模型自己骨长下的距离"。 */
      const t = Math.PI - Math.max(0, Math.PI - th - BEND_BIAS);
      const dAngle = Math.sqrt(L1 * L1 + L2 * L2 - 2 * L1 * L2 * Math.cos(t));
      /* ★★ 取 min(dAngle, dRaw) —— 解决高抬腿/跑步时腿不动的问题（用户反馈③）。
       *
       * 根因（探针 _probe-motion-redesign.js 卷3 实测）：
       *   正面视角下高抬腿时，髋-膝-踝三点在 x-y 投影里**共线**（x 都≈0.5），
       *   interiorAngleXY 返回 th≈180° → t=BEND_BIAS=12° → dAngle≈L1+L2（伸直）。
       *   但实际上踝已经抬到髋附近（dRaw << L1+L2），腿应该弯。
       *   内角法因为丢 z，看不到矢状面的屈膝 → 判"伸直" → 腿不动。
       *
       * 修法：取 min(dAngle, dRaw)。
       *   · 站立伸直时：dAngle≈L1+L2，dRaw≈L1+L2 → min=L1+L2（不弯，正确）
       *   · 高抬腿时：dAngle≈L1+L2（内角法瞎了），dRaw<L1+L2（踝近了髋）
       *     → min=dRaw → IK 根据实际距离弯膝（正确）
       *   · 真弯膝时：dAngle<L1+L2（内角看到了弯），dRaw≈dAngle
       *     → min=dAngle（两种方法一致，正确）
       *
       * 为什么不像旧安全网那样"差太多才退回"，而是直接取 min：
       *   旧安全网只在 |dAngle - dRaw| > 0.6*(L1+L2) 时退回 → 高抬腿时
       *   dAngle≈0.87、dRaw≈0.16，差 0.71 > 0.6×0.87=0.52 → 会退回 dRaw。
       *   但阈值的选取是经验性的——"差多少才算不可靠"没有理论依据。
       *   而"取 min"有物理含义：两种方法都说"不弯"时才不弯，只要有一种
       *   方法看到"该弯"就弯。这比"差太多才听 dRaw 的"更稳。 */
      d = Math.min(dAngle, dRaw);
    } else {
      d = dRaw;
    }
    /* ⚠️ 上界**不能**写成 `L1 + L2 - 1e-4`（这里原来就是这个余量）：
     * 近伸直处 A = acos(d/(2L)) 对距离是**开平方敏感**的 —— d 少 1e-4 就让
     * A = √(2×1e-4/(L1+L2)) ≈ 1.53°，即**弯曲角 3.1°**（实测值正是 3.1°）。
     * 下界保留 1e-4：d → |L1-L2| 时三角形退化（完全折叠），那是真的要防；
     * 上界 d = L1+L2 时 cosA 恰好为 1、A = 0，没有数值问题，
     * 浮点误差由下面 `clamp(cosA, -1, 1)` 兜住。 */
    d = clamp(d, Math.abs(L1 - L2) + 1e-4, L1 + L2);
    const cosA = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);   // 余弦定理
    /* ⚠️ 这里曾经写成 `Math.acos(clamp(-1, 1, cosA))` —— 参数顺序反了！
     * clamp 的签名是 `clamp(a, lo, hi)`，写成 clamp(-1, 1, cosA) 时 a=-1 恒小于 lo=1，
     * 于是**永远返回 1、A 恒为 0** → IK 从不弯关节，两段链永远伸得笔直指向目标：
     *   · 目标比臂展短时末端**冲过头**（站姿腕误差 0.135 就是这么来的）；
     *   · 目标比腿长时末端停在最大伸展处（踝误差 0.093）。
     * 也就是说"膝盖永远弯不了"的真正原因不是骨长饱和，而是这一行。
     * 正确写法是 clamp(cosA, -1, 1)。 */
    const A = Math.acos(clamp(cosA, -1, 1));

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
      // 兜底人形：只做轻微上下浮动，别让屏幕完全静止
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
      IK_CHAINS.forEach((c, ci) => {
        const [upName, loName, targetJoint, poleJoint, rootJoint] = c;
        const up = resolveBone(upName), lo = resolveBone(loName);
        if (!up || !lo) return;
        const tgt = jointTarget(j, targetJoint, sp);
        if (!tgt) return;
        const pole = poleJoint ? jointTarget(j, poleJoint, sp) : null;
        const engRoot = rootJoint ? jointTarget(j, rootJoint, sp) : null;
        /* targetJoint 的返回值是共享临时对象，IK 里会用到；先拷一份免得被后续
         * jointTarget 调用改写（同一个 _v1 缓冲区）。
         * ★ engRoot 也一并拷进 _ikEngRoot：它和 tgt/pole 是**不同的键**（不同对象），
         *   但保持"进 IK 前全部拷走"这个纪律，免得以后有人把键改成同一个就出事。 */
        solveTwoBoneIK(up, lo, _ikTarget.copy(tgt), pole ? _ikPole.copy(pole) : null,
          engRoot ? _ikEngRoot.copy(engRoot) : null);
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

  /* IK 链定义：[上段骨骼, 下段骨骼, 末端目标关节, 弯曲参考关节, **根关节**]
   * 左右仍是**交叉**对应（见文件头第 1 条）。
   * 末端目标选"踝/腕"（而不是脚趾/指尖）—— 它们是两段链的自然末端；
   * 脚掌/手掌再单独 aim 到趾/指尖。
   * Mixamo 命名：大腿 = UpLeg、小腿 = Leg；上臂 = Arm、前臂 = ForeArm。
   * ⚠️ 上臂的**父级是锁骨**（Shoulder），锁骨也走 aim（在 BONE_SEG 里），
   *    所以 IK 求根位置时锁骨已经摆好，顺序不能颠倒（applyPose 里 ③ 在 ④ 之前）。
   * ★ 第 5 项（根关节）是**后加的**，真机反馈「我手臂与腿是直的时候他的动作是弯的」
   *    就是靠它修好的：IK 要用**引擎自己的**肩/髋去算"引擎认为这根链弯了几度"，
   *    而 IK 的根位置用的是**模型自己的**肩/髋骨 —— 两者**不是同一个点**
   *    （实测模型肩比引擎肩目标偏 z 约 0.015），旧写法把"骨长比例差"混进了距离里。
   *    完整推导见 solveTwoBoneIK 里的长注释。 */
  const IK_CHAINS = [
    ["RightUpLeg", "RightLeg", "ankleL", "kneeL", "hipL"],
    ["LeftUpLeg", "LeftLeg", "ankleR", "kneeR", "hipR"],
    ["RightArm", "RightForeArm", "wristL", "elbowL", "shoulderL"],
    ["LeftArm", "LeftForeArm", "wristR", "elbowR", "shoulderR"]
  ];
  /* IK 之后需要重新 aim 的末端骨骼（手掌），用它们的"上一级 → 目标"方向。
   * ⚠️ 只有手掌，**没有脚掌** —— 见上面「为什么脚不瞄」。 */
  const IK_TAILS = { RightHand: 1, LeftHand: 1 };
  const _ikTarget = new THREE.Vector3(), _ikPole = new THREE.Vector3();
  // IK 专用缓冲（绝不与 aimBone 的 _v1/_v2/_v4 混用，见 solveTwoBoneIK 内注释）
  const _ikRoot = new THREE.Vector3(), _ikRoot2 = new THREE.Vector3(), _ikU = new THREE.Vector3();
  const _ikMid = new THREE.Vector3(), _ikDir = new THREE.Vector3(), _ikAxis = new THREE.Vector3();
  // 引擎侧（算关节内角用）+ 内角自己的临时量
  const _ikEngRoot = new THREE.Vector3(), _ikT1 = new THREE.Vector3(), _ikT2 = new THREE.Vector3();

  /* 关节内角的**系统偏差**：MediaPipe 的肘/膝关键点不落在"肩-腕 / 髋-踝"连线上，
   * 于是**真人完全伸直**时引擎报出来的内角本身就**不足 180°**。
   * 真值来自真实照片实测（`build/_probe-real-angle.js`，站姿四条链）：
   *     左臂 2.7° · 右臂 8.8° · 左腿 **11.6°** · 右腿 3.5°
   *   ⇒ 取上限 **12°**。（左腿偏差最大：膝关键点偏离髋-踝连线约 0.02 归一化。）
   * 做法是**减掉偏差**，不是硬死区 —— 硬死区在边界上会**跳变**
   * （引擎报 12.9° 就弯 12.9°、报 11.9° 就全直），孩子会看到腿突然弹一下。
   * 减偏差是连续的：引擎报 ≤12° 一律判直，报 20° 就弯 8°。 */
  const BEND_BIAS = 12 * Math.PI / 180;

  /* ★★ 已否决的设计：「伸直参考距离」（`IK_REF`）—— 留档，别再走一遍。
   *
   * 它想解决的问题（`build/_probe-squat-foreshorten.js` 实测）：
   *   引擎是**纯 2D** 的（`rawWorld()` 里 `_v1.set(..., ..., 0)`，z 恒为 0）。
   *   真人**正面下蹲**时膝盖往**相机方向**走 —— 在 2D 投影里膝盖仍落在"髋→踝"连线上，
   *   于是引擎报出的内角 **≈180°（看着是直的）**，只有"髋→踝投影变短"这一个线索。
   *   实测（`squat` 夹具，髋沉 0.10）：模型膝弯 **0.0°**、脚比目标**低 0.0606**；
   *   "只沉髋"变体低 **0.1101** —— 脚**穿到地面以下**，肉眼可见。
   *
   * 它的思路：记下"**引擎说这条链伸直**的那些帧里 `dEng × span` 出现过的最大值"，
   *   当作"这孩子这条链伸直时有多长"；下蹲时该值变小 ⇒ 比值 < 1 ⇒ 弯。
   *   合成夹具上**完全成功**：下蹲膝弯 60.3°、脚离地误差 0.0016（脚踩在地上），
   *   而"伸直"姿势连"腿短 30% 的孩子"都保持 0.0°。
   *
   * ★ 为什么**否决**（`build/_probe-real-jitter.js`，真实照片实测）：
   *   1. 关键点抖动 σ 最大 **0.0052~0.0065**（归一化；1σ ≈ 1.5 px @800）。
   *   2. "取最大值"这个估计量**天然偏高** —— 抖动是双向的，最大值总是抓到上偏那一侧。
   *   3. 把同一张**站着不动、绝对伸直**的照片喂 11 次（互相独立的关键点）：
   *      肘R 弯曲 = 0.0 / 0.0 / 9.7 / 4.2 / 13.0 / **24.0** / 9.5 / 0.0 / 22.2 / 0.0 / 9.4°，
   *      膝R **每一帧都 ≈10°**。合成夹具全绿（0.0°）而真实数据 10~24° ——
   *      正是硬规则 R2（"真实相机数据是唯一验收标准"）要抓的那种假阳性。
   *   4. 更关键：**参考偏高会直接制造弯曲**，方向正好是本轮要修的那个 bug
   *      （"我伸直它却弯"）。一个"估计偏了就往错误方向跑"的机制不能上线。
   *   ⇒ 整段回退，只保留纯角度法。
   *
   * 顺带记一条通用结论：`A = acos(d/(2L))` 对距离是**开平方敏感**的，
   *   所以**任何**基于"位置距离"的方法都会把抖动放大 —— 抖动本身就能造出 ~12° 的
   *   幻影弯曲。旧的"位置法"不是更好，它只是**从来没问过这个问题**。
   *   （旁证：`_probe-real-jitter.js` 用抖动 σ 解析估算出 **24.6°**，与端到端实测的
   *     24.0° 几乎一致 ⇒ 这个放大模型是对的。）
   *
   * ⚠️ 遗留的**已知、有界**局限（不修，因为 2D 传感器在信息上就看不到）：
   *   正面下蹲 / 朝相机方向抬腿，引擎报"伸直"⇒ 模型腿也伸直，脚按
   *   `Δy_hip × (1 − off/span)` 沉到地面线以下（实测 0.0606）。
   *   这是单目 2D 骨架的**原理性盲区**，不是 IK 的 bug。
   *   ⚠️ **唯一有希望的方向**（未实现、**必须先过真机 R0**，别直接抄）：
   *     在开场校准（孩子站定 1.5s，`POSE_HOLD_MS`）时**取均值**记下这孩子自己的
   *     "髋→踝"长度当基准（**均值**、不是最大值 —— 均值无偏，最大值天生偏高），
   *     之后用 `θ_eff = 2·acos(clamp(d/d基准, 0, 1))` 与地标角**取更弯的那个**；
   *     **必须配一个 ε 死区**（如 ε₀ = 2%）—— 因为 `2√(2ε)` 在 ε→0 处是无穷斜率，
   *     死区是唯一能压住"站着时幻影弯曲"的手段（1.5s×30fps 均值后噪声 ≈0.27% ≪ 2%）。
   *     腿链安全（"髋降、踝不动 ⇒ 腿必弯"是几何强制的）；**臂链别用**（手朝相机
   *     挥动也会缩短 ⇒ 会凭空弯）。完整推导见 `memory/2026-10-10.md`。 */


  /* 三点在中间点 b 处的**内角**（弧度）。伸直 = π。任一点缺失返回 null。 */
  function interiorAngle(a, b, c) {
    if (!a || !b || !c) return null;
    _ikT1.copy(a).sub(b); _ikT2.copy(c).sub(b);
    const l1 = _ikT1.length(), l2 = _ikT2.length();
    if (!(l1 > 1e-6) || !(l2 > 1e-6)) return null;
    return Math.acos(clamp(_ikT1.dot(_ikT2) / (l1 * l2), -1, 1));
  }

  /* ★★ 与 `interiorAngle` 同义，但**丢掉 z**（先把三点投到 x-y 平面）。
   *
   * 为什么 IK 的"弯多少"必须用这个、而不是 `interiorAngle`（2026-10-11 定案）：
   *   真机反馈「跟练模型会突然缩成一团、不如上一次准确」。根因量化见
   *   `build/_probe-z-bend.js`（用的是本文件导出的真函数，不是复刻）：
   *       肘上 15mm 的深度误差 → 引擎报 **假弯曲 8.3°**
   *       30mm → 16.5° ； 76mm → **39.7°** ； 151mm → 71.7°
   *   原因是几何上的：手臂近伸直时内角贴着 `acos` 的奇点，误差被**开平方放大**
   *   （`acos(1−ε) ≈ √(2ε)`）。而 Astra 在肘/腕/膝这类**细肢体**上的深度噪声
   *   加 D2C 对齐残差远超 15mm ⇒ 只要 z 参与内角，「伸直的手臂」**必然**被判成弯的
   *   ⇒ IK 照着弯 ⇒ 四肢往躯干折 ⇒「缩成一团」。`BEND_BIAS` 是常量，压不住。
   *
   * 所以职责重新划分：
   *   · **弯多少** ← 2D（与旧行为一致，也保住 `BEND_BIAS` 的标定；z 恒 0 时逐位相同）
   *   · **指向哪** ← 三维（target/pole 仍带 z，前后方向的动作照样看得出来）
   * 这不是"调参救 z"，是把"不该混的东西"分开。 */
  function interiorAngleXY(a, b, c) {
    if (!a || !b || !c) return null;
    const ax = a.x - b.x, ay = a.y - b.y;
    const cx = c.x - b.x, cy = c.y - b.y;
    const l1 = Math.hypot(ax, ay), l2 = Math.hypot(cx, cy);
    if (!(l1 > 1e-6) || !(l2 > 1e-6)) return null;
    return Math.acos(clamp((ax * cx + ay * cy) / (l1 * l2), -1, 1));
  }

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
     * 方便断言"喂了抬手数据 → 对应那只手真的抬高了"。
     * ⚠️ 键名是**模型骨骼名**（Mixamo 短名），不是引擎关节名 —— 这样断言能直接看出
     *    "交叉映射"有没有生效（引擎 wristL 应当驱动模型 RightHand）。
     * 含 `*Toe_End`：脚掌俯仰角（踮脚与否）只能靠"踝→趾尖"这条向量量出来，
     * 而脚掌骨骼本身**不在驱动表里**（见「为什么脚不瞄」），所以必须能直接读到它。
     *
     * ★ 另含 `RightFingertip` / `LeftFingertip`（**不是骨名**，是"腕子树里最远的骨"）。
     *   为什么必须有它：`RightHand` 是**腕**（骨 origin，也是手臂 IK 的末端，见 IK_TAILS /
     *   `__ikError()`）。拿"腕"当"指尖"去量构图边界会**系统性偏乐观** —— 少算一整个手掌
     *   （实测 ~45px），第一版 REACH_UP 就是这么错的（见文件头第 14 条）。 */
    __poseSnapshot: () => {
      const out = {};
      ["Hips", "Spine", "Spine2", "Neck", "Head", "HeadTop_End",
        "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
        "RightShoulder", "RightArm", "RightForeArm", "RightHand",
        "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "LeftToe_End",
        "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase", "RightToe_End"].forEach(n => {
        const b = resolveBone(n); if (!b) return;
        b.updateMatrixWorld(true);
        const p = new THREE.Vector3(); b.getWorldPosition(p);
        out[n] = [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)];
      });
      [["RightFingertip", "RightHand"], ["LeftFingertip", "LeftHand"]].forEach(([key, hand]) => {
        const tip = fingertipName(hand);
        const b = tip ? resolveBone(tip) : null;
        if (!b) return;
        b.updateMatrixWorld(true);
        const p = new THREE.Vector3(); b.getWorldPosition(p);
        out[key] = [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)];
      });
      return out;
    },

    /* 仅供诊断：拿骨骼对象本身（量蒙皮包围盒、读 rest 朝向都要用）。
     * 只读，不改状态 —— 别在测试里拿它去 setRotation。 */
    __bone: name => resolveBone(name) || null,

    /* 仅供诊断：把引擎关节（归一化坐标）换算成世界坐标，
     * 用来把"目标"和"实际到手的位置"并排打印 —— 误差到底是目标算错了还是驱动没跟上，
     * 只有并排看才分得清。 */
    __rawWorld: (joints, key) => {
      const j = joints || lastJoints;
      if (!j) return null;
      const v = rawWorld(j, key, bodySpan(j));
      return v ? [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)] : null;
    },

    __usingFallback: () => !!fallbackGroup,
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
      // 骨骼起点 ≈ 上一段的末端：小腿骨骼（Leg）的起点就是膝、脚骨骼（Foot）的起点就是踝
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
      probe("RightLeg", "kneeL"); probe("LeftLeg", "kneeR");
      probe("RightForeArm", "elbowL"); probe("LeftForeArm", "elbowR");
      return out;
    },
    __ikOn: () => USE_IK,
    /* 仅供测试：实测的模型尺寸与驱动参数（换模型后核对用）。
     * 断言"模型换了"就靠 metrics.height / lowestJointName / legStretch 这几个值。 */
    __modelMetrics: () => ({
      url: MODEL_URL,
      rawH: +RAW_H.toFixed(4),
      restLowest: +REST_LOWEST.toFixed(4),
      legStretch: LEG_STRETCH,
      measured: metrics ? {
        top: +metrics.top.toFixed(4), bottom: +metrics.bottom.toFixed(4),
        height: +metrics.height.toFixed(4), lowestJointY: +metrics.lowestJointY.toFixed(4),
        lowestJointName: metrics.lowestJointName
      } : null,
      boneCount: info.boneCount, skinnedCount: info.skinnedCount,
      /* 真·指尖骨名（腕子树里最远的骨，发现得来、非硬编码）与手臂链三段实测长度。
       * `armChain.hand` = 腕→中指尖 —— `restLen` 给不出它（restLen 的"手"是到**拇指**的
       * 距离，因为骨长定义是"到第一个子骨骼"），所以验收脚本要锚"手长"必须用这个。 */
      fingertip: fingertipName("RightHand"),
      /* 肩离地比例（rest 实测）。验收脚本算"手臂完全竖直时指尖能到多高"要用它 ——
       * 引擎 IDLE 的肩锚点换算是 0.7920，模型实测 0.7963，差 0.43%，取更高的那个才是真上界。 */
      shoulderFrac: shoulderFrac == null ? null : +shoulderFrac.toFixed(4),
      armChain: (() => {
        const c = armChainWorld();
        return c ? {
          upperArm: +c.upperArm.toFixed(4), foreArm: +c.foreArm.toFixed(4),
          hand: +c.hand.toFixed(4), tipName: c.tipName
        } : null;
      })(),
      restLen: Object.keys(rest).reduce((a, k) => { a[k] = +rest[k].len.toFixed(4); return a; }, {})
    }),
    __layoutFor: h => layoutFor(h),
    __layout: () => ({
      H: layout.H, footY: layout.footY, avail: layout.avail, top: layout.footY + layout.H,
      /* 当前生效的"举手过顶余量"与它的来源：兜底值 vs 模型实测值。
       * 验收脚本可以拿它断言"REACH_UP 真的是量出来的，不是那个错过的 0.1306"。 */
      reachUp: +REACH_UP.toFixed(4),
      reachUpMeasured: reachUpMeasured == null ? null : +reachUpMeasured.toFixed(4),
      rawH: +RAW_H.toFixed(4)
    }),
    __idleJoints: () => JSON.parse(JSON.stringify(IDLE_JOINTS)),

    /* 相机量测口（只读）。给 `_probe-yaw-view.js` 验"3/4 斜视角真的生效、
     * 且前后方向的动作确实变成了屏幕上的横向位移"用 ——
     * 这条判据必须拿**真的相机**去投影，自己复刻一份投影公式迟早漂移。 */
    __camera: () => camera ? {
      position: [camera.position.x, camera.position.y, camera.position.z],
      /* 正交相机的投影范围，测试拿它算 NDC→像素 */
      left: camera.left, right: camera.right, top: camera.top, bottom: camera.bottom,
      yawDeg: CAM_YAW_DEG, dist: CAM_DIST, bgDist: BG_DIST
    } : null,
    /* 直接借 three 的投影：传世界坐标，返回 { ndcX, ndcY }。
     * 比测试里手写矩阵稳（three 的投影约定改了就变了）。 */
    __project: (x, y, z) => {
      if (!camera) return null;
      const v = new THREE.Vector3(x, y, z).project(camera);
      return { ndcX: v.x, ndcY: v.y, ndcZ: v.z };
    },
    /* 把 IK 用的那个**内角函数**暴露出来（只读量测）。
     * `build/_probe-z-bend.js` 要拿**真函数**量化"z 误差 → 假弯曲角"，
     * 不能在测试里复刻一份余弦定理（复刻的迟早和实现漂移，也就验不出真问题）。
     * 入参是三组世界坐标 `[x,y,z]`，返回**内角**（弧度；伸直 = π）。 */
    __interiorAngle: (a, b, c) => {
      const A = new THREE.Vector3(a[0], a[1], a[2]);
      const B = new THREE.Vector3(b[0], b[1], b[2]);
      const C = new THREE.Vector3(c[0], c[1], c[2]);
      const t = interiorAngle(A, B, C);
      return t == null ? null : t;
    },
    /* 当前深度 z 开关状态（`?depthZ=1` 才是 true）。验收脚本要能断言"默认关"。 */
    __depthZOn: () => DEPTH_Z,

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
        // 名字解析结果：BONE_SEG 里哪些条目需要靠别名才找得到
        // （旧猫模型的 Head_1 后缀、本模型的 mixamorig 前缀，都是这个坑）
        aliased: Object.keys(BONE_SEG).filter(n => boneAlias[n]).map(n => n + "→" + boneAlias[n].name),
        unresolved: Object.keys(BONE_SEG).filter(n => !resolveBone(n))
      };
    }
  };
})();
