# 体感修复回归报告（regress-repfix）

- 执行人：gstack-qa-lead-4
- 项目：`D:\workbuddy\2026-09-26-20-02-15\daily-writing-pc`
- 被测生产文件（本轮 11:25–11:32 改动）：
  - `motion-engine.js`（detectReps 计次绝对幅度闸门；getState 诊断字段）
  - `app.js`（motionStartRest 死锁修复 + MotionAvatar.show；__motionDebug 新字段）
  - `styles.css`（.pose-prep z-index 96 → 110）
  - `data/fitness-plan.js`（仅注释）

---

## 0. 结论速览

| # | 测试 | 通过 | 失败 | 结论 |
|---|------|------|------|------|
| 1 | `build/motion-browser-test.js` | 70 | 3 | 🔴 回归已确证（幅度闸门，见 §2） |
| 2 | `build/accept-motion-autostart.js` | 36 | 0 | 🟢 |
| 3 | `build/pose-calib-test.js` | 28 | 0 | 🟢 |
| 4 | `build/accept-pose-vision.js` | 19 | 0 | 🟢 |
| 5 | `build/accept-motion-autonext.js` | — | — | ⚪ 文件不存在，跳过（见 §5） |
| 6 | `build/cat-avatar-test.js` | 30 | 0 | 🟢 |
| 7 | `build/fit-voice-prep-test.js` | 53 | 1 | 🟡 失败为**既有问题**，非本轮引入（见 §3） |

- 全部测试**串行**执行；每条之间间隔 6 秒。
- 本次跑批**全程引擎哈希稳定**：`ENGINE_AT_START = ENGINE_AT_END = 168d6829b0e965be95eb9a99865f5890`（版本锁定有效）。
- 语法检查：`motion-engine.js` / `app.js` / `data/fitness-plan.js` 全部 `node --check` 通过；`styles.css` 正常。
- 生产文件已 100% 还原（见 §6）。

---

## 1. 关键前提：回滚点贴错 + 引擎在测试途中被二次修改

这两件事影响了取证方式，必须先说明。

### 1.1 `build/_rollback/*.before-repgate.*` 三件套里有两件是「改后」版本

| 文件 | md5 | 真相 |
|------|-----|------|
| `motion-engine.before-repgate.js` | `a507b6cc…` | ❌ **与改动后的引擎同 md5**，不是「加门限之前」 |
| `styles.before-repgate.css` | `dd6f4c5f…` | ❌ **与现行 styles.css 同 md5**，是「改后」 |
| `app.before-repgate.js` | `0ad6c397…` | ✅ 是改前版本（不含 __motionDebug 新字段） |
| **`motion-engine.before-autonext.js`** | **`4d5da7a1…`** | ✅ **唯一一份「无门限」引擎（grep repGate/repSpread = 0 次）** |

因此我**没有**用 `.before-repgate.js` 做 A/B（那是自己跟自己比，必然“无差异”），改用 `motion-engine.before-autonext.js`（`4d5da7a1`）作为真正的对照组。

### 1.2 引擎在测试途中被再次修改

- 11:31 我读到的 `motion-engine.js` = `a507b6cc`；11:32:48 被再次写入 → 变为 `168d6829`（新增 `repHeightBase` 高度慢基线低通，并 reset 时清零）。
- 因此 11:31 那一轮 motion-browser 的结果不能作为定版证据。**本报告所有正式数字，均来自 11:42 之后、md5 前后一致的锁定跑批**。

---

## 2. `motion-browser-test.js`：那条「数到 0 次」是**可能 A（真回归）**，已用 A/B 定案

### 2.1 A/B 原始输出（决定性证据）

**A 组：无门限旧引擎 `4d5da7a1`**（`build/_regress-repfix-AB-oldengine.log`）
```
  PASS  实时面板在更新  次数 0 · 节奏 — · 幅度 0% · 对称 0% · 连续 0%
  FAIL  引擎数出了动作次数（合成画面 0.6 Hz × 15 秒 ≈ 9 次）  数到 0 次
  PASS  评分后写入一条体感记录  动作分 82
  PASS  记录里保存了数到的次数  次数 10 · 节奏 47/分
  PASS  动作分是真实算出来的（不是 0）  82 分
  PASS  动作分达标后自动勾选今天的清单  已勾选 tue:warmup:2
通过 72 项 / 失败 1 项
失败项：
  - 引擎数出了动作次数（合成画面 0.6 Hz × 15 秒 ≈ 9 次）
```

