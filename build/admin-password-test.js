// 家长密码：三道闸门 + 留痕
//
// 背景：用户问"家长的密码怎么被你改了？"。排查结论是**从来没有代码改过密码**
// （全项目只有 changePassword 一处写入，且只由按钮/回车触发）。
// 真正的隐患是原来那个 changePassword 不验证当前密码、不二次确认、改完也不回显，
// 家长在管理页随手一输就可能把密码改掉，事后完全无从察觉。
// 所以这里验的是"防误改 + 可追溯"是否真的到位。
const path = require("path");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pass = [], fail = [];
function check(name, ok, extra = "") {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.setViewport({ width: 1440, height: 1000 });

  const errors = [];
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });
  // 「忘记密码？立即关闭密码」和「关闭开关」都会 confirm，这里一律接受
  page.on("dialog", d => d.accept());

  const url = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await sleep(900);

  console.log("\n== 0. 默认不拦：忘记密码的家长也一定进得去（用户明确要求）==");
  /* 用户报「密码明明是对的却登录不进去」，要求先把密码取消。
   * 这里验的就是"默认不设门"这条底线：无论如何都不能把家长锁在自己家外面。 */
  await page.evaluate(() => {
    [...document.querySelectorAll(".nav-item")].find(n => n.dataset.view === "admin").click();
  });
  await sleep(400);
  const nopassInit = await page.evaluate(() => ({
    enabled: state.admin.passwordEnabled,
    lockShown: !document.getElementById("adminLock").classList.contains("hidden"),
    panelShown: !document.getElementById("adminPanel").classList.contains("hidden")
  }));
  check("默认 passwordEnabled 就是关闭的（不存在\"被锁在门外\"）",
    nopassInit.enabled === false, String(nopassInit.enabled));
  check("未启用密码时锁页整个不出现，管理面板直接打开（少一次无意义的点击）",
    nopassInit.lockShown === false && nopassInit.panelShown === true);

  const stateTxt0 = await page.evaluate(() => document.getElementById("adminPassState").textContent.replace(/\s+/g, " ").trim());
  check("密码卡片明确写出「当前没有启用密码」", /没有启用密码/.test(stateTxt0), stateTxt0.slice(0, 50));

  console.log("\n== 0b. 打开开关立刻生效：退出后必须输密码才能进 ==");
  const toggled = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const box = document.getElementById("adminPasswordEnabled");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(250);
    return {
      enabled: state.admin.passwordEnabled,
      passState: document.getElementById("adminPassState").textContent.replace(/\s+/g, " ").trim()
    };
  });
  check("勾上开关后 passwordEnabled 变 true", toggled.enabled === true);
  check("状态文案同步变成「已启用密码保护」", /已启用密码保护/.test(toggled.passState), toggled.passState.slice(0, 40));

  const lockedAgain = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.querySelector("[data-action='admin-logout']").click();
    await wait(250);
    return {
      unlocked: adminUnlocked(),
      lockShown: !document.getElementById("adminLock").classList.contains("hidden"),
      lockState: document.getElementById("adminLockState").textContent.trim(),
      hasEscape: !!document.querySelector("#adminLock [data-action='disable-password']")
    };
  });
  check("启用密码后退出 → 重新上锁，显示密码输入框",
    lockedAgain.unlocked === false && lockedAgain.lockShown === true);
  check("锁页上写明当前密码是什么，家长不用猜",
    /当前密码是 09590677/.test(lockedAgain.lockState), lockedAgain.lockState);
  check("锁页上有「忘记密码？关闭密码」的逃生入口（人还没进去就能自救）",
    lockedAgain.hasEscape === true);

  console.log("\n== 1. 初始状态：密码就是 09590677，且明确标注从未修改 ==");
  const init = await page.evaluate(() => ({
    pw: state.admin.password,
    hasHistory: Array.isArray(state.admin.passwordHistory),
    changedAt: state.admin.passwordChangedAt || "",
    // 登录页的默认密码提示
    lockHint: document.getElementById("adminLock").textContent.replace(/\s+/g, " ").trim()
  }));
  check("默认密码是 09590677（与文档/提示一致）", init.pw === "09590677", init.pw);
  check("老数据升级后 passwordHistory 是数组，不是 undefined", init.hasHistory === true);
  check("初始没有改动时间（如实显示「从未修改过」）", init.changedAt === "");
  check("登录页写明了初始密码 09590677", /09590677/.test(init.lockHint), init.lockHint.slice(0, 60));

  await page.evaluate(() => {
    document.getElementById("adminPasswordInput").value = "09590677";
    document.querySelector("[data-action='admin-login']").click();
  });
  await sleep(400);

  const info0 = await page.evaluate(() => document.getElementById("adminPasswordInfo").textContent.replace(/\s+/g, " ").trim());
  check("管理页明确显示当前密码是什么", /当前密码是 09590677/.test(info0), info0.slice(0, 70));
  check("管理页写明从未修改过", /从未修改过/.test(info0), info0.slice(0, 70));

  console.log("\n== 2. 防误改：三样都填错不了 ==");

  // 2a 不填当前密码 → 拒绝
  const noCur = await page.evaluate(() => {
    document.getElementById("adminCurrentPassword").value = "";
    document.getElementById("adminNewPassword").value = "5678";
    document.getElementById("adminNewPassword2").value = "5678";
    document.querySelector("[data-action='change-password']").click();
    return { pw: state.admin.password, toast: document.getElementById("toastBar").textContent.trim() };
  });
  check("不填当前密码 → 密码纹丝不动", noCur.pw === "09590677", `密码仍是 ${noCur.pw}`);
  check("并明确告诉家长原因", /当前密码/.test(noCur.toast), noCur.toast);

  // 2b 当前密码填错 → 拒绝
  const wrongCur = await page.evaluate(() => {
    document.getElementById("adminCurrentPassword").value = "0000";
    document.getElementById("adminNewPassword").value = "5678";
    document.getElementById("adminNewPassword2").value = "5678";
    document.querySelector("[data-action='change-password']").click();
    return { pw: state.admin.password, toast: document.getElementById("toastBar").textContent.trim() };
  });
  check("当前密码填错 → 拒绝修改，密码不变", wrongCur.pw === "09590677", `密码仍是 ${wrongCur.pw}`);
  check("并说清楚「密码没有改动」", /没有改动|不对/.test(wrongCur.toast), wrongCur.toast);

  // 2c 两次新密码不一致 → 拒绝
  const mismatch = await page.evaluate(() => {
    document.getElementById("adminCurrentPassword").value = "09590677";
    document.getElementById("adminNewPassword").value = "5678";
    document.getElementById("adminNewPassword2").value = "5679";
    document.querySelector("[data-action='change-password']").click();
    return { pw: state.admin.password, toast: document.getElementById("toastBar").textContent.trim() };
  });
  check("两次新密码不一致 → 拒绝修改（防手滑把自己锁在外面）",
    mismatch.pw === "09590677", `密码仍是 ${mismatch.pw}`);
  check("并提示两次输入不一样", /不一样/.test(mismatch.toast), mismatch.toast);

  // 2d 新密码太短 → 拒绝
  const tooShort = await page.evaluate(() => {
    document.getElementById("adminCurrentPassword").value = "09590677";
    document.getElementById("adminNewPassword").value = "12";
    document.getElementById("adminNewPassword2").value = "12";
    document.querySelector("[data-action='change-password']").click();
    return { pw: state.admin.password, toast: document.getElementById("toastBar").textContent.trim() };
  });
  check("新密码少于 4 位 → 拒绝修改", tooShort.pw === "09590677" && /4 位/.test(tooShort.toast), tooShort.toast);

  console.log("\n== 3. 正常路径：三样都对才改，并且回显新密码 ==");
  const ok = await page.evaluate(() => {
    document.getElementById("adminCurrentPassword").value = "09590677";
    document.getElementById("adminNewPassword").value = "5678";
    document.getElementById("adminNewPassword2").value = "5678";
    document.querySelector("[data-action='change-password']").click();
    return {
      pw: state.admin.password,
      toast: document.getElementById("toastBar").textContent.trim(),
      changedAt: state.admin.passwordChangedAt || "",
      history: state.admin.passwordHistory || [],
      info: document.getElementById("adminPasswordInfo").textContent.replace(/\s+/g, " ").trim()
    };
  });
  check("三样都正确 → 密码真的改掉了", ok.pw === "5678", ok.pw);
  check("提示里回显了「旧密码 → 新密码」，家长不会不知道改成了什么",
    /09590677/.test(ok.toast) && /5678/.test(ok.toast), ok.toast);
  check("记录了改动时间", /^\d{4}-\d{2}-\d{2}T/.test(ok.changedAt), ok.changedAt);
  check("留下了改动历史（旧 → 新）",
    ok.history.length === 1 && ok.history[0].from === "09590677" && ok.history[0].to === "5678",
    JSON.stringify(ok.history));
  check("管理页上的说明同步更新为新密码",
    /当前密码是 5678/.test(ok.info) && /最近一次改动/.test(ok.info), ok.info.slice(0, 80));

  console.log("\n== 3b. 输入法形态容错：全角数字 / 空格 / 零宽字符（用户实际踩的坑）==");
  /* 用户报"家长密码回车显示密码不对，进不去"。
   * 真实原因是中文输入法打出的**全角数字 １２３４** —— 屏幕上和半角几乎一样，
   * 但 `===` 必然不等。这一节就是那条 bug 的防回归守卫。 */
  const shapes = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const input = document.getElementById("adminPasswordInput");
    const btn = document.querySelector("[data-action='admin-login']");

    async function tryLogin(v) {
      if (adminUnlocked()) document.querySelector("[data-action='admin-logout']").click();
      await wait(250);
      document.getElementById("toastBar").textContent = "";
      input.value = v;
      btn.click();
      await wait(300);
      return {
        unlocked: adminUnlocked(),
        toast: document.getElementById("toastBar").textContent.trim().slice(0, 60)
      };
    }

    // 当前密码此时是 5678（第 3 节刚改过）
    return {
      fullWidth: await tryLogin("５６７８"),          // 全角
      spaced: await tryLogin("  5678  "),              // 首尾空格
      zeroWidth: await tryLogin("56\u200B78"),         // 夹零宽空格
      // 不间断空格是真正的"空白"（不是零宽），夹在中间就该算多余字符；
      // 只有出现在首尾时才该被 trim 掉。这里测的是首尾形态。
      nbspEdge: await tryLogin("\u00A05678\u00A0"),
      // 反例：中间夹不间断空格 = 密码变成了 "56 78"，必须被拒（别过度归一化）
      nbspInside: await tryLogin("56\u00A078"),
      // 反例：真正错误的密码必须仍然被拒（别把归一化做成万能钥匙）
      wrong: await tryLogin("5679"),
      // 全角错误密码不能被"归一化"成正确值
      wrongFull: await tryLogin("５６７９")
    };
  });

  check("全角数字 ５６７８ 能进去（中文输入法不再是拦路虎）",
    shapes.fullWidth.unlocked === true, shapes.fullWidth.toast);
  check("首尾空格被忽略（  5678   能进去）",
    shapes.spaced.unlocked === true, shapes.spaced.toast);
  check("零宽空格被清掉（56\\u200B78 能进去）",
    shapes.zeroWidth.unlocked === true, shapes.zeroWidth.toast);
  check("首尾的不间断空格被当空白去掉（\\u00A05678\\u00A0 能进去）",
    shapes.nbspEdge.unlocked === true, shapes.nbspEdge.toast);
  check("中间夹不间断空格不算等价密码（56\\u00A078 被拒，不过度归一化）",
    shapes.nbspInside.unlocked === false, shapes.nbspInside.toast);
  check("错误密码 5679 依然被拒（归一化不是万能钥匙）",
    shapes.wrong.unlocked === false, shapes.wrong.toast);
  check("全角错误密码 ５６７９ 也依然被拒",
    shapes.wrongFull.unlocked === false, shapes.wrongFull.toast);

  // 归一化后的密码在管理页应显示为半角，家长一眼能看出"存的是 5678"
  const normalized = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    if (adminUnlocked()) document.querySelector("[data-action='admin-logout']").click();
    await wait(250);
    document.getElementById("adminPasswordInput").value = "５６７８";
    document.querySelector("[data-action='admin-login']").click();
    await wait(300);
    return document.getElementById("adminPasswordInfo").textContent.replace(/\s+/g, " ").trim();
  });
  check("管理页把密码显示成半角 5678（不因输入法形态而存成全角）",
    /当前密码是 5678/.test(normalized), normalized.slice(0, 60));

  console.log("\n== 4. 新密码立即生效 ==");
  const login = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    // 退出管理，再用新密码进
    if (adminUnlocked()) document.querySelector("[data-action='admin-logout']").click();
    await wait(300);
    document.getElementById("adminPasswordInput").value = "5678";
    document.querySelector("[data-action='admin-login']").click();
    await wait(300);
    return {
      unlocked: adminUnlocked(),
      panelShown: !document.getElementById("adminPanel").classList.contains("hidden")
    };
  });
  check("退出后用新密码 5678 能正常进入", login.unlocked === true && login.panelShown === true);

  const enabledAfterChange = await page.evaluate(() => state.admin.passwordEnabled);
  check("设完新密码自动重新启用密码保护（不会\"设了但没生效\"）", enabledAfterChange === true);

  const oldRejected = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    if (adminUnlocked()) document.querySelector("[data-action='admin-logout']").click();
    await wait(300);
    document.getElementById("adminPasswordInput").value = "09590677";
    document.querySelector("[data-action='admin-login']").click();
    await wait(300);
    return { unlocked: adminUnlocked(), toast: document.getElementById("toastBar").textContent.trim() };
  });
  check("旧密码 09590677 已经不能用了", oldRejected.unlocked === false, oldRejected.toast);

  console.log("\n== 4b. 「忘记密码？立即关闭密码」是家长的逃生通道 ==");
  /* 用户第二批指令第 1 条就是"先把密码取消了，我进去重新设置"。
   * 这条通道必须**永远**可用，否则家长会彻底进不去自己的设置。 */
  const rescue = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    // 先解锁进去，才点得到按钮
    document.getElementById("adminPasswordInput").value = "5678";
    document.querySelector("[data-action='admin-login']").click();
    await wait(300);
    const beforeEnabled = state.admin.passwordEnabled;
    document.querySelector("[data-action='disable-password']").click();
    await wait(350);
    return {
      beforeEnabled,
      afterEnabled: state.admin.passwordEnabled,
      passState: document.getElementById("adminPassState").textContent.replace(/\s+/g, " ").trim()
    };
  });
  check("点按钮前密码是启用状态（前提成立）", rescue.beforeEnabled === true);
  check("点「立即关闭密码」后 passwordEnabled 变 false", rescue.afterEnabled === false);
  check("状态文案立刻变成「当前没有启用密码」", /没有启用密码/.test(rescue.passState), rescue.passState.slice(0, 40));

  const reopen = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.querySelector("[data-action='admin-logout']").click();
    await wait(300);
    return {
      unlockedWithoutPass: adminUnlocked(),
      lockShown: !document.getElementById("adminLock").classList.contains("hidden"),
      panelShown: !document.getElementById("adminPanel").classList.contains("hidden")
    };
  });
  check("关掉密码后退出 → 免密直接进面板，家长再也锁不住自己",
    reopen.unlockedWithoutPass === true && reopen.lockShown === false && reopen.panelShown === true);
  check("关掉密码后旧密码 5678 仍然原样保留（下次想启用还是它）",
    (await page.evaluate(() => state.admin.password)) === "5678");

  // 最狠的一条：模拟"忘了密码又没读到锁页逃生口"的人 —— 刷新页面后依然进得去
  await page.reload({ waitUntil: "load" });
  await sleep(700);
  const afterReload = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll(".nav-item")].find(n => n.dataset.view === "admin").click();
    await wait(350);
    return {
      enabled: state.admin.passwordEnabled,
      panelShown: !document.getElementById("adminPanel").classList.contains("hidden"),
      lockShown: !document.getElementById("adminLock").classList.contains("hidden")
    };
  });
  check("关掉密码后**重启程序**依然免密（设置真的存下来了，不是内存假象）",
    afterReload.enabled === false && afterReload.panelShown === true && afterReload.lockShown === false);

  console.log("\n== 5. 老数据兼容：没有 passwordHistory 字段也不能崩 ==");
  const legacy = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("dailyWritingPcStateV3"));
    delete raw.admin.passwordHistory;
    delete raw.admin.passwordChangedAt;
    raw.admin.password = "9999";
    localStorage.setItem("dailyWritingPcStateV3", JSON.stringify(raw));
    const restored = loadState();
    return {
      pw: restored.admin.password,
      historyIsArray: Array.isArray(restored.admin.passwordHistory),
      changedAt: restored.admin.passwordChangedAt
    };
  });
  check("老数据里的密码被原样读回", legacy.pw === "9999", legacy.pw);
  check("缺失的 passwordHistory 被补成空数组（不是 undefined）", legacy.historyIsArray === true);
  check("缺失的 passwordChangedAt 被补成空字符串", legacy.changedAt === "", String(legacy.changedAt));

  // 最关键的一条：从来没有 passwordEnabled 字段的老数据，升级后必须是"不拦"
  const legacyGate = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("dailyWritingPcStateV3"));
    delete raw.admin.passwordEnabled;      // 模拟本功能上线之前存下的数据
    delete raw.admin.unlockedAt;
    localStorage.setItem("dailyWritingPcStateV3", JSON.stringify(raw));
    const restored = loadState();
    return { enabled: restored.admin.passwordEnabled, type: typeof restored.admin.passwordEnabled };
  });
  check("老数据没有 passwordEnabled 字段 → 补齐为 false（默认不拦）",
    legacyGate.enabled === false, String(legacyGate.enabled) + " / " + legacyGate.type);

  const unexpected = errors.filter(e => !/status of 40\d/.test(e));
  if (unexpected.length) unexpected.forEach(e => console.log("  " + e));
  check("无控制台报错", unexpected.length === 0, unexpected.length ? `${unexpected.length} 条` : "");

  console.log(`\n通过 ${pass.length} 项 / 失败 ${fail.length} 项`);
  if (fail.length) { console.log("失败项："); fail.forEach(f => console.log("  - " + f)); }

  await browser.close();
  process.exit(fail.length ? 1 : 0);
})().catch(err => { console.error("测试崩溃：", err); process.exit(2); });
