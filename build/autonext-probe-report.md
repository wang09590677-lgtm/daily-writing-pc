# 达标自动完成 + 自动休息 + 自动下一项：链路实测诊断报告

> 只读侦察。**未修改任何生产文件**（`app.js` / `motion-engine.js` / `motion-avatar.js` / `styles.css` / `index.html`）。
> 临时探针脚本：`build/_probe-recon.js`、`build/_probe-autonext.js`、`build/_probe-autonext-de.js`、`build/_probe-autonext-f.js`；原始输出：`build/_probe-autonext.log`、`build/_probe-autonext-de.log`、`build/_probe-autonext-f.log`；截图：`build/shots/autonext-rest.png`、`autonext-layering.png`、`autonext-fixed.png`。
> 环境：真实 Chrome + 合成 Y4M 假摄像头（人形横向开合喂 `开合跳` 的 `width` 信号），日期冻结到 **2026-10-01 周四 = 速度爆发日**（`data/fitness-plan.js:274`，开合跳 `thu:main:0` 目标 **20 次**，后面还有下一项 `highKnees`）。全程串行，无并行 Chrome，无代理。

---

## 0. 一句话结论

**链条在第一环之后、休息内部断掉。**

- ✅ 达标闸门**正常**：`progressPercent` 会自然到 100，`motionAutoComplete("reached")` 会被**真的调用**，`motionFinishSet()` 也**真的执行**（打分落库一条记录、全屏层收起、页面显示「完成！」）。
- ✅ 休息计时**进入了**：`motionStartRest(10, next)` 被调用，1 秒 `interval` 真的在跑，`motionRestLeft` 内部确实从 10 递减到 0 再变负。
- ❌ **但休息倒计时不会更新显示、休息结束也不会推进下一项。** 元凶是 `motionStartRest` 里逐秒 tick 的第一行守卫：

  ```js
  // app.js:3178
  if (!motionAutoNext) return;   // ← 休息期间 motionAutoNext 恒为 null → 每次都提前返回
  ```

  这个守卫的本意是「已被 `motionAutoNextAbort()` 取消」，但**进入休息时从来没有人给 `motionAutoNext` 赋值**（它唯一的赋值点 `motionAutoAdvance()` 恰恰是被这个守卫挡住的下一步）。于是：`renderMotionProgress()` 不刷新（倒计时数字**冻在「休息 10 秒」**）、`motionAutoAdvance(next)` **永不执行**。
- ❌ 结果：`motionRestLeft` 会一路变成 **-5、-6…永远不会回到正数**，`setDone` 一直挂着 `jumpingJacks`，`motionChoice.exId` 永远是 `jumpingJacks` —— **休息完不自动进下一项，正是用户看到的现象**。

**实测凭证**（`_probe-autonext-de.log`，E 段，自然达标后连观察 15 秒）：

```
restLeft 系列 : 10,9,9,8,8,7,7,6,6,5,5,4,4,3,3,2,2,1,0,0,-1,-1,-2,-2,-3,-3,-4,-4,-5,-5
页面内倒计时文本（去重）  : ["休息 10 秒"]        ← 冻结在 10，从不刷新
全屏层倒计时文本（去重）  : ["休息 10 秒"]
休息结束后 motionChoice   : "jumpingJacks"        ← 没有切到 highKnees
final running             : true
```

对照实验（`_probe-autonext-f.log`，**仅在页面运行时内 monkey-patch `motionStartRest`**，不写回生产文件）：

```
restLeft 系列 : 10,9,9,8,8,7,7,6,6,5,5,4,4,3,3,2,2,1,1,0
页面内倒计时  : 休息 10 秒 → 9 → 8 … → 1 → 0 → 下一项 "0.1 / 20.0 秒"
全屏倒计时    : 同上，且休息期间 avatarVisibleDuringRest = true
ADVANCED      : choice 由 jumpingJacks → highKnees，running=true，previewing=false  ← 自动进下一项成功
```

→ **修 `motionStartRest` 的那一行守卫，整条链路立刻通。** 全文无控制台报错，无 pageerror。

---

## 1. 链路上每一环的实测结果