**B 组：现行带门限引擎 `168d6829`**（`build/_regress-repfix-motion-browser.log`）
```
  FAIL  引擎数出了动作次数（合成画面 0.6 Hz × 15 秒 ≈ 9 次）  数到 0 次
  PASS  评分后写入一条体感记录  动作分 9
  FAIL  记录里保存了数到的次数  次数 0 · 节奏 0/分
  FAIL  动作分达标后自动勾选今天的清单  已勾选 无
通过 70 项 / 失败 3 项
失败项：
  - 引擎数出了动作次数（合成画面 0.6 Hz × 15 秒 ≈ 9 次）
  - 记录里保存了数到的次数
  - 动作分达标后自动勾选今天的清单
```

### 2.2 判定：可能 A — 真回归

| 判据 | 旧引擎 `4d5da7a1` | 新引擎 `168d6829` |
|------|-------------------|-------------------|
| 结算记录里的次数 | **10 次**（达标） | **0 次** |
| 动作分 | 82 | 9 |
| 达标自动勾选清单 | 已勾选 `tue:warmup:2` | 未勾选 |

**记录次数 10 → 0 是本轮改动引入的硬回归**，不是既有问题。

同时暴露出**两个不同性质的问题**，「数到 0 次」这条断言的措辞具有误导性：

- **问题①（既有）**：这条断言在**旧引擎上同样 FAIL**（DOM 实时读数 `mr-reps` 恒为 0）。原因是合成人形在 128×96 下的 `centroidY` 峰峰值仅约 **0.0097**，而该动作 `expectedAmplitude=0.06`、`minRepGap=0.9s`、节奏带 `[15,40]`——DOM 采样时点与真实计次（记录里的 10 次）不同步。**这条 DOM 断言是既有脆弱点。**
- **问题②（本轮真回归）**：幅度闸门把该夹具的**真实计次链路**整段挡掉。旧引擎结算记录 10 次，新引擎 0 次。

### 2.3 门限量级证据（直测探针 `build/_regress-repfix-probe.log`）

用与 `motion-browser-test.js` **完全相同**的合成人形夹具，在现行生产代码下逐帧采样 `__motionDebug()`：

```
放行帧 0 / 被挡帧 32 / 共 32
gate ≈ 0.0445–0.0450      （= 0.06 × 0.5 × bodyScale≈1.5）
spread ≈ 0.0137–0.0190    （始终 < gate）
visionSource = mask       mode = rep
末帧 reps = 0
```

即 `repSpread < repGate` 全程成立，**闸门确实在挡**。

**但这不是真机行为的代表——这是夹具的失真：**

| 来源 | 信号 | 实测峰峰值 spread | gate | 结果 |
|------|------|------------------|------|------|
| **真实采集**半蹲 0.6Hz @2m（`_exp-series`） | centroidY | **0.0911** | 0.0439 | **10 次 ✓**（放行，充裕） |
| **真实采集**半蹲 0.6Hz @4m | centroidY | **0.0647** | 0.0300 | **9 次 ✓** |
| **真实采集**静止+噪 1.2px @2m | width | 0.0208 | 0.1146 | 0 次 ✓（正确挡住） |
| **合成夹具** 128×96（本测试） | centroidY | **~0.014–0.019** | 0.0445 | **0 次 ✗** |

**根因（机制）**：`centroidY = (sumY/area)/H`（`motion-engine.js:1283`）是**归一化的绝对纵向位置**。合成人形上下摆幅 12/96 = 0.125，但“重心”只按面积权重轻微移动，`centroidY` 峰峰值仅约 0.0097；而真实采集的蹲起会带来更大的身体轮廓质心位移（0.09–0.13）。**这是 `centroidY` 语义问题 + 夹具合成人形与真实人体的几何差异共同作用**，使该夹具在门限下被挡。

