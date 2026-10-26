# 两个新问题的修复报告（2026-10-06 晚）

## 一、空房扫描"等好久也不结束、只能跳过"

### 根因（已 100% 复现）

**深度桥 WebSocket 连上了，但一帧深度数据都没有。**

实测（`build/_dbg-roomscan-stuck.js`，真实页面 + 真实深度桥）：

```
motionDepth.stats() = {"status":"open", "frameIndex":0, "valid":0, "grid 0/0",
                       "device":"Astra", "serial":"17122410131", "note":"运行中 640x480"}
扫描阶段 scanning | samples 0/12 | ready false | 对话框一直显示
```

外部直连 `ws://127.0.0.1:8765` 探测（`build/_dbg-depth-probe.js`）同样证实：
收到 hello（设备信息正常），5 秒内**零帧二进制数据**。

**因果链**：

| 步 | 发生了什么 | 问题 |
|---|---|---|
| 1 | `motionRoomScanMaybeStart()` 判据是 `stats().status === "open"` | **只代表连上了，不代表有数据** |
| 2 | 于是进入 `scanning`、弹出对话框 | — |
| 3 | 引擎 `structureWarm()` 每帧要 `grid().length === 6912` 且有效格 ≥ 5% | grid 长度是 **0** → 每帧早退 |
| 4 | `stSamples` 永远 0 → `stReady` 永远 false | — |
| 5 | app 侧 `motionRoomScanTick()` 只有 `if (!info.ready) return;` | **没有任何超时** → **永久卡住** |

**⚠️ 不是本次改动引入的** —— 我没碰任何深度相关代码。Python 端 `st.read(500)` 返回空时
静默 `continue`（不推帧也不报错），所以页面看到的是"一直挂着"。

### 修法（`app.js`，两层超时闸 + 唯一裁决点）

- **① 3 秒无帧**（`ROOM_SCAN_NOFRAME_MS`）：桥 15fps，正常 3 秒该有 45 帧 → 立即跳过，
  并记 `roomScan.depthDead = true` → **本会话不再弹这个框**
  （"没有可用深度就跳过"本来就是该功能的设计约定）。
- **② 8 秒无进展**（`ROOM_SCAN_TIMEOUT_MS`）：有帧但一直凑不满 → 跳过，下次仍给机会。
- 统一走 `motionRoomScanGiveUp(reason, dead)`。
- 超时闸用**独立定时器**（`roomScan.timer`），**不挂在每帧 tick 上** —— 第一版挂 tick 里时
  因为 `motionCalibTick()` 首行 `if (!motionCalib.active) return;` 而几乎不跑。
- 计时改用 `monoNow()`（`performance.now()` 单调时钟），不用 `Date.now()`。

### 验证（`build/_verify-roomscan-timeout.js` 11/11）

| 断言 | 结果 |
|---|---|
| 常量与函数在位 | ✅ `{timeout:8000, noframe:3000}` |
| 已进入扫描且挂上定时器 | ✅ `phase=scanning, hasTimer=true` |
| 无帧 + 超时 → 判定放弃 | ✅ `shouldGiveUp=true` |
| 超时后状态收尾为 skipped | ✅ |
| 超时后对话框收起 | ✅ `boxHidden=true` |
| 记下 depthDead | ✅ |
| 之后再进**不再弹**该框 | ✅ `started=false` |
| 反向确认：清掉 depthDead 仍能扫描 | ✅（没把功能焊死） |

> ⚠️ **遗留风险**：puppeteer 下该页面被 Chrome 重度节流（`performance.now()` 5 秒只涨 10ms），
> 所以"定时器是否**按时**回调"无法在自动化里验 —— 只验到了逻辑分支。这一条请真机复核。

---

## 二、新猫模型"腿看不到膝下动作、手臂僵硬"

### 先排除"数据缺失"

统计真实 MediaPipe 序列（`_tmp/_lm.json`）的腿部关键点，**可见率 100%**：

| 关键点 | 平均 visibility |
|---|---|
| 膝 | 0.94~0.99 |
| 踝 | 0.82~0.97 |
| 脚/跟 | 0.75~0.95 |

→ **数据不缺**，是驱动方式的问题。

### 真因（两条独立）

**(a) 关节缺失时整段骨完全不驱动** → "看不到膝盖之下"