| # | 环节 | 代码 | 实测结果 | 判定 |
|---|------|------|---------|------|
| 1 | 选中「开合跳」 | `motionChoices()` / `motionGoalFor()` | `{exId:"jumpingJacks", target:20, blockId:"thu:main:0", goal:{reps:20}, restSeconds:10}` | ✅ 正常 |
| 2 | 点开始 → 正式计时 | `motionStartSetNow()` | `previewing=false, running=true`，全屏猫层显示 | ✅ 正常 |
| 3 | 实时统计 `st.reps` 递增 | `renderMotionLive` | `percent` 5→10→20→35→50→60→75→85→**100** | ✅ 正常 |
| 4 | `progressPercent` 被赋值 | `app.js:4001-4022` | 环形块条件 `ring && motionChoice && !st.previewing` 成立，`progressPercent` 随 `st.reps` 增长 | ✅ 正常（**不是断点**） |
| 5 | 达标闸门触发 | `app.js:4032-4034` | `setDone:"jumpingJacks"` 被写入，`motionAutoComplete("reached")` 被调用 | ✅ 正常（**不是「没人调」**） |
| 6 | `motionAutoComplete` 内部 | `app.js:3103-3135` | 打分落库 1 条（exId=jumpingJacks）、`fitBeep(2)`、找到下一项 `highKnees`、`rest=10` | ✅ 正常 |
| 7 | `motionFinishSet` 打分 + 收起全屏层 | `app.js:3232-3240` | 记录写入 localStorage；`motionAvatar` 变 `hidden`（`display:none`）；页面内显示「完成！」 | ✅ 按设计 |
| 8 | `motionStartRest` 启动 | `app.js:3174-3190` | `motionRestLeft=10`；`setInterval` 已建立（`motionRestTimer` id 非 0，实测 =36） | ✅ 进入了 |
| 9 | 休息逐秒刷新 + 归零推进 | `app.js:3177-3186` `tick()` | **`tick()` 首行 `if (!motionAutoNext) return;` 每次早退** → 不刷新、不推进；`restLeft` 一路变负 | ❌ **断在这里** |
| 10 | `motionAutoAdvance(next)` | `app.js:3207-3230` | 从未被调用 | ❌ 未执行（被第 9 环挡住） |
| 11 | 切到下一项 / 重新开跑 | `setMotionChoice` / `motionStartSetNow` | `motionChoice.exId` 恒为 `jumpingJacks`，未变成 `highKnees` | ❌ 未执行 |

**结论：不是「没人调 `motionAutoComplete`」，也不是 `progressPercent` 到不了 100。断点在 `motionStartRest` 内部的 tick 守卫。**

---

## 2. 三处可疑点的逐一验证

### 可疑点 1 — 「`?motionAutoNext=0` 拦不住清零」：**部分确认，但属预期，不是本次故障原因**

- 因果链确认：`motionAutoComplete()` 先 `motionFinishSet()`（内 `motionEngine.pause()` → `resetCounters()` 把 `reps/holdSeconds/activeSeconds` 清零），**之后**才 `if (motionAutoNextDisabled()) { motionSayDone("item"); return; }`（`app.js:3117-3120`）。所以清零确实发生在开关判断之前。
- 但实测（`_probe-autonext.log` C 段，URL `?motionPrep=0&motionAutoNext=0`）证明**开关本身有效**：
  ```
  autoNextDisabledFlag : true
  restLeftAfter        : 0        ← 不进入休息
  autoNextPending      : false
  scores               : {count:1, lastReps:2, lastExId:"jumpingJacks"}   ← 成绩照常落库
  ```
  也就是说 `?motionAutoNext=0` 确实关掉了「自动下一项」，只是**不能**阻止「结束本组必然带来的计数清零」（那是 `pause()` 的固有语义，不是 bug）。
- 结论：**确认现象、推翻因果关系**。清零不是故障，也不需要修；`motionAutoNext=0` 作为「只测自动推进」的开关是可用的。

### 可疑点 2 — 「全屏 3D 层被收掉，休息倒计时看不见」：**确认（含一处澄清）**

- `motionFinishSet()` 在 `app.js:3240` 调 `MotionAvatar.hide()` → `motion-avatar.js:702` 给容器加 `hidden` 类，`motion-avatar.js:705` 又 `setProgress(null)` 把面板也隐藏。
- 实测（`_probe-autonext-de.log` E 段）：达标瞬间 `motionAvatar.hidden = true`、`display:none`；`#motionAvatarProgress` 虽然自身 `hiddenClass=false`，但其祖先 `.motion-avatar` 是 `display:none` → **孩子看不到全屏层上的倒计时**（我探针里的 `apVisibleToChild=false`）。
- 澄清：页内那份 `#motionGoalProgress` **是可见的**（`display:block`、无隐藏祖先，`gpVisibleToChild=true`），而且面板文案就是「休息 N 秒」。
  - 但它是**页面里的小字**（`styles.css:1464` 起，`min` 无放大），而体感跟练的设计场景是孩子站在 **2–3 米外**，全屏猫层才是他真正能读的唯一通道（这是 `motion-avatar.js:390-393` 注释里写明的设计意图）。全屏层一收，远处孩子就只剩一句话也看不清的小字。
  - 雪上加霜：因为第 9 环的 bug，这行小字还**冻结在「休息 10 秒」不刷新**。
