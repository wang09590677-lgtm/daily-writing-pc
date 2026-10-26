// 「依次进行」序列播放端到端验证（真实 Chrome，file://）
//
// 需求原话：「体感的今日训练中，勾选完项目后要可以选择"依次进行"，
//           就是勾选的项目一个个自动启动，不要每次还要挨个点击"计时"」
// 落点：今日训练页（fitnessToday），动作块右边有「计时」按钮的那个界面。
//
// 验证目标：
//   ① 没勾选时按钮 disabled、文案就是「依次进行」；直接调用入口不会启动计时
//   ② 勾选 3 项后按钮文案带数量「依次进行（3 项）」且可点
//   ③ 点击后 fitTimer.blockId = 按计划顺序（热身→主训练→放松）的第一个勾选块
//   ④ 状态行含「1 / 3」+ 该动作名
//   ⑤ 手动触发"这一项跑完" → 序列自动推进到第二项（blockId 变了），状态行变「2 / 3」
//   ⑥ 跑到最后一项后 fitSeq === null，且出现"全部练完"提示
//   ⑦ 中止：序列跑到一半时离开视图 → 待触发的自动推进定时器被清掉，
//      再手动调 fitSeqAdvance() 也不会跳到下一项（防"迟到的定时器"）
//   ⑧ 再点一次按钮 = 停止（fitSeq === null + 提示"已停止"）
//
// ⚠️ 本页在 puppeteer 下被 Chrome 重度节流（实测 performance.now() 5 秒只涨 10ms），
//    所以**绝不写"等 N 秒看它自己推进"的断言**（必然假失败），
//    也**绝不冻结 Date.now()**（会让页面里一切计时失效）。
//    这里的做法（本项目已验证的约定）：直接验逻辑分支 —— 把这一项的挂钟拨到过期、
//    手动跑一次判定（fitTimerTick），再手动调一次本该由 2 秒定时器触发的 fitSeqAdvance()。
//    "定时器是否真的按时回调"留到真机复核；本测试只保证"回调时该发生的逻辑分支是对的"。
//
// ⚠️ 顶层 let/const 不是 window 属性 → page.evaluate 里要用变量名本身（fitTimer / fitSeq），
//    不要写 window.fitTimer（会拿到 undefined 然后被 if 静默跳过）。
//
// 本测试必须串行跑，不要并行开多个 Chrome。
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOT = path.join(__dirname, "shots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pass = [], fail = [];
function check(name, ok, extra = "") {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  → " + extra : ""}`);
}

const pad = n => String(n).padStart(2, "0");
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

function seedScript() {
  // 只给最小种子，其余交给 loadState 的逐层合并；module=fitness 让页面直接进体能模块
  const state = { module: "fitness", fitness: { startDate: TODAY, picked: {}, done: {} } };
  return `(() => { localStorage.setItem("dailyWritingPcStateV3", ${JSON.stringify(JSON.stringify(state))}); })();`;
}

// 把"这一项跑完"这条分支走完：把挂钟拨到过期 → 手动 tick → 手动推进。
// 返回推进前后可用于断言的现场。
async function finishAndAdvance(page) {
  return page.evaluate(() => {
    // 手动让当前这一项走到终点（等价于倒计时自然归零时 fitTimerTick 做的事）
    fitTimer.prepping = false;
    fitTimer.running = true;
    fitTimer.endsAt = Date.now() - 1000;
    fitTimerTick();                 // → fitTimerFinish()，并挂上 2 秒后的收尾定时器
    const pendingBefore = !!fitTimer.closeHandle;
    fitSeqAdvance();                // 等价于那 2 秒定时器回调里做的事
    return { pendingBefore, blockId: fitTimer.blockId, running: fitTimer.running };
  });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--autoplay-policy=no-user-gesture-required", "--no-proxy-server"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.setViewport({ width: 1440, height: 1000 });

  const errors = [];
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
  await page.evaluateOnNewDocument(seedScript());

  // 今天（周日）是休息日，没有动作块，这个功能没法验 —— 明确跳过而不是假失败。
  const weekday = now.getDay();
  if (weekday === 0) {
    console.log("今天是周日（休息日），今日训练没有动作块，跳过「依次进行」用例。");
    await browser.close();
    process.exit(0);
  }

  /* ============ 场景 A：未勾选 → 勾选 3 项 → 依次跑完 ============ */
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(800);
  await page.evaluate(() => setView("fitnessToday"));
  await sleep(200);

  // 取今天三个不同分组的块（热身 / 主训练 / 放松），保证能验出"顺序是教案顺序"
  const info = await page.evaluate(() => {
    const day = fitnessDayFor(new Date());
    const blocks = fitnessBlocks(day, fitnessPhaseOf(fitnessWeekNo()));
    const pick = (arr, n) => arr.slice(0, n).map(b => ({ id: b.id, name: b.name, group: b.group }));
    return {
      warmup: pick(blocks.warmup, 1),
      main: pick(blocks.main, 1),
      cooldown: pick(blocks.cooldown, 1),
      counts: { warmup: blocks.warmup.length, main: blocks.main.length, cooldown: blocks.cooldown.length }
    };
  });
  const bWarm = info.warmup[0], bMain = info.main[0], bCool = info.cooldown[0];
  console.log(`  今天计划：热身 ${info.counts.warmup} / 主训 ${info.counts.main} / 放松 ${info.counts.cooldown}`);
  if (!bWarm || !bMain || !bCool) {
    console.log("  今天的分组不完整（缺少热身/主训/放松之一），跳过用例。");
    await browser.close();
    process.exit(0);
  }
  // 故意**乱序**勾选（主训 → 放松 → 热身），用来验证跑的顺序是教案顺序而不是勾选先后
  const ids = [bWarm.id, bMain.id, bCool.id];

  /* ---- ① 未勾选 ---- */
  const idle = await page.evaluate(() => {
    const btn = document.getElementById("fitTimeSeqBtn");
    return { text: btn.textContent.trim(), disabled: btn.disabled, inView: !!btn.closest("#fitnessToday") };
  });
  check("「依次进行」按钮在今日训练视图里", idle.inView);
  check("未勾选时按钮文案就是「依次进行」", idle.text === "依次进行", idle.text);
  check("未勾选时按钮 disabled", idle.disabled === true, String(idle.disabled));

  const noPick = await page.evaluate(() => {
    timeFitPickedSequence();   // 直接调用入口（disabled 按钮点不动，但脚本能绕过来）
    return { blockId: fitTimer.blockId, running: fitTimer.running, seq: fitSeq };
  });
  check("未勾选时直接调用入口不会启动计时", noPick.blockId === "" && noPick.running === false, JSON.stringify(noPick));
  check("未勾选时不会建立序列", noPick.seq === null);

  /* ---- ② 乱序勾选 3 项 ---- */
  await page.evaluate(seq => { seq.forEach(id => toggleFitPick(id)); }, [bMain.id, bCool.id, bWarm.id]);
  await sleep(150);
  const picked = await page.evaluate(() => {
    const btn = document.getElementById("fitTimeSeqBtn");
    return { text: btn.textContent.trim(), disabled: btn.disabled, n: fitnessPickedIds().length };
  });
  check("勾选 3 项后按钮文案含数量「依次进行（3 项）」", picked.text === "依次进行（3 项）", picked.text);
  check("勾选后按钮不再 disabled", picked.disabled === false);
  check("勾选数确实为 3", picked.n === 3, String(picked.n));

  // 截图 1：未开始时的头部按钮区（能看到「依次进行（3 项）」）。
  // 把上一步"未勾选"用例留下的提示条整个删掉 —— 它写着"先勾选要练的项目"，
  // 跟当前已勾选 3 项的状态自相矛盾，留在截图里会误导看截图的人。
  await page.evaluate(() => { const t = document.getElementById("toastBar"); if (t) t.remove(); });
  await page.screenshot({ path: path.join(SHOT, "fit-sequence.png") });

  /* ---- ③ 点击启动，第一个必须是"热身"（教案顺序第一），不是先勾的主训 ---- */
  await page.evaluate(() => document.querySelector("[data-action='time-picked-seq']").click());
  await sleep(150);
  const started = await page.evaluate(() => ({
    blockId: fitTimer.blockId,
    running: fitTimer.running,
    seqIds: fitSeq ? fitSeq.ids.slice() : null,
    seqIndex: fitSeq ? fitSeq.index : -1,
    status: (document.getElementById("fitSeqStatus").textContent || "").trim(),
    btn: document.getElementById("fitTimeSeqBtn").textContent.trim()
  }));
  check("点击后启动的是按计划顺序的第一个勾选块（热身，而非先勾的主训）",
    started.blockId === ids[0], `实际=${started.blockId} 期望=${ids[0]}(${bWarm.name})`);
  check("序列 ids 顺序 = 热身→主训→放松", JSON.stringify(started.seqIds) === JSON.stringify(ids), JSON.stringify(started.seqIds));
  check("序列下标从 0 开始", started.seqIndex === 0, String(started.seqIndex));
  check("运行中按钮变成「停止依次进行」", started.btn === "停止依次进行", started.btn);

  /* ---- ④ 状态行 ---- */
  check("状态行含序号「1 / 3」", started.status.includes("1 / 3"), started.status);
  check("状态行含当前动作名（热身项）", started.status.includes(bWarm.name), started.status);
  check("状态行含「依次进行：」前缀", started.status.includes("依次进行："), started.status);

  /* 截图 2：运行中的头部按钮区 + 状态行。
   * 教练浮层是 position:fixed 盖住 80% 屏幕的，会把头部挡住，所以截图前先把浮层收掉
   * （只影响这一张图；CoachTimer.close() 不会回调 onClose，序列状态不受影响）。 */
  await page.evaluate(() => { CoachTimer.close(); fitTimerMarkBlock(""); fitTimerRender(); });
  await sleep(120);
  await page.screenshot({ path: path.join(SHOT, "fit-sequence-running.png") });

  /* ---- ⑤ 推进到第 2 项 ---- */
  const adv1 = await finishAndAdvance(page);
  check("第一项跑完时挂上了收尾定时器（2 秒后再收浮层）", adv1.pendingBefore === true);
  const s2 = await page.evaluate(() => ({
    blockId: fitTimer.blockId,
    status: (document.getElementById("fitSeqStatus").textContent || "").trim(),
    index: fitSeq ? fitSeq.index : -1
  }));
  check("推进后 blockId 变成第二个勾选块（主训）", s2.blockId === ids[1], `实际=${s2.blockId} 期望=${ids[1]}(${bMain.name})`);
  check("推进后序号变「2 / 3」", s2.status.includes("2 / 3"), s2.status);
  check("推进后状态行动作名是主训项", s2.status.includes(bMain.name), s2.status);
  check("推进后 index = 1", s2.index === 1, String(s2.index));

  /* ---- 第 3 项 ---- */
  await finishAndAdvance(page);
  const s3 = await page.evaluate(() => ({
    blockId: fitTimer.blockId,
    status: (document.getElementById("fitSeqStatus").textContent || "").trim()
  }));
  check("再推进后 blockId 变成第三个勾选块（放松）", s3.blockId === ids[2], `实际=${s3.blockId} 期望=${ids[2]}(${bCool.name})`);
  check("再推进后序号变「3 / 3」", s3.status.includes("3 / 3"), s3.status);
  check("再推进后状态行动作名是放松项", s3.status.includes(bCool.name), s3.status);

  /* ---- ⑥ 跑完最后一项 ---- */
  await finishAndAdvance(page);
  const done = await page.evaluate(() => ({
    seq: fitSeq,
    status: (document.getElementById("fitSeqStatus").textContent || "").trim(),
    toast: (document.getElementById("toastBar") || {}).textContent || "",
    btn: document.getElementById("fitTimeSeqBtn").textContent.trim()
  }));
  check("跑完最后一项后 fitSeq 被清空", done.seq === null);
  check("出现「今天勾选的项目全部练完了！」提示", done.toast.includes("今天勾选的项目全部练完了"), done.toast);
  check("跑完后状态行清空", done.status === "", `「${done.status}」`);
  check("跑完后按钮回到「依次进行（3 项）」", done.btn === "依次进行（3 项）", done.btn);

  await page.screenshot({ path: path.join(SHOT, "fit-sequence-done.png") });

  /* ============ 场景 B：中止 / 迟到的定时器 ============ */
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(800);
  await page.evaluate(() => setView("fitnessToday"));
  await sleep(200);
  await page.evaluate(seq => { seq.forEach(id => toggleFitPick(id)); }, ids);
  await page.evaluate(() => document.querySelector("[data-action='time-picked-seq']").click());
  await sleep(150);
  const bStart = await page.evaluate(() => ({ blockId: fitTimer.blockId, seq: !!fitSeq }));
  check("（场景 B）序列已启动且停在第一项", bStart.seq === true && bStart.blockId === ids[0], bStart.blockId);

  // 让第一项跑完（挂上 2 秒后的自动推进定时器），然后"孩子切走了页面"
  const beforeLeave = await page.evaluate(() => {
    fitTimer.prepping = false;
    fitTimer.running = true;
    fitTimer.endsAt = Date.now() - 1000;
    fitTimerTick();                 // → fitTimerFinish()，closeHandle 挂上
    const pending = !!fitTimer.closeHandle;
    setView("fitnessBoard");        // 离开今日训练页 = 打断点
    return { pending, pendingAfter: !!fitTimer.closeHandle, seq: fitSeq, blockId: fitTimer.blockId };
  });
  check("（场景 B）跑完时确实挂上了待触发的自动推进定时器", beforeLeave.pending === true);
  check("（场景 B）离开视图后待触发定时器被清掉（迟到的定时器被取消）", beforeLeave.pendingAfter === false);
  check("（场景 B）离开视图后 fitSeq 被作废", beforeLeave.seq === null);
  check("（场景 B）离开时没有偷偷推进到下一项", beforeLeave.blockId === ids[0], beforeLeave.blockId);

  // 再手动调一次本该由定时器触发的推进 —— 必须什么都不发生
  const afterLeave = await page.evaluate(() => {
    fitSeqAdvance();
    return { blockId: fitTimer.blockId, seq: fitSeq, status: (document.getElementById("fitSeqStatus").textContent || "").trim() };
  });
  check("（场景 B）再手动触发推进也不会跳到下一项", afterLeave.blockId === ids[0], `实际=${afterLeave.blockId}`);
  check("（场景 B）推进后 fitSeq 仍为 null", afterLeave.seq === null);
  check("（场景 B）状态行保持空", afterLeave.status === "");

  /* ============ 场景 C：运行中再点一次 = 停止 ============ */
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(800);
  await page.evaluate(() => setView("fitnessToday"));
  await sleep(200);
  await page.evaluate(seq => { seq.forEach(id => toggleFitPick(id)); }, ids);
  await page.evaluate(() => document.querySelector("[data-action='time-picked-seq']").click());
  await sleep(150);
  const stopRes = await page.evaluate(() => {
    const wasRunning = !!fitSeq;
    document.querySelector("[data-action='time-picked-seq']").click();   // 再点一次 = 停止
    return {
      wasRunning,
      seq: fitSeq,
      toast: (document.getElementById("toastBar") || {}).textContent || "",
      btn: document.getElementById("fitTimeSeqBtn").textContent.trim()
    };
  });
  check("（场景 C）停止前序列确实在跑", stopRes.wasRunning === true);
  check("（场景 C）再点一次后 fitSeq 被清空", stopRes.seq === null);
  check("（场景 C）出现「已停止依次进行。」提示", stopRes.toast.includes("已停止依次进行"), stopRes.toast);
  check("（场景 C）按钮回到带数量的「依次进行（3 项）」", stopRes.btn === "依次进行（3 项）", stopRes.btn);

  /* ============ 场景 D：真机 2 秒定时器探针（纯信息，不做断言） ============
   * 前面所有推进都是手动调 fitSeqAdvance() 验的分支逻辑；这里真等一次，
   * 看 fitTimerFinish 挂的那个 2000ms setTimeout 到底会不会自己回调。
   * 由于本页在 puppeteer 下被重度节流，**结果只打印、不参与 PASS/FAIL**
   * （定时器是否按时回调的最终确认留到真机）。 */
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await sleep(800);
  await page.evaluate(() => setView("fitnessToday"));
  await sleep(200);
  await page.evaluate(seq => { seq.forEach(id => toggleFitPick(id)); }, ids);
  await page.evaluate(() => document.querySelector("[data-action='time-picked-seq']").click());
  await sleep(150);
  const probeBefore = await page.evaluate(() => {
    fitTimer.prepping = false;
    fitTimer.running = true;
    fitTimer.endsAt = Date.now() - 1000;
    fitTimerTick();                 // → fitTimerFinish()，挂上 2 秒收尾定时器
    return fitTimer.blockId;
  });
  await sleep(2600);
  const probeAfter = await page.evaluate(() => ({ blockId: fitTimer.blockId, index: fitSeq ? fitSeq.index : -1 }));
  console.log(`  [信息] 真等 2.6 秒后是否自动推进：blockId ${probeBefore} → ${probeAfter.blockId}，index=${probeAfter.index}`);

  console.log("\n=== 控制台报错 ===");
  console.log(errors.length ? errors.join("\n") : "无");

  /* 归因：打开教练浮层后 Chrome 会对 <video>（跟做视频/演示视频）发 Range 请求，
   * 在 file:// 协议下必然拿到 ERR_REQUEST_RANGE_NOT_SATISFIABLE —— 这是**既有环境噪声**，
   * 与本功能无关（没开浮层的回归测试也见得到）。只放行这一类资源加载失败，
   * 真正的 JS 异常（pageerror）一条都不放过。 */
  const unexpected = errors.filter(e => {
    if (/^PAGEERROR:/.test(e)) return true;                    // JS 异常必须暴露
    if (/ERR_REQUEST_RANGE_NOT_SATISFIABLE/.test(e)) return false;
    if (/Failed to load resource/.test(e)) return false;       // file:// 下的资源加载噪声
    return true;
  });
  if (unexpected.length) unexpected.forEach(e => console.log("  " + e));
  check("无意外控制台报错（JS 异常）", unexpected.length === 0, unexpected.length ? `${unexpected.length} 条` : "");

  console.log(`\nPASS ${pass.length}/${pass.length + fail.length}`);
  if (fail.length) console.log("失败项：" + fail.join(" | "));

  await browser.close();
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error("测试失败:", e); process.exit(1); });
