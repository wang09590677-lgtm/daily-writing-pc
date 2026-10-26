# 每日一写 · AI 儿童学习训练助手

> 一个**完全离线、双击即用**的小学生写作 + 体能训练双模块应用。
> 写作由 AI 老师逐篇批改打分，体能训练用摄像头做体感跟练、自动计次。
> 纯前端（HTML + CSS + 原生 JS），无后端、无构建、无 npm install，数据存本地。

写给 10–12 岁孩子用的。目标是让「每天写一篇、每天练一会」这件事变得有反馈、
有奖励、能坚持 —— 而不是又一份没人看的练习册。

<!-- 建议换成你自己孩子用了一段时间后的真实截图，更有说服力 -->
![首页：写作 / 体能两个模块](docs/screenshot-home.jpg)

<p align="center">
  <img src="docs/screenshot-rewards.jpg" width="620" alt="游戏卡与金币奖金池" />
</p>

---

## 目录

- [它能做什么](#它能做什么)
- [快速开始](#快速开始)
- [配置 AI 批改](#配置-ai-批改)
- [两个模块详解](#两个模块详解)
- [技术实现](#技术实现)
- [开发与回归测试](#开发与回归测试)
- [可选：Astra Pro 深度摄像头](#可选astra-pro-深度摄像头)
- [常见问题](#常见问题)
- [项目结构](#项目结构)
- [素材与第三方许可](#素材与第三方许可)
- [许可证](#许可证)

---

## 它能做什么

### 写作模块

- **每日必写**：每天一道写作题（记事 / 写景 / 说理 / 抒情），提交后由大模型按小学课标打分
- **拓展任务**：每日必写完成后解锁 —— 范文临摹、仿写、续写、读后感、看图编故事
- **文章补写**：从 80 篇按 5–6 年级课标生成的记叙/写景/说理短文中挖空，孩子填空还原
- **AI 范文**：按题目要求生成「参考范文」，以及把孩子自己的作文**扩写**成更长的版本
- **逐篇点评**：分数 + 分项评语 + 亮点 + 待改进，附金币奖励
- **积分体系**：每日总分达标换奖牌，奖牌换金币；写作金币与体能金币汇入同一个奖金池

### 体能训练模块

- **8 周 4 阶段计划**：心肺 / 腿力 / 核心 / 爆发分天轮换，每周 6 个主题日，周日休息
- **带计时器的跟练**：每个动作有目标次数或时长，倒计时 + 语音播报 + 中间休息
- **摄像头体感识别**：基于 MediaPipe Pose 33 关键点，自动计次、判姿态、给动作打分
- **动作演示视频**：每个动作都有真人演示片段
- **语音教练**：站位提示、读数、鼓励语，全程不盯屏幕也能跟完
- **游戏卡奖励**：一周训练 + 作文达标解锁三张「猫咪游戏卡」（懒猫 / 游戏猫 / 干饭猫）

### 设计取向

- **单机优先**：不注册、不上传、数据不出本机。断网也能用（AI 批改除外）
- **儿童友好**：目标是「父母看得懂、孩子愿意点」，不是「功能齐全的管理后台」
- **奖励要防廉价**：加分档位制，不采信自报数字，写得好才给高分

---

## 快速开始

### 环境要求

| 项 | 要求 |
|---|---|
| 系统 | Windows 10 / 11 |
| 浏览器 | Google Chrome（推荐）或 Microsoft Edge，正常安装即可 |
| 网络 | 只在使用 AI 批改时需要；其余功能全离线 |
| 摄像头 | 体能体感跟练需要（写作模块不需要） |

> 严格说这不是纯 Windows 项目 —— 只要浏览器支持 `file://` + WebGL + MediaPipe，
> 在 macOS / Linux 上手动用 Chrome 打开 `index.html` 也能跑。但**开箱脚本只做了 Windows 版**。

### 三步跑起来

```bash
git clone https://github.com/<your-name>/daily-writing-pc.git
cd daily-writing-pc
```

**双击 `start-app.bat`。**

它会做这几件事：

1. 找到本机的 Chrome（没有则回退 Edge）
2. 用**独立浏览器配置目录**（`%LOCALAPPDATA%\WritingCoachChrome`）打开 `index.html`
3. 带上几个必要参数：
   - `--allow-file-access-from-files` — 让 `file://` 页面能加载 MediaPipe 模型和 GLB
   - `--use-fake-ui-for-media-stream` — 自动放过摄像头授权弹窗
   - `--autoplay-policy=no-user-gesture-required` — 语音教练能直接出声
4. 若检测到本机有 Python，顺带起一个可选的深度桥服务（没有也不影响任何主流程）

> ⚠️ **窗口提示「Windows 已保护你的电脑」是正常的**：`.bat` 是纯文本脚本，
> 不是从网上下的，系统没法验证签名。点「更多信息」→「仍要运行」。

> ⚠️ **不要直接双击 `index.html`**。这样打开时浏览器不允许 `file://` 页面
> 读取本地模型文件，体感识别会挂，3D 模型也加载不出来。务必走 `start-app.bat`。

**数据存在哪？** 写作草稿、分数、金币都在 `%LOCALAPPDATA%\WritingCoachChrome`
这个 Chrome 配置目录的 localStorage 里。删项目文件夹不会丢数据；
想要从头开始就删掉这个目录。

---

## 配置 AI 批改

写作模块的 AI 打分**需要你自己的 API Key**，程序里不含任何密钥。
首次打分会引导你填。已支持的服务商（`ai-grader.js` 里 `PROVIDERS` 可扩展）：

| 服务商 | 默认模型接入点 | 申请地址 |
|---|---|---|
| DeepSeek（默认） | `https://api.deepseek.com/chat/completions` | <https://platform.deepseek.com/api_keys> |
| 阿里云百炼 / Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | <https://bailian.console.aliyun.com/> |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | <https://open.bigmodel.cn/usercenter/apikeys> |

也支持**自定义 URL**（任何 OpenAI 兼容的 `/chat/completions` 端点都能接）。

**关于 Key 的安全边界 —— 请务必理解：**

- 这是 `file://` 单机应用，Key 存在浏览器 localStorage 里，**不经过任何服务器**
- 但 localStorage 对本机其他程序不是加密的。**不要在这台机器上用高额度的主账号 Key**
- 程序内显示 Key 时是打码的；但打码 ≠ 加密
- 如果这台电脑是共用的，建议用服务商的子 Key / 低额度 Key

---

## 两个模块详解

### 写作模块

```
每日必写（打卡） → 解锁拓展写作 → AI 打分 → 当日总分 → 奖牌 → 金币
```

**每日必写**是唯一「必做项」。程序里 `dailyEssentialDone` 只认 `type === "每日必写"`
这一种任务 —— 做补写、做拓展**都不能顶替**每日必写的打卡。这是刻意的设计，
避免「今天不想写作文，就做个填空糊过去」。

**文章补写**的规则值得单独说，因为踩过坑：

- 素材库 80 篇，按 5、6 年级课标生成，句长中位 16.3 字、无超纲
- 年级标尺 `FILL_GRADE_SCALE`：三年级 600~800 字 …… 六年级 650~1150 字
- 挖空必须满足「≥280 字 且 ≤全文 50%」→ 反推出全文下限 ≥560 字
- 模型（deepseek-chat）**只服从「写几段」，不服从「每段写长点」**，自然段长钉死在
  ~65 字。所以要长度只能加段数，不能求它写长
- 挖空只存**下标**（`paragraphs` + `gapStart` + `gapCount`），渲染时只读下标，
  不读原始挖空文本 —— 否则改动一处就会出现两套真相

### 体能训练模块

**运动量定标**（11 岁女孩，一周 6 练）：

| 指标 | 数值 |
|---|---|
| 纯动作时间 | 64 分钟 / 周 |
| 含休息总时长 | 95 分钟 / 周 |
| 日均 | 15.8 分钟 |
| 单日区间 | 恢复日 12 分钟 ~ 综合日 18 分钟 |
| 休息 | 周日完全不练 |

定标依据：WHO 每日 60 分钟 MVPA 中，结构化训练宜占 15~20 分钟；
NSCA/ACSM 儿童自体重力量建议 12~15 次/组；等长保持 20~30 秒宁短勿长。
详见 `data/fitness-plan.js` 文件头注释。

**体感识别怎么做的**（这部分踩坑最多，值得单讲）：

- 主链路是 **MediaPipe Pose 33 关键点**，未检测到人时回退到纯图像掩码方案
- **预热是必需的**：首帧推理 3213ms，稳态后降到 9~11ms。默认用 `lite` 档
- 计次用**交替峰**（`detectReps` + `detrend` 去趋势），不是「幅度过线就 +1」
- **动作信号必须用专属关节，不能「遍历所有关键点取极值」**。真实反馈：
  手臂抬高放下会误触发跳绳和高抬腿计数 —— 因为旧信号 `height` 是包围盒高度、
  `bottomL/bottomR` 是该半侧所有点的最低 y，**都把手腕算进去了**。
  现在抬腿类改用 `ankleY_L/R`（只来自脚踝这一个点），全身起伏类改用
  `centroidY`（双髋中点）
- **踝被遮挡时不能补 0**：0 等于「踝跑到画面顶端」，会造出巨大假峰。
  必须沿用上一帧，`reset()` 时一并清缓存
- **保持类动作（平板支撑 / 单脚站立 / 靠墙静蹲）按读秒算，且必须感应到正确姿态才计时**。
  判据全部写成比值/差值（不依赖「髋在画面第几行」），孩子站近站远判定一致；
  骨架缺失一律不计秒
- **交替抬腿类的 `reps` 是左右两腿之和**，"20 次" = 10 个周期 ≈ 5 秒。
  所以动作库里的目标值都按「两腿之和」写

---

## 技术实现

| 层 | 选型 | 说明 |
|---|---|---|
| UI | 原生 HTML + CSS + JS | 无框架、无构建。`app.js` 约 9000 行，单文件主程序 |
| 持久化 | `localStorage`（key `dailyWritingPcStateV3`） | 单机版，无后端，无账号 |
| 姿态识别 | MediaPipe Pose（本地 vendored） | `vendor/mediapipe/`，含 lite/full 两档 tflite + wasm |
| 3D 角色 | three.js + GLTFLoader（本地 vendored） | `assets/models/cat_fitness_avatar.glb` |
| AI 批改 | OpenAI 兼容 `/chat/completions` | DeepSeek / Qwen / GLM / 自定义 |
| 语音 | 预生成 mp3（`assets/coach/`） | edge-tts 离线合成，运行时只播不合成 |
| 深度（可选） | OpenNI2 + Python websocket 桥 | 浏览器拿不到 Astra Pro 的深度流，必须绕出去 |

**没有构建步骤**是刻意选择：改完 JS 刷新就生效，孩子他爸也能上手改。

### 几处需要留意的约定

- **改 JS / CSS 后必须同步 `index.html` 里的 `?v=` 版本号**。`file://` 下浏览器缓存
  极其顽固，不改版本号会出现「代码改了但界面没变」
- **量时长用 `monoNow()`**（单调时钟），别用 `Date.now()`，系统对时会让时长变负
- **写作分数实时推导**：`dayScore` / `dayDetail` 都从 `state.essays` 现算，
  唯一出口是 `essayPoints(item)`。`extraBonus` 已并入 `feedback.score`，别再额外加一次
- **游戏卡解锁状态不落库**：每次从 `state` 现算（同 `dayScore` 思路），
  避免「存了一份状态、算了一份状态」两套真相
- `.bat` 文件是 **GBK/ANSI** 编码，不能加 `chcp 65001`，也不能写非 ASCII 以外的
  编码混用 —— 否则 cmd 解析出错。要改请用 `build/gen-start-bat.py` 生成

---

## 开发与回归测试

**所有回归脚本都在 `build/` 目录**，共 500+ 个文件，其中 `_` 开头的是探针/调试脚本，
不带下划线的是正式验收测试。

```bash
# 写作相关子集（9 项）
bash build/_run-aimodel-regress.sh

# 全量回归（约 58 分钟）
bash build/_final-regress.sh
```

单跑一个浏览器测试（需要 Chromium 系浏览器 + puppeteer-core）：

```bash
NODE_PATH=/path/to/node_modules node build/points-browser-test.js
```

### 回归纪律（这个项目靠这几条活下来的）

1. **真实数据是唯一验收标准**。探针在合成数据上过，不代表真机能用
2. **回归失败先做 A/B**：换回改动前的版本跑同一个测试。如果失败项一模一样，
   就是既有问题，不是这次改坏的
3. **批量回归串行跑 + 间隔数秒**。并发跑会互相抢 Chrome 实例和摄像头
4. **界面改动必须真的看一眼截图**。断言抓不到「144×144 的方疙瘩按钮」
5. **改「外加判据」（超时闸 / 门禁 / 前置校验）后，依赖它的旧验收全部重跑**
6. **测试夹具要忠实于真实契约字段**。夹具错了就改夹具，**不许改断言**

### 值得一看的探针

| 脚本 | 验证什么 |
|---|---|
| `build/_lead-harness.js` | 从源码里抠出真函数跑计次，栅格全扫 |
| `build/_probe-armfalse.js` | 「只有手臂动」的 A/B 对照，证明信号没被污染 |
| `build/_probe-holdcheck.js` | 保持类动作「姿势不对不计秒」 |
| `build/_probe-fill-grade-scale.js` | 补写年级标尺与段数自洽（46 项） |
| `build/_probe-gamecard.js` | 游戏卡解锁逻辑（24 项） |

---

## 可选：Astra Pro 深度摄像头

**默认关掉，大多数人不需要。** 深度只在判断「人往前 / 往后」时有用，
计次完全不需要它。

为什么单独做一层桥：奥比中光 Astra Pro 在系统里是**两个设备** ——

| 设备 | VID/PID | 浏览器可见 |
|---|---|---|
| Astra Pro HD Camera | `2BC5:0501` | ✅ 标准 UVC 彩色流 |
| ORBBEC Depth Sensor | `2BC5:0403` | ❌ 私有内核驱动 |

私有的内核驱动不暴露给浏览器，所以深度必须绕开浏览器，用 OpenNI2 写本地程序。
`tools/orbbec/openni-bridge.py` 就是干这个的：读深度 → 走 websocket（8765 端口）
→ 页面里 `depth-link.js` 接。

想用的话：

1. 从奥比中光官网下载 **Orbbec OpenNI2 v2.3.0.86-beta6 (Windows)** 和
   **Astra 驱动 4.3.0.22**（本仓库不附带，见 [素材与第三方许可](#素材与第三方许可)）
2. 解压到 `tools/openni/` 和 `tools/orbbec/`
3. 管理员运行 `tools/orbbec/1-install-driver.bat`
4. 跑 `tools/orbbec/2-verify.bat` 确认深度正常
5. `pip install websockets`，然后双击 `tools/orbbec/start-depth-bridge.bat`
6. 用 `start-app-depthz.bat`（带 `?depthZ=1`）启动，才会启用前后方向判定

> ⚠️ 用 `file://` 打开时**摄像头必须站 3/4 斜视角**，正面视角下髋膝踝三点在
> x-y 上共线，2D 内角恒为 180°，大腿抬起的角度算不出来。
> 这个坑在 `motion-avatar.js` 的 IK 里已经用「内角法 + 位置法取更弯的那个」绕过。

---

## 常见问题

<details>
<summary><b>双击 bat 没反应，或者窗口一闪就没了</b></summary>

右键 → 「以管理员身份运行」试一次。若仍无反应，把 bat 复制一份，
把里面的 `start` 换成 `echo [DRYRUN]` 再跑，就能看到它到底卡在哪一步。
</details>

<details>
<summary><b>页面打开了但没有样式 / 一片空白</b></summary>

确认整个文件夹都 clone 下来了，尤其是 `assets/`、`vendor/`、`data/`。
用 `git clone` 而不是只下 `index.html`。
</details>

<details>
<summary><b>体感识别一直显示「没检测到人」</b></summary>

按顺序排查：① 光线够不够（背光最糟）② 人是否整个人在画面里（站太近脚会出画）
③ 有没有别的程序占着摄像头（视频会议、另一个浏览器窗口）
④ 站到离摄像头 2.5~3 米。
</details>

<details>
<summary><b>AI 打分报错 / 一直转圈</b></summary>

`ai-grader.js` 的设计原则是**永不 reject** —— 任何失败都会降级成本地规则评分
并给出提示，不会把页面卡死。如果一直转圈，先检查 Key 填了没、网络通不通、
服务商余额够不够。换服务商试一次可以快速定位是 Key 的问题还是端点的问题。
</details>

<details>
<summary><b>数据在哪？怎么备份 / 清空？</b></summary>

全在 `%LOCALAPPDATA%\WritingCoachChrome` 这个 Chrome 配置目录里。
备份就复制整个目录；清空就删掉它（**不可恢复**）。
也可以在应用内的家长/设置区导出。
</details>

<details>
<summary><b>能不能给孩子装在别的电脑上？</b></summary>

可以，整个文件夹复制到 U 盘即可，不写注册表、不装系统服务
（唯一例外是可选的那颗 Astra 驱动）。
</details>

---

## 项目结构

```
daily-writing-pc/
├── index.html              主页面（含 ?v= 版本号，改 JS/CSS 后要同步）
├── app.js                  ★ 主程序，约 9000 行
├── styles.css
├── ai-grader.js            AI 批改 / 范文生成 / 补写评分
├── motion-engine.js        ★ 体感引擎：计次、去趋势、姿态判据
├── pose-vision.js          MediaPipe 封装，产出归一化关键点信号
├── motion-avatar.js        ★ 3D 猫咪角色（IK、跟练动画）
├── coach-timer.js          计时器与流程推进
├── voice-guide.js          语音教练播报
├── depth-link.js           深度桥 websocket 客户端
├── video-store.js          演示视频管理
├── start-app.bat           ★ 唯一的启动入口
├── start-app-depthz.bat    诊断用：带 ?depthZ=1 启动
├── data/                   题库与素材
│   ├── tasks.js            写作任务
│   ├── fill-articles.js    80 篇补写素材
│   ├── models-authored-*.js  范文（6 卷）
│   ├── models-classics.js  经典范文
│   └── fitness-plan.js     ★ 8 周训练计划（定标依据在文件头）
├── assets/
│   ├── coach/              58 个预生成语音 mp3
│   ├── pictures/           210 张看图编故事配图
│   ├── models/             猫咪 GLB
│   ├── img/                首页插画、游戏卡图
│   └── vendor/             three.js + GLTFLoader
├── vendor/mediapipe/       姿态识别模型与 wasm（本地，不走 CDN）
├── 体能训练动作演示/        每个动作的演示 mp4 + 体感模型 glb
├── tools/openni/           OpenNI2 运行时（需自行下载，见上）
├── tools/orbbec/           Astra 驱动 + 深度桥 Python 脚本
└── build/                  ★ 全部回归测试、探针、生成脚本
```

---

## 素材与第三方许可

**本项目代码采用 MIT。但素材和第三方库的授权是分开的，请注意区分。**

| 内容 | 来源 | 说明 |
|---|---|---|
| `vendor/mediapipe/` | Google MediaPipe | Apache-2.0 |
| `assets/vendor/three.min.js`、`GLTFLoader.js` | three.js | MIT |
| `assets/pictures/`（210 张） | Pollinations.ai 免费档生成 | 生成时裁掉水印；商用前请确认该服务当时的条款 |
| `assets/img/cat-*.jpg`、`game-cards/*` | AI 生成 | — |
| `assets/coach/*.mp3` | edge-tts 合成 | 微软语音服务的输出物，商用前请阅读其服务条款 |
| `体能训练动作演示/*.mp4` | 网络公开演示片段 | ⚠️ **再分发前请自行确认来源授权**，介意的话可删除，程序会降级为无演示图 |
| `data/models-classics.js` | 公版经典作品节选 | 作者已故逾 50 年 |
| OpenNI2 / Astra 驱动 | 奥比中光 | **不随仓库分发**，请从官网下载 |

> 如果你是**自己 fork 来家庭使用**，上表基本无需担心。
> 如果要做成产品分发，`体能训练动作演示/` 里的视频和 edge-tts 音频建议换成自有素材。

---

## 许可证

代码采用 [MIT License](LICENSE)。

Copyright (c) 2026 老李 and contributors

---

## 最后

这个项目最初只是「想让孩子每天写一篇、每天练一会儿」。
做到一半发现真正难的不是功能，而是**让 AI 的判断和孩子实际做的事对得上** ——
所以 `build/` 里堆了 500 多个探针和回归脚本，每一条都是被真实误判逼出来的。

如果它对你有用，欢迎随手提 issue 说说你是怎么用的。