**判定**：合成人形那条「数到 0 次」= **真回归的可复现证据**（记录 10→0），但**夹具本身失真**——真实采集的同等动作通过且有约 2 倍余量。因此：

- 若目标是“**该夹具不能退化为 0**”→ 需要改**引擎门限量级**或**夹具信号幅度**；⚠️ **我未改任何引擎代码，等 team-lead 裁定。**
- 若目标是“**真机不误挡**”→ 真实采集证据显示当前门限 OK；但**真机走 MediaPipe 姿态主链路**，其 `centroidY` 量纲与掩码链路不同（`__motionDebug.visionSource` 注释已警告），**仍存在与夹具同型的“量纲不匹配”风险**，建议真机复核（见 §7）。

> 备注：函数注释声称「实测（合成人形、真实引擎）→ 12 秒计 18 次」，并据此认为合成画面能穿门限；**本次直测证伪了这一点**（spread 0.014 < gate 0.045，全程 0 放行）。注释里的“合成人形实测”与浏览器测试夹具不是同一份画面。

---

## 3. `fit-voice-prep-test.js`：1 项失败为**既有问题**（已 A/B 排除本轮改动）

失败项：`哨令期间演示画面静止（画布被收起）`（`prepUi.canvasHidden === true` 未满足）。

三次证据，均一致：

| 运行 | app.js | 结果 |
|------|--------|------|
| 跑批首轮（12:02） | `b98ce335`（现行） | 53 通过 / 1 失败 |
| 复跑（12:05，同一现行版） | `b98ce335` | 53 通过 / 1 失败 → **可复现** |
| 聚焦 A/B：换入**改前** app.js（12:18） | `0ad6c397`（改前） | **同样 53 通过 / 1 失败** |

**判定：既有问题，与本轮 app.js / motion-engine.js / styles.css 改动无关。**

旁证：
- 该测试 `grep -c "motion\|Motion\|posePrep"` = **0**，完全不触及体感模块。
- 判定逻辑在 `coach-timer.js`（本轮未改）：`showPrepPreview()` 仅在 `state.videoUrl` 存在时隐藏 `coachCanvas`。失败说明该块未挂到演示视频 → `canvasHidden=false`。
- 本机**无历史 fit-voice-prep 日志**可比对；且 12:01 有另一 teammate 刚产出 `__autonext-verify.y4m`（其 Chrome 活动可能干扰该测试依赖的 3D 人偶/视频加载）。⚠️ 无法 100% 排除环境干扰，但 A/B 已足以排除**代码改动**。

---

## 4. 每项测试逐条失败详情

| 测试 | 通过/失败 | 失败项 | 实测值 | 性质 |
|------|-----------|--------|--------|------|
| motion-browser | 70/3 | 引擎数出了动作次数 | 数到 0 次（旧引擎也 0） | 既有脆弱（DOM 同步） |
| motion-browser | ↑ | 记录里保存了数到的次数 | 次数 0（旧引擎为 10） | **🔴 本轮真回归** |
| motion-browser | ↑ | 动作分达标后自动勾选清单 | 已勾选 无（旧引擎已勾选） | **🔴 回归级联** |
| fit-voice-prep | 53/1 | 哨令期间演示画面静止 | canvasHidden=false | 既有（A/B 已证） |
| 其余 4 项 | 全绿 | — | — | — |

---

## 5. 跳过的测试

- `build/accept-motion-autonext.js`：**文件不存在**，按约定跳过。
- 相关佐证：`app.js` 中**没有** `?motionPrep=0` 之外的 `?motionPrep` 处理（grep 未命中“跳过入口”），`motion-browser-test.js` 亦未传该参数——因此“自动下一项”目前**没有独立测试覆盖**。其部分行为被 `accept-motion-autostart.js` 第 2/4/6/7 节间接覆盖（自动开练、迟到定时器作废）。

---

## 6. 文件还原与哈希验证