`BONE_SEG` 里 `RightLowerLeg: ["kneeL","ankleL"]` **没有第三项兜底**。
`segDir()` 在 `seg[1]` 拿不到时会看 `seg[2]`，没有就直接 `return null`
→ 这根骨**完全不瞄准**，只剩"跟着大腿被动旋转"。
**修法**：补兜底 `["kneeL","ankleL","hipL"]`；手臂同理补 `"shoulderL"`。

**(b) ★ aim-only 的根本局限** → "动作不到位、僵硬"

`aimBone` 只对齐**方向**，而**骨长是模型固定的** —— 膝/肘落在"起点 + 骨长×方向"上，
与目标位置有偏差并逐段累积到末端（手/脚）。
**旧模型没这问题**：它用 `mesh.scale.y = 长度` 把圆柱**直接摆到两个关节之间**，长度随距离伸缩。
蒙皮骨骼不能改长度（会拉伸网格）。

**修法：两段 IK（末端优先）** —— `motion-avatar.js` 的 `solveTwoBoneIK()`：
根→目标求距离，余弦定理求上段夹角，绕弯曲轴重算膝/肘位置，再让下段收余差。
弯曲轴用**引擎给的膝/肘**当 pole → 天然在正确弯曲平面，不会反关节。

### A/B 实测（`build/_dbg-cat-ik.js`，量"末端实际位置 − 引擎目标位置"）

| 动作 | 腕误差 IK 关 | 腕误差 IK 开 | 改善 |
|---|---|---|---|
| 开合跳 | 0.497 | **0.069** | **7.2×** |
| 高抬腿 | 0.362 | **0.110** | **3.3×** |
| 跳绳 | 0.276 | **0.035** | **8.0×** |
| 深蹲 | 0.441 | **0.078** | **5.7×** |

→ **"手臂僵硬"基本解决。**

### 腿部：改善有限，且有物理上限（如实说明）

踝误差 IK 前后持平（0.08~0.17；深蹲 0.028）。
原因：**模型腿长占身高 36%，真人约 45%** —— 伸直时脚**物理上够不到**目标，
IK 只能重分配角度、改不了骨长。

**一次失败的尝试**：曾把缩放基准从"全身高"改成"**腿长**匹配"（想让脚更容易够到），
**实测更差**：踝误差 0.12 → **0.24** → **已回退**。

**如仍需改善腿部**，可选（需要你定）：
1. 换用"左右半身最低点"这类**腿部专属信号**（属动作参数，需真机验证）；
2. 接受现状 —— 腿的**方向**是对的，只是伸直时幅度略小。

---

## 三、改动与验证

| 文件 | 改动 | md5 |
|---|---|---|
| `motion-avatar.js` | 两段 IK + 腿部兜底 + `__ikError()` 探针 | `4ba03e9fb0c5a3170ccfffcee422ebf6` |
| `app.js` | 空房扫描超时闸 + `monoNow()` | `f45a40039059913c52fc923498925c2e` |
| `index.html` | 同步 `?v=20261006catik2` / `?v=20261006roomscanfix` | `dcacd0b19ca498384e4fde9abb9615c4` |

**回归（串行 + 间隔 7 秒，全绿）**：
`accept-cat-glb` 23/23 · `cat-avatar-test` 19/19 · `avatar-test` PASS ·
`accept-motion-autostart` 36/36 · `pose-calib-test` 28/28 · `_verify-roomscan-timeout` 11/11

**新增脚本**：`_dbg-roomscan-stuck.js`（复现卡住）、`_dbg-depth-probe.js`（直连桥探帧）、
`_dbg-cat-ik.js`（量 IK 误差）、`_verify-roomscan-timeout.js`（超时闸逻辑验收）。

---

## 四、★ 本轮的方法论教训

**puppeteer 下这个页面会被 Chrome 重度节流**：实测 `performance.now()` **5 秒只涨 10ms**，
`Date.now()` 同样几乎不动 → **一切"等 N 秒看它自己触发"的断言都会假失败/假通过**
（我因此一度误判"超时闸修复无效"）。

对策：
1. 计时的验证改成**直接验逻辑分支**（把起点人为拨老、手动触发一次判定）；
2. 产品代码量时长一律用 `performance.now()`（单调时钟）；
3. ⚠️ **测试脚本冻结日期时绝不冻结 `Date.now()`** —— `static now(){ return FIXED; }`
   会让页面里一切计时失效（本项目多个脚本有此隐患，值得后续清一遍）。
