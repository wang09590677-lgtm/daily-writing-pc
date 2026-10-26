# 「自动开始下一项」影响评估报告（只读侦察，未修改任何产品文件）

范围：`daily-writing-pc`。基线：motion-browser-test 73 / accept-motion-autostart 36 / pose-calib-test 28 全绿。

---

## 0. 一句话结论

- **必挂 1 条**：`build/motion-browser-test.js:320`（`#motionReadouts .motion-readout` 数量 === 5）。新增进度 tile 后必挂。
- **条件挂 8 条**（是否挂取决于你把"自动结束/自动下一项"的触发线设多低）：`motion-browser-test.js:319/320/367/378/388/402/405`、`accept-motion-autostart.js:333/335/337`。
- **若只复用 `motionPrepAbort()` 而不把"取消自动下一项"接进 `motionFlowTeardown()`，则必挂 2 条**：`accept-motion-autostart.js:396`（切页）、`:450 + :458`（重开校准后"迟到的自动开跑"）。
- **不会拖垮回归**：现有 6 个测试都停在"单组"内（rep 目标=10 次、burst 目标=60 秒，采样窗口约 15 秒），不会自然走完多项；也不存在"连续跑多项"的场景。但注意 `motionPrepDisabled()` 只跳口令、**不跳"自动下一项"** —— 这既是性能保护（现有回归不会意外连续跑），也是设计缺口（见 §5）。

---

## 一、既有测试会被打断吗（逐条断言）

### 1.1 对 `#motionReadouts` / `mr-*` 数量或 id 列表的断言

| 位置 | 断言 | 是否挂 | 理由 |
|---|---|---|---|
| `motion-browser-test.js:317` | 采集 `> #motionReadouts .motion-readout` 文本 | 采集项，不挂 | 只是取数组 |
| `motion-browser-test.js:320` | `check("实时指标面板已渲染（计次类 5 项）", running.readouts.length === 5, ...)` | **必挂** | 该断言场景是 `rep` 模式（半蹲热身），当前 rep 恰好 5 个 tile；新增进度 tile 后变 6 |
| `motion-browser-test.js:350-354` | 分别读 `#mr-reps / #mr-tempo / #mr-amp / #mr-sym / #mr-cont` | 不挂（前提） | 只要你**保留**这 5 个 key 的 id 不变即可。**若你把进度做成替换 `mr-cont` / 复用旧 id，就会挂** |
| `pose-calib-test.js` | 无 | 不挂 | 全文无 `motionReadouts` / `mr-` 断言 |
| `accept-motion-autostart.js` | 无 | 不挂 | 无 readouts 断言 |
| `avatar-test.js` / `cat-avatar-test.js` / `accept-pose-vision.js` | 无 | 不挂 | 均不触碰读数区 |

**建议改法（三选一）**：
- A（推荐，改动最小）：进度数值**写入现有 tile**，不新增 div。rep 复用或改造 `mr-cont`（"连续"），burst/hold 同理 —— 但 `motion-browser-test.js:367` 依赖 `mr-reps` 的数值语义，别动 `reps`。
- B：新增独立容器（如 `#motionGoalProgress`，放在 `#motionReadouts` **之外**），`renderMotionReadouts()` 只加不改 tile 数量。这样 `:320` 仍为 5，**零改动**通过。
- C：若坚持加进 `motionReadouts` 内，必须同步改 `motion-browser-test.js:320` 为 `=== 6`。

> 另注意：`build/_rollback/` 下有一批旧版 app 副本（`app.keep.js` 等）也含 `renderMotionReadouts`，那是备份，不是活跃断言，无需处理。

### 1.2 断言"点开始后 running=true / 结束后 running=false"

| 位置 | 断言 | 判定 |
|---|---|---|
| `motion-browser-test.js:321` | `running.previewing === false`（点开始 1.2s 后） | 挂**仅当**半蹲热身在这 1.2s 内就达标（不可能，reps=0）；正常不挂 |
| `motion-browser-test.js:367` | `liveReps >= 4 && liveReps <= 15`（跑 13s 后） | **条件挂**：若自动结束的达标线 ≤15 次，半蹲（目标 10 次）会在窗口内自动结束并把计数器 reset，读数变 0 → 失败 |
| `motion-browser-test.js:378-405` | 点 `motionFinishBtn` 后：写入 1 条记录 / reps>=4 / exId=halfSquatWarm / 结束按钮回到禁用 | **条件挂**：若此前已自动结束，引擎已 `resetCounters()`，`:378` 点结束会拿到空快照 → 记录丢字段 |
| `motion-browser-test.js:402` | `scored.finishDisabled`（评分后结束按钮禁用） | 不挂（自动下一项起步前会再次置 false，见 §1.3） |
| `accept-motion-autostart.js:333` | `started.running === true && started.previewing === false`（数完口令后） | 正常不挂（口令后立即开跑，此时未达标） |
| `accept-motion-autostart.js:422-428` | 前置状态 `running===true && previewing===true`（校准退出、未开跑） | 不挂（preview 态） |