A/B 对照采用 `cp` 临时替换 + `trap EXIT/INT/TERM` 双保险还原（`build/_ab-runner.sh` / `build/_ab-fitvoice.sh`）。

**最终 4 个生产文件 md5 = 原始值，全部还原成功：**

```
168d6829b0e965be95eb9a99865f5890 *motion-engine.js
b98ce335dd5dd55b60dac7188a04c457 *app.js
dd6f4c5f1de73eb77c17531a057dc979 *styles.css
0ddb31929044f62812ef1a512f226200 *data/fitness-plan.js
```

还原日志原文：
```
[restore] motion-engine.js 已还原 = 168d6829b0e965be95eb9a99865f5890 ✓
[restore] app.js 已还原 = b98ce335dd5dd55b60dac7188a04c457 ✓
AB_ALL_DONE 最终引擎 md5=168d6829b0e965be95eb9a99865f5890
FITVOICE_AB_DONE engine=168d6829… app=b98ce335…
```

> 额外安全副本（未覆盖 `_rollback`，可随时还原）：`build/_ab-backup-current-motion-engine.js`、`build/_ab-backup-current-app.js`。

---

## 7. 我无法解释 / 需 team-lead 裁定的事项（如实列出）

1. **引擎在我测试途中的 11:32:48 被二次修改**（`a507b6cc`→`168d6829`）。这使 11:31 那轮结果作废。**跑批期间（11:42–12:20）哈希稳定**；但**今后若还有人对 motion-engine.js 动刀，本报告结论需重跑。** 请明确冻结窗口。
2. **合成夹具与真机的 `centroidY` 量纲不匹配**：夹具被挡（真回归），真机采集放行（2 倍余量）。到底要修**引擎门限**还是**夹具**由 team-lead 决定——我不动生产代码。
3. **`fit-voice-prep` 的 1 项失败**：已 A/B 证明非本轮代码引入，但**无法 100% 排除 12:01 另一 teammate 的 Chrome 活动造成的环境干扰**（该测试依赖 3D 人偶/视频加载，且本机无历史日志可比）。建议在**无并行 Chrome** 的干净窗口复跑一次定案。
4. **所有浏览器测试在打印完汇总行后、`browser.close()` 阶段挂起**（`timeout` 强制 220s 截断，EXIT=124）。汇总前的全部断言均已正常输出，结论有效；但这是测试基建的一个隐患（可能是 puppeteer-core/browser.close 在本环境的已知卡死），建议后续单独排查。
5. `motion-engine.js` 函数注释中「合成人形 12 秒计 18 次」的说法与本次直测不符（见 §2.3 备注），可能是注释与夹具版本不同步——**仅为观察，未改动**。

---

## 8. 证据文件清单（均在 `build/`）

| 文件 | 内容 |
|------|------|
| `_regress-repfix-versions.txt` | 跑批时间线 + 每条前后引擎 md5（冻结证据） |
| `_regress-repfix-motion-browser.log` | 主回归（新引擎 70/3） |
| `_regress-repfix-autostart.log` | 自动开练（36/0） |
| `_regress-repfix-pose-calib.log` | 站位校准（28/0） |
| `_regress-repfix-pose-vision.log` | 真实骨架接入（19/0） |
| `_regress-repfix-cat-avatar.log` | 3D 猫咪（30/0） |
| `_regress-repfix-fit-voice-prep.log` | 口令语音（53/1，首轮） |
| `_regress-repfix-fit-voice-prep-2.log` | 口令语音复跑（53/1，可复现） |
| `_regress-repfix-fit-voice-prep-oldapp.log` | A/B：改前 app.js（53/1，既有） |
| `_regress-repfix-AB-oldengine.log` | **A/B：无门限旧引擎（72/1，记录 10 次）** |
| `_regress-repfix-probe.log` | **直测：合成人形 gate≈0.0445 vs spread≈0.014，32/32 被挡** |
| `_regress-repfix-AB.txt` | A/B 流程日志（含还原校验） |
| `_probe-repgate.js` / `_regress-runner.sh` / `_ab-runner.sh` / `_ab-fitvoice.sh` | 本次临时脚本（非生产，可删） |