- 结论：**确认**。全屏层在休息期间是隐藏的，孩子（按设计站在远处）看不到可读的倒计时；修复要同时解决「让全屏层在休息期间可见」+「让它的数字刷新」。

### 可疑点 3 — 「口令层 `.pose-prep` 被猫层 `.motion-avatar` 挡住」：**确认**

- 静态：`styles.css:1826` `.pose-prep { z-index: 96 }`，`styles.css:1378` `.motion-avatar { z-index: 100 }` → 猫层更高。
- 实测（`_probe-autonext-de.log` D 段，同时显示两层）：
  ```
  avatarZ=100 display=block ; prepZ=96 display=flex ; prepCountText="3"
  elementFromPoint(屏幕正中) = CANVAS          ← 命中的是猫层的 canvas
  centerHitsAvatar=true , centerHitsPrep=false
  「数 3」那个大字位置的命中元素 = CANVAS       ← 连数字本身都被猫层盖住
  ```
- 结论：**确认**。自动进下一项时若全屏层仍可见（这正是可疑点 2 的修复方向），`.pose-prep` 的「准备开始进行XX + 3/2/1」会被猫层完全遮住，孩子只能**听到**口令、看不到倒计时大字。

---

## 3. 修复建议（具体到文件 + 行号）

### 修复 A（**必须**，主因）— `app.js:3174-3190` `motionStartRest`

问题：逐秒 `tick()` 的守卫把「正常休息」误判成「已被取消」。

改法：**进入休息时先占住 `motionAutoNext` 这个把手**（休息本身就是一种「排着的自动动作」，占用它是语义正确的），取消权继续交给既有的 `motionAutoNextAbort()`。

```js
// app.js:3174  改后
function motionStartRest(seconds, next) {
  motionRestLeft = seconds;
  /* 占住把手：休息也是"排着的自动动作"。
   * 不占的话，下面 tick 的 `if (!motionAutoNext) return;`（本意"被 abort"）
   * 会把正常休息当成已取消 → 倒计时不刷新、结束也不推进（本次故障即此）。 */
  motionAutoNext = { timer: 0, cancelled: false };
  const tick = () => {
    if (!motionAutoNext) return;                 // 真被 motionAutoNextAbort() 取消 → 停
    if (motionRestLeft > 0) { renderMotionProgress(null); return; }
    clearInterval(motionRestTimer);
    motionRestTimer = 0;
    motionAutoAdvance(next);
  };
  if (motionRestTimer) clearInterval(motionRestTimer);
  renderMotionProgress(null);
  motionRestTimer = setInterval(() => { motionRestLeft -= 1; tick(); }, 1000);
}
```

- 兼容性已验证：`motionAutoNext` 的读取点只有 `motionAutoNextAbort()`（`app.js:3084`）、`motionAutoAdvance()`（`app.js:3209/3213`）和调试字段（`app.js:3356`）。占用它不会产生副作用；`motionAutoAdvance()` 随后会用新的把手覆盖它。
- 清理路径不变：切页/关摄像头/重来/停一组/换动作/重开校准 6 处已全部接上 `motionAutoNextAbort()`（`setMotionChoice:3448`、`motionFlowTeardown:3061`、`motionResetSet:3307`、`motionStopSet:3324`、`motionCalibOpen:3645`），abort 会 `clearInterval` + 归零 + 刷新面板，不会留下「迟到的定时器」。
- 对照实验已证明此改法有效（`_probe-autonext-f.log`：倒计时 10→1 流畅刷新，`jumpingJacks → highKnees` 自动切换）。

### 修复 B（**必须**，配套）— 让休息倒计时出现在「孩子实际能看到的全屏层」

问题：`motionFinishSet()` 在开练时收掉了全屏层（`app.js:3240`），而全屏层才是远处孩子唯一可读的通道。