### 1.3 断言按钮 disabled 状态

| 位置 | 断言 | 判定 |
|---|---|---|
| `motion-browser-test.js:319` | `startText==="进行中…" && startDisabled && !finishDisabled` | 挂**仅当** 1.2s 内自动结束时；正常不挂（`motionStartSetNow` 后 running=true、finish 非禁） |
| `accept-motion-autostart.js:335` | `startText==="进行中…" && startDisabled===true` | 同上一行，正常不挂 |
| `accept-motion-autostart.js:337` | `finishDisabled === false` | **条件挂**：若"自动下一项"把按钮复位成"开始这一组"且禁用 finish 的时刻**恰好**落在这条 evaluate 上，会读成 true（时序竞态） |
| `accept-motion-autostart.js:273` | 口令期间 `startDisabled===true && startText==="准备中…"` | 不挂（这是 prep 期，与自动下一项无关） |
| `pose-calib-test.js:100/101/306`、`motion-browser-test.js:182/204/240/268/272` | 校准/未开摄像头的 startDisabled | 不挂（与自动下一项无交集） |
| `accept-no-file-access.js:67` | startDisabled | 不挂 |

### 1.4 断言 `motionChoice` 不变 / 依赖"始终停在同一个动作"

| 位置 | 断言 | 判定 |
|---|---|---|
| `accept-motion-autostart.js:288-295` | 口令念的就是"当前选中动作"（读全局 `motionChoice` 与 `ready-<exId>.mp3`） | 不挂（单组场景，中途无自动换项） |
| `motion-browser-test.js:395` | `scored.rec.exId === "halfSquatWarm"` | **条件挂**：若 `saveMotionRecord` 之后 `setMotionChoice(next)` 先于 `:378` 的"结束并评分"落库，会取到下一个动作的 id。取决于你的实现顺序 |
| `motion-browser-test.js:305` | 选中半蹲热身 | 不挂（选择发生在开始前） |

**结论**：现有测试**没有**"断言 motionChoice 永远不变"的硬断言，但有 2 处**隐式假设停在当前动作**（`:395`、以及 `:367` 的计数窗口）。

### 1.5 会跑"多个动作"并在中间手动点"结束并评分"的测试

| 位置 | 场景 | 是否会被自动下一项干扰 |
|---|---|---|
| `accept-motion-autostart.js:347-358`（第 5 节） | **先 `motionFinishBtn.click()` 结束本组，再点 `motionStartBtn`，验证手动入口仍走口令** | 会干扰：这是最危险的一条。若 `motionFinishBtn` 触发后立即"自动下一项"→ `motionStartSet()`（口令 ~8s），那么脚本紧接着 300ms 后点 `motionStartBtn`：此时 `motionPrep` 非空，`motionStartSet` 直接 `return`，但 `manual.prepping` 仍会是 true（自动那条已把 prep 打开）→ **`:360` 反而通过**；真正风险是下一节 |
| `accept-motion-autostart.js:362-371`（重入保护） | 口令期间连点两次开始，断言 `ready-*.mp3` 只播 1 次 | **会干扰**：若自动下一项与手动在 400ms 内叠出第二条口令流，可能计到 2 条 → `:371` 失败。你的实现必须保证"自动下一项"与"手动开始"共用 `motionPrep` 单例锁（现有 `motionStartSet()` 已用 `if (motionPrep) return` 兜底，复用它是安全的） |
| `accept-motion-autostart.js:373-398`（第 6 节会切页） | 口令念到一半切页 | 见 §1.6 |
| `motion-browser-test.js` | 只在 `:307` 点 1 次开始、`:378` 点 1 次结束，**无多动作** | 不干扰（单组） |

### 1.6 打断类断言（与 §三 直接相关）