改法：**在 `motionStartRest()` 里把全屏层重新显示出来**（渲染管线无需改动 —— `renderMotionProgress(null)` 已经同时写页内 `#motionGoalProgress` 和 `MotionAvatar.setProgress()` 两处，`app.js:3524-3557` / `motion-avatar.js:735-777`，面板本身就是吃 `resting/restLeft` 的）：

```js
// 接在修复 A 的 motionRestLeft = seconds; 之后
if (window.MotionAvatar) window.MotionAvatar.show();   // 休息也要在"大屏"上看得见倒计时
```

- 实测：加上此行后 `avatarVisibleDuringRest = true`，全屏层数字 `休息 10 秒 → 9 → … → 1`（`_probe-autonext-f.log`）。
- 不建议改成「不调 `MotionAvatar.hide()`」：`motionFinishSet()` 是**手动结束评分共用**的入口，手动结束时确实应该退回页面（孩子要在页面上看结果卡）；在 `motionStartRest()` 里再 `show()` 更内聚，也天然只在「还会自动往下走」时才生效。
- `setProgress` 双写已就绪，**无需改 `motion-avatar.js`**。

### 修复 C（建议）— `.pose-prep` 抬高到猫层之上：`styles.css:1826`

```css
.pose-prep {
  ...
  z-index: 110;   /* 原 96；必须 > .motion-avatar 的 100，否则自动推进时口令大字被猫层盖住 */
}
```

- 依据：实测 `elementFromPoint` 命中的是猫层 canvas；`.pose-prep` 的「准备开始进行XX + 3/2/1」是给孩子看的**唯一**口令通道（`styles.css:1814-1817` 注释即此意），被挡住等于没有。
- 该值只影响体感流程（`.pose-prep` 只在开练口令期出现），不影响其他页面。

### 可选的收尾（不必须）

- `app.js:3117-3120`：把 `motionAutoNextDisabled()` 的判断**提到 `motionFinishSet()` 之前**，可让「关自动下一项」时不进入 `pause()` 的清零路径。属语义洁癖，**非本次故障所需**（见 §2 可疑点 1）。
- `__motionDebug()` 的 `autoNextPending` 字段在修复后于休息期间会变为 `true`，语义更准确（无需改动，仅提示测试可据此断言「休息中」）。

---

## 4. 关键文件与行号索引（供修复者直接跳转）

| 作用 | 位置 |
|---|---|
| 状态变量 | `app.js:2141-2154` |
| `motionAutoNextDisabled()` 开关 | `app.js:3070-3075` |
| `motionAutoNextAbort()` 取消（6 处已接） | `app.js:3083-3097` |
| `motionAutoComplete()` 编排 | `app.js:3103-3135` |
| **`motionStartRest()` 主因所在** | `app.js:3174-3190`（守卫在 **3178**） |
| `motionNextChoice()` | `app.js:3194-3201` |
| `motionAutoAdvance()` | `app.js:3207-3230` |
| `motionFinishSet()` 内 `MotionAvatar.hide()` | `app.js:3240` |
| 调试字段 `setDone/restLeft/autoNextPending/progress` | `app.js:3354-3368` |
| `motionProgressOf()`（休息分支 `resting/restLeft`） | `app.js:3479-3519`（休息分支 3489-3493） |
| `renderMotionProgress()`（页内 + 全屏双写） | `app.js:3524-3557` |
| `renderMotionLive()` 环形/`progressPercent`/达标闸门 | `app.js:4001-4034` |
| `setProgress()`（全屏层面板） | `motion-avatar.js:735-777` |
| `hide()`（含 `setProgress(null)`） | `motion-avatar.js:698-706` |
| `.motion-avatar` z-index | `styles.css:1378` |
| `.motion-avatar-progress` z-index | `styles.css:1411` |
| `.motion-goal-progress`（页内） | `styles.css:1464-1509` |
| `.pose-prep` z-index（待抬高） | `styles.css:1826` |

---

## 5. 复现与回归说明

- 复现（无需摄像头）：任何 `rep` 类动作达标即可。合成画面（`_probe-autonext.js` 的竖直人形 + 双臂横向开合，1.25 Hz）喂 `width` 信号，约 16 秒内开合跳自然达 20 次触发。
- 修复后可用 `?motionPrep=0`（跳口令）快速验证：达标 → 休息 10 秒倒计时逐秒刷新 → 自动切到下一项并跑起来。
- 现有回归不受影响：`?motionPrep=0` 只跳口令、不跳自动推进；本次主因修复只改 `motionStartRest` 的守卫与显示，不触碰达标阈值（仍是 `percent >= 100`），不会误伤 `motion-browser-test.js` 里「半蹲 9/10 次」那条边界用例。