| 位置 | 断言 | 判定 |
|---|---|---|
| `accept-motion-autostart.js:382` | 切页前 `prepping===true`（前置） | 正常不挂 |
| `accept-motion-autostart.js:396` | 切页后 `prepShown===false` | **必挂（若自动下一项定时器没接进 teardown）**：`setView` 只调 `motionFlowTeardown()`→`motionPrepAbort()`，若不额外取消"自动下一项"，稍后定时器会重新开 prep，界面又弹出来 |
| `accept-motion-autostart.js:398` | 切页后摄像头关闭 | 不挂（`motionStopCamera` 仍在） |
| `accept-motion-autostart.js:438` | 重开校准前 `prepping===true`（前置） | 正常不挂 |
| `accept-motion-autostart.js:450` | 重开校准后 `prepping===false && shown===false` | **必挂（同上）**：`motionCalibOpen` 若没取消自动下一项，会在校准中重新弹 prep |
| `accept-motion-autostart.js:458-459` | 等过口令时长仍 `previewing===true && prepping===false`（无"迟到的自动开跑"） | **必挂（同上）**：这正是本项目历史踩坑，自动下一项是同类风险 |

---

## 二、自动下一项会不会拖垮回归（性能）

### 2.1 现有测试的实际时长（来自运行日志）

- `build/_motion-run.log`：73/73 PASS，含 `sleep(1200) + sleep(13000) + 8×sleep(500)轮询 + sleep(900)` 等，单条命令能跑完（未 SIGTERM）。
- `build/_autostart-run.log`：36/36 PASS，含两处 ~7s 口令等待 + 主链路 MediaPipe 加载。

### 2.2 判定：不会意外连续多项

逐一核对每个测试会点几次开始：

- `motion-browser-test.js`：`?motionPrep=0` 下 `:307` 点 1 次开始 → `:378` 点 1 次结束。**单组**。
- `accept-motion-autostart.js`：第 4 节锁定自动开 1 组；第 5 节点结束 + 点开始（第 2 组，但立即被第 6 节切页打断）；第 6 节重开校准不进入开跑；第 7 节主链路仅验证"进入准备"不跑到结束。**没有一路跑到多组结束的场景**。
- `pose-calib-test.js`：只到"自动进入准备开练"（`:221`），不进正式计时。
- `avatar-test.js` / `cat-avatar-test.js` / `accept-pose-vision.js`：只开摄像头 + 直接调 `MotionAvatar`，不点开始。

**为什么不会自然走完多项**：
- 半蹲热身 `goal.reps = 10`（`data/fitness-plan.js:249` 的 target=10；运行日志确认"本组目标：10 次"）。
- 测试在 `:367` 处只跑到约 9 次（日志："数到 9 次"）→ **差 1 次未达标**，autofinish 不会触发。
- burst 类目标 60 秒（日志："连续动 60 秒"），远大于测试窗口。
- 结论：**既有回归里没有任何场景会连续触发多项**，单条命令不会从 ~40s 膨胀到几分钟。

### 2.3 结论与红线

- **好消息**：`?motionPrep=0` 让 `motionStartSet()` 走 `motionStartSetNow()` 短路（`app.js:2983`），第一组零口令；且目标未达标 → 不会 autofinish → 不会自动进第二组。回归时长基本不变。
- **红线**：一旦自动下一项落地，**"第 N+1 项起的口令"没有任何开关能跳过**（`motionPrepDisabled` 只作用于 `motionStartSet` 的入口，`motionStartSetNow` 是直通）。若将来某个测试真的跑完一组并进入第二组，就必然多等 ~8 秒/项。
  - **建议**：新增一个独立的"自动下一项"总开关（URL 参数，如 `?motionAutoNext=0`），或在 `motionPrepDisabled()` 为真时让"自动下一项"也走 `motionStartSetNow()` 直通。这样测试既能验证自动推进、又不被口令拖慢。
  - 另外需自查：半蹲目标=10、实测 9 次，**只差 1 次**。若你的新功能把"达标判定"放宽（例如 ≥90% 即算达标、或把目标取整），`motion-browser-test.js` 会在 13s 窗口内触发 autofinish，直接连锁挂掉 `:319/:320/:367/:378/:388/:402/:405`。**达标阈值必须不碰"9/10=90%"这条线，或同步改测试**。

---

## 三、"迟到的定时器"风险点清单（应接"取消自动下一项"的位置）

本项目硬规则：凡"延时后改变主状态"的流程必须留 abort 并把所有打断点接上。现有 `motionPrepAbort()`（`app.js:2935`）接在 3 处。自动下一项是**同类风险**（`setTimeout` 后会自动 `motionStartSet()`），必须同样接上。