---

## 6. 落地实施与复测（2026-10-06 补记）

按团队指令已落地修复（**只改 `app.js` + `styles.css` 两个文件**，未碰 `motion-engine.js` / `motion-avatar.js` / `index.html`）。

### 6.1 改动内容

**(1) `app.js` `motionStartRest()`**（改后 3189 行起；原 3174 行）——修复 A + B：
- 函数开头 `motionRestLeft = seconds;` 之后新增占位把手：
  `motionAutoNext = { timer: 0, cancelled: false };`
- 紧随其后新增：`if (window.MotionAvatar) window.MotionAvatar.show();`
- 函数上方补了长注释，写清「`motionAutoNext` 身兼推进把手 / 取消标志两个身份，故进入休息必须先占住它」以及「`show()` 为什么必须在 `motionStartRest` 而不能放进 `motionFinishSet`」。
- 关于 `timer: 0`：仅借「非空即未取消」语义，`clearTimeout(0)` 是安全 no-op；`motionAutoNextAbort()` 里 `clearTimeout`（把手）+ `clearInterval`（休息 interval）两个都清，占位把手不会被漏掉。已在注释中写明。

**(2) `styles.css` `.pose-prep` z-index 96 → 110**（改后 1829-1843 行；原 1823 行）——修复 C。注释写明「必须盖过 `.motion-avatar` 的 100，留 10 余量给将来插入的层」。

### 6.2 隔离测试声明（重要）

另一个 teammate 已给 `motion-engine.js` 的计次加上**绝对幅度门限** `gate = expectedAmplitude × 0.5 × bodyScale`。本探针的合成人形摆幅偏小，门限落盘后会达不了标、链路根本触发不了（那不是修复没生效）。因此探针**在页面运行时内**把当前动作 `expectedAmplitude` 临时调到 `0.005`（`0.18 → 0.005`），模拟「孩子做的是大幅动作」，以隔离出 autonext 链路本身。**这是运行时内存改动，未写回任何生产文件，仅影响该次测试会话。**

### 6.3 探针复测实测数据（`_probe-autonext-verify.js`，默认 URL 走真实口令路径）

`app.js` md5 = `b98ce335dd5dd55b60dac7188a04c457`（运行前后一致，本轮结果绑定此版本）；无控制台报错 / pageerror。

| # | 验收项 | 实测 |
|---|--------|------|
| ① | `restLeft` 序列 | `10,10,10,10,9,9,9,8,8,8,7,7,7,6,6,6,5,5,5,5,4,4,4,3,3,3,2,2,2,1,1,1,0` |
| ① | 最小 / 最大 | `0 / 10`，**全程无负数** |
| ② | 页内倒计时文本（去重） | `休息 10 秒` … `休息 1 秒`（逐秒刷新） |
| ② | 全屏倒计时文本（去重） | `休息 10 秒` … `休息 1 秒`（逐秒刷新） |
| ③ | 休息期间 `MotionAvatar.isVisible()` | **全为 true**；全屏进度面板对孩子可见 = true |
| ④ | 休息结束切换到 | `highKnees`（`jumpingJacks → highKnees`），切换后 `running=true` / `previewing=false` |
| ⑤ | 自动进下一项时的层级 | `avatarZ=100`、`prepZ=110`、两者均可见；`centerTop="posePrep"`、`centerHitsPrep=true`、`countTop="posePrep"`、`countHitsPrep=true`（口令层已盖过猫层） |
| — | 全屏层数字在休息后的推进瞬间 | 由 `休息 1 秒` 变为 `0.7 / 20.0 秒`（下一项的正式计时已在跑） |

对照修复前（`_probe-autonext-de.log`）：`restLeft` 为 `10,…,1,0,0,-1,…, -5`（变负）、文本冻结在 `休息 10 秒`、`choice` 恒为 `jumpingJacks`、`centerHitsPrep=false`。**修复前后差异明确。**

### 6.4 交付物 md5

```
app.js        b98ce335dd5dd55b60dac7188a04c457
styles.css    dd6f4c5f1de73eb77c17531a057dc979
```

> 注：验证期间 `app.js` 存在另一 teammate 的**并发编辑**（仅新增 `__motionDebug` 的 `repGate` / `repSpread` 调试字段，位置在 `app.js:3407-3414`，不在本次修复区内）。`b98ce335` 已包含该并发改动，本报告验收结论绑定此 md5；该值在整轮复测前后保持一致。