### 3.1 必须接（阻断自动下一项）

| # | 打断点 | 行号 | 现状 | 应做 |
|---|---|---|---|---|
| 1 | `motionFlowTeardown()` | `app.js:3042-3045` | 只 `motionPrepAbort()` + `motionCalibClose(false)` | **在此追加"取消自动下一项"** —— 它是切页与关摄像头的公共收敛点，一处接上即可覆盖 #2/#5 |
| 2 | 切页 `setView()` | `app.js:4219`，调 teardown 在 `:4225`（`if viewId!=="fitnessMotion"` → `motionFlowTeardown()` + `motionStopCamera()`）；`backToChooser()` `app.js:3917` 走 `motionStopCamera` | 经 teardown 覆盖 | 接 #1 即覆盖 |
| 3 | 关闭摄像头 `motionStopCamera()` | `app.js:2860`，`:2862` 调 teardown | 经 teardown 覆盖 | 接 #1 即覆盖 |
| 4 | `motionResetSet()`（重来） | `app.js:3118-3129`，`:3120` 已 `motionPrepAbort()` | 已有 prep abort | **追加取消自动下一项**（否则"重来"后几秒自动开跑，与注释 `:3119` 描述的坑同类） |
| 5 | `motionStopSet()` | `app.js:3131-3139` | 无 abort | **追加取消自动下一项**（它被 `setMotionChoice`、`motionResetSet`、`motionStopCamera` 调用，是"停止一组"的语义中心） |
| 6 | `motionCalibOpen()`（重开校准） | `app.js:3316-3347`，`:3322` 已 `motionPrepAbort()` | 已有 prep abort | **追加取消自动下一项**（`accept-motion-autostart.js:450/458` 就守这条） |
| 7 | `setMotionChoice()`（重新选动作） | `app.js:3232-3244`；`:3235` 仅当 `motionRunning` 调 `motionStopSet(true)` | 无 abort；预览态下换动作不经过 stop | **显式追加取消自动下一项**（预览态换动作时 `motionRunning===false`，不会走到 stop） |
| 8 | 「我准备好了，直接开始」`posePrepSkip` | `app.js:5909-5914`，`:5911` `motionPrepAbort()` 后 `motionStartSetNow()` | 已有 prep abort | 追加取消自动下一项（避免"跳过"后旧定时器再开一次） |

### 3.2 建议接（防御性）

| # | 位置 | 行号 | 说明 |
|---|---|---|---|
| 9 | `beforeunload` | `app.js:5962-5963`（`stopAudio(); motionStopCamera();`） | 经 `motionStopCamera`→teardown 覆盖，接 #1 即可；无需单独写 |
| 10 | 家长关闭体感开关 | `app.js:3868`（`if (!state.fitness.motion.enabled) motionStopCamera()`） | 经 teardown 覆盖，接 #1 即可 |
| 11 | 相机切换（change 事件） | `app.js:5893`（`if (motionStream) { motionStopCamera(); await motionToggleCamera(); }`） | 经 `motionStopCamera` 覆盖，接 #1 即可 |
| 12 | 「跳过校准」按钮 | `app.js:5896-5899` | 经 `motionFlowTeardown()` 覆盖，接 #1 即可 |
| 13 | `visibilitychange`（切标签页/最小化） | **不存在** | 项目当前**没有**监听 `visibilitychange`；若你希望"孩子切走标签页就取消自动下一项"，需新增监听（现有行为并不如此，属可选增强） |

**最小接入方案**：新增 `motionAutoNextAbort()`，并在 **`motionFlowTeardown()`（#1，覆盖切页/关摄像头/beforeunload/家长开关/换相机/跳过校准）+ `motionResetSet()`（#4）+ `motionStopSet()`（#5）+ `motionCalibOpen()`（#6）+ `setMotionChoice()`（#7）** 五处调用。其中 #5 被 #4/#7 复用，实际可能需要显式补的只有 #1/#4/#6/#7。

---

## 四、进度读数该显示什么（数据可得性确认）

### 4.1 `goal` 三字段是否互斥 —— **是，互斥**

证据（`app.js:2388-2409` `motionGoalFor`）：

```js
if (p.mode === "hold")  return { holdSeconds: sec, label: `保持 ${sec} 秒` };   // 只有 holdSeconds
if (p.mode === "burst") return { seconds,          label: `连续动 ${seconds} 秒` }; // 只有 seconds
// rep 分支
return { reps, label: ... };                                                    // 只有 reps
```

三条 `return` 互斥，**每个 goal 只带一个数值字段**。`motion-engine.js:2969` 的注释也写明契约：`goal: { reps } | { seconds } | { holdSeconds }`。

**但有一个坑**：`motionFinishSet()` 里 `app.js:3075` 写的是
```js
target: goal.reps || goal.seconds || goal.holdSeconds || 0,
```
这是**顺序兜底链** —— 说明既有的"取目标值"惯例不是先判 mode，而是"哪个有取哪个"。你实现读数时**不要**照抄这行（rep 的 goal 里没有 seconds/holdSeconds，抄了也能跑，但 burst/hold 分支会先撞 `goal.reps===undefined` 再回落，逻辑上对、可读性差）。**建议先判 `p.mode`，再取对应字段**，与 `renderMotionLive`（`app.js:3683-3691`）的既有写法保持一致。

### 4.2 `st.elapsed` 是否含口令等待时间 —— **不含（当前）/ 会含（若复用引擎）**

证据（`motion-engine.js`）：

```js
// :2870 start() —— 正式计时重置 elapsed 并重设起点
function start(){
  ...
  resetCounters(wasRunning, true);   // 内部 elapsed = 0（:2826）
  previewing = false; running = true;
  startedAt = performance.now();     // 起点=开跑这一刻
  ...
}
// :2860 preview() —— 预览态
function preview(){ ...; startedAt = performance.now(); ... }
// :2881 pause() —— 结束后回预览
function pause(){ resetCounters(true, true); previewing = true; startedAt = performance.now(); ... }
// :2667 loop()
const now = (performance.now() - startedAt) / 1000;   // elapsed 相对起点
elapsed = now;
// :2674 预览态直接 return，不累加 elapsed
```

**当前行为**：口令期间引擎处于 `previewing`（预览态），`loop()` 在 `:2674` 直接 return，**不更新 elapsed**；`start()` 又把 `startedAt` 重置为开跑时刻。所以 **elapsed 现在不含口令时间，也不含校准时间**。

**你引入自动下一项后必须注意**：`motionStartSetNow()`（`app.js:2945`）内部会 `motionEngine.setProfile(p)` → `resetCounters(true)` 清零，随后 `motionEngine.start()` 重置 `startedAt`。**只要"自动下一项"走的是 `motionStartSetNow()`（经过 `motionStartSet()` 口令），elapsed 就天然不含口令等待**，burst 的"有效运动秒数"不会虚高。

**唯一会出问题的情况**：若你为了省 8 秒口令，改成"不重开口令、只 `setProfile + resetCounters` 连续计数"，那就必须**显式调用 `start()`（或手动重置 `startedAt`）**，否则 `startedAt` 还停在上一次的起点，elapsed 会把上一组+口令+间隙全算进来，burst 严重虚高。

### 4.3 burst 用 `activeRatio(6) * elapsed` 在长时间（60s）会不会漂移 —— **会漂移，且会系统性失真**

证据：

```js
// motion-engine.js:416
function activeRatio(seconds){
  const raw = signalWindow("motion", seconds);      // 只取最近 seconds 秒
  if (!raw.length) return 0;
  const thr = Math.max(0.0008, mean(raw) * 0.45);   // 自适应阈值：这一段自己的均值 *0.45
  let n = 0; for (...) if (raw[i] > thr) n++;
  return n / raw.length;                            // = 近 6 秒里"动"的帧占比
}
// :2460 signalWindow —— 从队尾往前取，series 只保留最近 MAXSEC=30 秒（:364/:2456）
// :476 getState().activeRatio = activeRatio(6)
// :3687 percent = (st.activeRatio || 0) * (st.elapsed || 0) / goal.seconds * 100
```

**判断：会漂移，且是"自适应阈值"导致的非线性失真，不只是四舍五入误差。**

理由：
1. `activeRatio(6)` 是**"近 6 秒"的瞬时占比**，而 `elapsed` 是**开跑至今的累计秒数**。两者相乘 = "用当前 6 秒的活跃率去乘整个历史时长"，本质是**把瞬时量当全程量积分**。
2. 更糟的是阈值是**自适应**的：`thr = mean(最近6秒) * 0.45`。孩子中途停下来喘气 → 这 6 秒均值下降 → 阈值下降 → 噪音反而被判成"动" → 停顿时占比不降反升。反之运动越剧烈、均值越高、阈值越高，占比被压低。
3. 后果（60 秒场景）：
   - 先猛动 20 秒（占比 ~0.9）再慢下来 → 后面 40 秒占比被高估 → 总"有效秒数"虚高，可能提前到 60 秒。
   - 匀速但幅度渐小 → 阈值随均值下滑，占比失真 → 读数与真实不符。
4. 与"计数/保持"不同：`reps` 是**单调累加**（`repCounters`），`holdSeconds` 是**逐帧累积 dt**（`:2553 holdSeconds += dt`），两者都不会漂移；**只有 burst 的这条派生公式会**。

**建议**：若要显示 burst 的"有效运动秒数"，应改为**引擎内单调累积**（与 `holdSeconds` 同构，例如新增 `activeSeconds += dt * (live.motion > thr ? 1 : 0)`，阈值用固定下限而非 6 秒自适应），而不是在 UI 层用 `activeRatio(6)*elapsed` 现算。否则读数会"忽快忽慢、走得比真实快"，孩子会以为自己在偷懒或在超常发挥。若不改引擎，至少应用"每帧取 `min(dt, ...)` 累加"的方式在 `renderMotionLive` 里自己累积一个稳定计数器。

---

## 五、需要同步修改的测试断言清单（只列清单，不改文件）

### 必改（1 条）

1. `build/motion-browser-test.js:320` —— `running.readouts.length === 5` → 若把进度 tile 加进 `#motionReadouts` 则改 `=== 6`；**更推荐改用 §1.1 方案 B**（进度放 `#motionReadouts` 之外），此条零改动。

### 视设计需改（8 条，取决于"达标线 / 自动结束时机 / 自动换项顺序"）

2. `build/motion-browser-test.js:319`（开始后按钮状态）—— 若达标线 ≤9/10，会被中途 autofinish 打断
3. `build/motion-browser-test.js:367`（`reps 4~15`）—— 同上，autofinish 会清零计数
4. `build/motion-browser-test.js:378`（点结束并评分的采样点）—— 若已自动结束，取到空快照
5. `build/motion-browser-test.js:388`（`finishDisabled`）—— 自动下一项起步会重开 finish
6. `build/motion-browser-test.js:395`（`rec.exId==="halfSquatWarm"`）—— 若换项先于落库
7. `build/motion-browser-test.js:402`（结束后 finish 禁用）—— 同 5
8. `build/motion-browser-test.js:405`（自动勾选清单）—— 若落库时机变了
9. `build/accept-motion-autostart.js:333/335/337`（数完口令后 running/按钮）—— 自动下一项的按钮复位竞态

### 必改（若打断点没接全，2 处 3 条）

10. `build/accept-motion-autostart.js:396`（切页后 prep 收起）—— 需 §三 #1 接上
11. `build/accept-motion-autostart.js:450` 与 `:458`（重开校准作废 / 无迟到自动开跑）—— 需 §三 #6 接上

### 建议新增（不是改，是补）的回归断言

12. 新增"自动下一项"正向用例：跑完一组 → 断言自动进入下一项 prep（`prepping===true` 且 `motionChoice.exId` 已切换）。
13. 新增"迟到的自动下一项"反向用例：自动推进的等待期内切页/重开校准/换动作 → 等过等待时长后断言 `prepping===false && previewing===true`（照抄 `accept-motion-autostart.js:455-459` 的写法）。
14. 新增读数 tile 断言：断言进度数值随 reps/秒数变化，且 rep 模式下 `12 / 30 次` 格式正确。

### 不需要动（3 个测试文件）

- `build/pose-calib-test.js`（28 项）：只到"进入准备"，不碰读数区、不点开始。
- `build/avatar-test.js` / `build/cat-avatar-test.js`：只验 3D 模型与接口，不碰体感读数。
- `build/accept-pose-vision.js`：只验感知链路与骨架。

---

## 六、给你实现时的 4 条硬性提醒

1. **自动下一项必须共用 `motionPrep` 单例锁**（`app.js:2976 if (motionPrep) return`），否则会与手动开始叠出第二条口令流，挂 `accept-motion-autostart.js:371`。
2. **达标阈值不要落在 90%**：半蹲 9/10 恰好卡边界，放宽到 ≥90% 会连锁挂掉 motion-browser-test 的 8 条断言。
3. **`saveMotionRecord` 之后、`setMotionChoice(next)` 之前要有稳定的采样窗口**：至少让"结束并评分"的落库先于换项完成，否则 `:395` 会取到下一个动作。
4. **burst 有效秒数别用 `activeRatio(6)*elapsed`**：会漂移失真（§4.3），改引擎内单调累积。
