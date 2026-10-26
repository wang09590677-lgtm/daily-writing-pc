// 跟做视频持久化 + 休息固定视频（真实 Chrome，file:// 打开）
//
// 用户的两条要求：
//   1) 导入的跟做视频要**立即保存**，按钮从「导入跟做视频」变成「导入成功」，
//      而且**下次启动还在**（不能开一次导一次）。
//      → 做法：Blob 存 IndexedDB，启动时取回来重新 createObjectURL。
//      本测试会真的 reload 一次页面来验证。
//   2) 进入休息时间不再放简单图形，改放项目自带的
//      体能训练动作演示/中场休息.mp4（相对路径引用，永远有效）。
const path = require("path");
const fs = require("fs");
const puppeteer = require(path.join("C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules", "puppeteer-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INDEX = "file:///" + path.join(__dirname, "..", "index.html").replace(/\\/g, "/");
const PROFILE = path.join(__dirname, "probe-profile-video");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
}
// blob: URL 又长又乱，断言输出里只留开头一小段，看得清是哪个源
function s(url) {
  const t = String(url || "");
  if (!t) return "（无）";
  return t.length > 28 ? t.slice(0, 28) + "…" : t;
}

(async () => {
  // 干净的配置档：确保"下次启动还在"是真的持久化，而不是上次跑测试留下的
  if (fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
      "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + PROFILE, "--window-size=1440,900"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));

  async function boot() {
    await page.goto(INDEX, { waitUntil: "domcontentloaded" });
    await new Promise(r => setTimeout(r, 900));
    // 等 videoBootstrap 把内置/已存的视频装回来
    await page.evaluate(() => window.__booted || (window.__booted = videoBootstrap()));
    await new Promise(r => setTimeout(r, 400));
    await page.evaluate(() => { setView("fitnessToday"); renderFitnessToday(); });
    await new Promise(r => setTimeout(r, 200));
  }

  // ---------- 首次启动 ----------
  await boot();

  const first = await page.evaluate(() => {
    const m = state.fitness.videoMap || {};
    const b = state.fitness.builtinVideoMap || {};
    const exIds = Array.from(document.querySelectorAll(".fit-video-bar"))
      .map(el => el.dataset.ex).filter(Boolean);
    return {
      rest: state.fitness.restVideoUrl,
      builtinKeys: Object.keys(b).sort(),
      jump: m.jumpingJacks || "",
      jumpIsBuiltin: !!(b.jumpingJacks && m.jumpingJacks === b.jumpingJacks),
      exIds,
      withBuiltin: exIds.find(id => b[id]) || "",
      noBuiltin: exIds.find(id => !b[id]) || ""
    };
  });

  check("休息视频指向项目自带的 中场休息.mp4",
    /中场休息\.mp4$/.test(first.rest), first.rest);
  check("探测到项目自带的动作视频（开合跳/跳绳/平板支撑…）",
    first.builtinKeys.length >= 8, first.builtinKeys.join(","));
  check("开合跳直接可用自带的跟做视频",
    first.jumpIsBuiltin, first.jump);
  check("今天计划里能找到「没有自带视频」的项目（用来验证导入）",
    !!first.noBuiltin, `今日项目：${first.exIds.join(",")}；无自带的：${first.noBuiltin}`);

  // 休息视频真的能加载（相对路径可用）
  const restLoad = await page.evaluate(async () => {
    const ok = await window.VideoStore.probe(state.fitness.restVideoUrl);
    return ok;
  });
  check("中场休息.mp4 真的能加载（相对路径永远有效）", restLoad === true);

  // 界面上：自带视频的项目显示「导入成功」
  const ui1 = await page.evaluate(() => {
    const bars = Array.from(document.querySelectorAll(".fit-video-bar"));
    return {
      statusCount: bars.filter(b => /导入成功/.test(b.textContent)).length,
      importCount: bars.filter(b => /导入跟做视频/.test(b.textContent)).length,
      builtinTag: bars.filter(b => /项目自带/.test(b.textContent)).length
    };
  });
  check("有视频的项目按钮显示「导入成功」", ui1.statusCount > 0, `共 ${ui1.statusCount} 个`);
  check("自带视频被标为「项目自带」", ui1.builtinTag === ui1.statusCount, `标记 ${ui1.builtinTag} 个`);

  const TARGET = first.noBuiltin;     // 用它验证"导入 → 持久化 → 删除"
  console.log(`  用于导入测试的动作：${TARGET}`);

  // ---------- 模拟用户导入 ----------
  const imported = await page.evaluate(async (exId) => {
    // 造一个"用户的视频文件"（内容不重要，测的是持久化链路）
    const bytes = new Uint8Array(64 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 255;
    const file = new File([bytes], "我的跟练.mp4", { type: "video/mp4" });
    const res = await importVideo(exId, file);
    return { url: res.url, persisted: res.persisted, inMap: !!(state.fitness.videoMap[exId]) };
  }, TARGET);
  check("导入后立刻写进本机存储（IndexedDB）", imported.persisted === true,
    JSON.stringify(imported));
  check("导入后 videoMap 立刻可用（本次会话就能播）", imported.inMap === true);

  const ui2 = await page.evaluate((exId) => {
    const el = document.querySelector(`.fit-video-bar[data-ex="${exId}"]`);
    return {
      text: el ? el.textContent.replace(/\s+/g, " ").trim() : "",
      own: el ? /自己的视频/.test(el.textContent) : false,
      btnGone: el ? !el.querySelector("[data-action='import-video']") : false
    };
  }, TARGET);
  check("按钮从「导入跟做视频」变成「导入成功」", ui2.own && ui2.btnGone, ui2.text);

  // ---------- 关键：重新打开页面，导入的视频还在 ----------
  await boot();

  const second = await page.evaluate((exId) => {
    const url = (state.fitness.videoMap || {})[exId] || "";
    const el = document.querySelector(`.fit-video-bar[data-ex="${exId}"]`);
    return {
      url, isBlob: url.indexOf("blob:") === 0,
      own: el ? /自己的视频/.test(el.textContent) : false,
      status: el ? /导入成功/.test(el.textContent) : false
    };
  }, TARGET);
  check("★ 重新打开后，导入的跟做视频仍然存在（不用再导一次）",
    second.isBlob, second.url.slice(0, 24) + "...");
  check("重新打开后按钮依然是「导入成功（自己的视频）」",
    second.own && second.status, JSON.stringify(second));

  // 内容要真的一致（不是只存了个空壳）
  const sameBytes = await page.evaluate(async (exId) => {
    const blob = await new Promise(res => {
      const req = indexedDB.open("writingCoachVideos", 1);
      req.onsuccess = () => {
        const db = req.result;
        const q = db.transaction("videos", "readonly").objectStore("videos").get(exId);
        q.onsuccess = () => res(q.result || null);
        q.onerror = () => res(null);
      };
      req.onerror = () => res(null);
    });
    if (!blob) return { size: 0 };
    const buf = new Uint8Array(await blob.arrayBuffer());
    let ok = buf.length === 64 * 1024;
    for (let i = 0; i < buf.length; i += 1021) if (buf[i] !== ((i * 31) & 255)) ok = false;
    return { size: buf.length, ok };
  }, TARGET);
  check("存回来的视频字节与原文件一致", sameBytes.ok === true, JSON.stringify(sameBytes));

  // ---------- 删除后回落 ----------
  await page.evaluate((exId) => removeVideo(exId), TARGET);
  await new Promise(r => setTimeout(r, 400));
  const removed = await page.evaluate((exId) => {
    const el = document.querySelector(`.fit-video-bar[data-ex="${exId}"]`);
    return {
      url: (state.fitness.videoMap || {})[exId] || "",
      text: el ? el.textContent.replace(/\s+/g, " ").trim() : ""
    };
  }, TARGET);
  check("删除自己导入的视频后回到「导入跟做视频」",
    removed.url === "" && /导入跟做视频/.test(removed.text), JSON.stringify(removed));

  // 有自带视频的动作：删掉自己导入的应该回落到自带的
  const fallback = await page.evaluate(async (exId) => {
    const bytes = new Uint8Array(8 * 1024);
    const file = new File([bytes], "我的版本.mp4", { type: "video/mp4" });
    await importVideo(exId, file);
    const own = (state.fitness.videoMap || {})[exId];
    removeVideo(exId);
    await new Promise(r => setTimeout(r, 400));
    return {
      ownIsBlob: own.indexOf("blob:") === 0,
      after: (state.fitness.videoMap || {})[exId] || "",
      afterIsBuiltin: /^体能训练动作演示\//.test((state.fitness.videoMap || {})[exId] || "")
    };
  }, first.withBuiltin);
  check("删掉自己导入的版本后，回落到项目自带的",
    fallback.ownIsBlob && fallback.afterIsBuiltin, fallback.after);

  // ---------- 教练浮层：休息段改成了纯倒计时（不再播任何视频/动画） ----------
  const coach = await page.evaluate(async (exId) => {
    const rest = state.fitness.restVideoUrl;
    const work = state.fitness.videoMap[exId];
    window.CoachTimer.open({
      exId: exId, name: "开合跳", emoji: "⭐", how: "test",
      prep: false,                        // 本用例只验分段，跳过开练准备
      segments: [
        { kind: "work", seconds: 4, exId: exId },
        { kind: "rest", seconds: 4 }
      ],
      seconds: 8, restUrl: rest, videoUrls: { [exId]: work }
    });
    window.CoachTimer.update(8);          // 进入第 0 段（运动）
    await new Promise(r => setTimeout(r, 250));
    const v = document.getElementById("coachVideo");
    const workState = { src: v.getAttribute("src") || "", hidden: v.classList.contains("hidden") };
    window.CoachTimer.update(3.5);        // 跨到第 1 段（休息）
    await new Promise(r => setTimeout(r, 350));
    const restState = {
      src: v.getAttribute("src") || "",
      hidden: v.classList.contains("hidden"),
      panel: !document.getElementById("coachRest").classList.contains("hidden"),
      panelCount: document.getElementById("coachRestCount").textContent.trim()
    };
    const cvHidden = document.getElementById("coachCanvas").classList.contains("hidden");
    window.CoachTimer.close();
    return { workState, restState, cvHidden, rest, work };
  }, first.withBuiltin);
  check("运动段播该动作自己的跟做视频",
    coach.workState.src === coach.work && coach.workState.hidden === false,
    `${coach.workState.src}（期望 ${coach.work}）`);
  check("★ 休息段不再播视频，换成纯倒计时面板（按需求改）",
    coach.restState.hidden === true && coach.restState.src === "" && coach.restState.panel === true,
    `视频hidden=${coach.restState.hidden} src=「${coach.restState.src}」 面板=${coach.restState.panel} ${coach.restState.panelCount}`);
  check("放视频时画布动画被隐藏", coach.cvHidden === true);

  // ---------- 循环训练块：每个小项都要能单独导入跟做视频 ----------
  /* 用户第二批指令第 2 条后半句原文：
   *   "另外循环训练的跟做视频也得能导入"
   * 循环块（周六「综合挑战日」）不是一个动作，而是好几个动作轮流做，
   * 所以导入入口必须**逐项**给：导入「靠墙静蹲」只影响靠墙静蹲那一段，
   * 不能整块只有一个入口、也不能导入一个就把其他段也换了。
   * 而且每一项都得有入口 —— 包括项目自带视频的那些动作，否则家长想换成
   * 自己拍的版本时根本点不到按钮（本测试第一次跑就是这么暴露出来的）。 */
  console.log("\n== 循环训练块：逐项导入跟做视频 ==");

  // 真视频：用项目自带的一个小文件当"家长导入的视频"。
  // 假字节（随便填 0/255）解不出来 → <video> 触发 error 回落画布，
  // 那样验不了"这一段真的在播这个视频"，所以必须用能解码的 mp4。
  const REAL_MP4 = fs.readFileSync(path.join(__dirname, "..", "体能训练动作演示", "小腿拉伸.mp4")).toString("base64");

  // 循环块取自教案（周六那天 main 里带 circuit 的那一行），与 app.js 的构造保持一致。
  // 这段要注入两次（reload 之后页面 JS 全没了），所以写成字符串复用。
  const CIRCUIT_HELPER = `(() => {
    const sat = (window.FITNESS_PLAN || []).find(d => (d.main || []).some(r => r && r.circuit));
    const row = sat && sat.main.find(r => r && r.circuit);
    if (!row) { window.__circuitBlock = null; return { ok: false }; }
    window.__circuitBlock = {
      id: "sat:main:0", group: "main", circuit: true,
      rounds: row.circuit, rest: row.rest,
      items: row.items.map(it => {
        const ex = window.FITNESS_EX[it[0]] || {};
        return { ex: it[0], name: ex.name || it[0], emoji: ex.emoji || "", unit: ex.unit || "", target: it[1] };
      })
    };
    window.__paintCircuit = function () {
      let host = document.getElementById("__circuitHost");
      if (!host) {
        host = document.createElement("div");
        host.id = "__circuitHost";
        host.style.cssText = "position:fixed;left:-9999px;top:0;width:900px";
        document.body.appendChild(host);
      }
      host.innerHTML = fitBlockHtml(window.__circuitBlock, new Set(), new Set());
      return host;
    };
    // 某一行现在显示成什么（按 exId 反查那一行）
    window.__rowText = function (exId) {
      const host = document.getElementById("__circuitHost");
      const bar = host && host.querySelector('.fit-ci-row .fit-video-bar[data-ex="' + exId + '"]');
      const wrap = bar ? bar.closest(".fit-ci-row") : null;
      return wrap ? wrap.textContent.replace(/\\s+/g, " ").trim() : "";
    };
    window.__importedRowCount = function () {
      const host = document.getElementById("__circuitHost");
      return host ? Array.from(host.querySelectorAll(".fit-ci-row")).filter(r => /已导入/.test(r.textContent)).length : -1;
    };
    return { ok: true, itemCount: window.__circuitBlock.items.length };
  })()`;

  await page.evaluate(CIRCUIT_HELPER);

  const hookImport = await page.evaluate(() => {
    // 把「点导入按钮」这一步拦下来，只记下它要导入哪个动作（避免真弹系统文件框）
    const realAppend = document.body.appendChild.bind(document.body);
    document.body.appendChild = function (el) {
      if (el && el.tagName === "INPUT" && el.type === "file") {
        el.click = function () { window.__lastImportEx = el.dataset.ex; };
      }
      return realAppend(el);
    };
    window.__paintCircuit();
    const host = document.getElementById("__circuitHost");
    const rows = Array.from(host.querySelectorAll(".fit-ci-row"));
    const block = window.__circuitBlock;
    return {
      found: !!block,
      blockTitle: (host.querySelector(".fit-block-name") || {}).textContent || "",
      rowCount: rows.length,
      itemCount: block.items.length,
      itemEx: block.items.map(it => it.ex),
      // 每行的导入入口按钮：data-ex 必须对上那一行的动作
      rowEx: rows.map(r => {
        const b = r.querySelector("[data-action='import-video']");
        return b ? b.dataset.ex : "";
      }),
      distinctButtons: new Set(rows.map(r => r.querySelector("[data-action='import-video']"))
        .filter(Boolean).map(b => b.dataset.ex)).size,
      btnCount: rows.filter(r => r.querySelector("[data-action='import-video']")).length,
      hint: (host.querySelector(".fit-ci-video-hint") || {}).textContent || ""
    };
  });

  check("教案里能找到循环块并渲染出来", hookImport.found === true);
  if (!hookImport.found) {
    check("循环块逐项导入（前置条件缺失）", false, "教案里没有 circuit 行");
  } else {
    check("循环块每个小项 = 一行", hookImport.rowCount === hookImport.itemCount,
      `${hookImport.rowCount} 行 / ${hookImport.itemCount} 个动作`);
    check("★ 每一行都有自己的导入入口，且 data-ex 对上该行的动作",
      hookImport.btnCount === hookImport.itemCount &&
      hookImport.rowEx.join(",") === hookImport.itemEx.join(",") &&
      hookImport.distinctButtons === hookImport.itemCount,
      `各行按钮：${hookImport.rowEx.join(",")}（${hookImport.btnCount}/${hookImport.itemCount} 行有按钮）`);
    check("循环块最上面仍然标明是「循环训练」",
      /循环训练/.test(hookImport.blockTitle), hookImport.blockTitle);
    check("提示写明每个动作都能单独导入（不导入/自带的情况也交代了）",
      /单独导入/.test(hookImport.hint), hookImport.hint);
  }

  // 点某一行的导入按钮 → 应该只针对那一行的动作
  const clickEx = hookImport.found ? hookImport.itemEx[0] : "";
  if (clickEx) {
    const clicked = await page.evaluate((exId) => {
      const host = document.getElementById("__circuitHost");
      const btn = host.querySelector(`.fit-ci-row [data-action='import-video'][data-ex="${exId}"]`);
      if (!btn) return { found: false };
      btn.click();
      return { found: true, target: window.__lastImportEx || "" };
    }, clickEx);
    check("点某行的「导入视频」，交给文件选择器的是该行的动作（不是整块共用）",
      clicked.found === true && clicked.target === clickEx,
      `点了 ${clickEx} 行 → 目标 ${clicked.target}`);
  }

  /* 逐项独立性：A 行导入后只动 A 行。
   * A 选一个原本没有视频的动作（换上去的变化最明显），
   * B 选一个项目自带视频的动作（用来看"别的行没被动过"）。 */
  const exA = hookImport.itemEx.find(e => !first.builtinKeys.includes(e)) || hookImport.itemEx[0];
  const exB = hookImport.itemEx.find(e => e !== exA && first.builtinKeys.includes(e))
    || hookImport.itemEx.find(e => e !== exA) || "";
  console.log(`  循环块逐项导入测试：A=${exA}（原本没视频）  B=${exB}（项目自带）`);

  const perItem = await page.evaluate(async (a, b, b64) => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], "我拍的跟练.mp4", { type: "video/mp4" });
    await importVideo(a, file);
    await wait(200);
    window.__paintCircuit();
    const map = state.fitness.videoMap || {};
    const builtinB = (state.fitness.builtinVideoMap || {})[b] || "";
    return {
      aUrl: map[a] || "", aIsBlob: (map[a] || "").indexOf("blob:") === 0,
      bUrl: map[b] || "", builtinB,
      aRow: window.__rowText(a), bRow: b ? window.__rowText(b) : "",
      hint: (document.querySelector("#__circuitHost .fit-ci-video-hint") || {}).textContent || "",
      importedRows: window.__importedRowCount()
    };
  }, exA, exB, REAL_MP4);

  check("循环块里导入一个动作后，videoMap 立刻有它自己的 blob",
    perItem.aIsBlob === true, s(perItem.aUrl));
  check("被导入的那一行变成「已导入 + 删除」",
    /已导入/.test(perItem.aRow) && /删除/.test(perItem.aRow),
    perItem.aRow.slice(0, 60));
  if (exB) {
    check("★ 其他各行不受影响（B 行仍是自带那版，videoMap 没被改动）",
      !/已导入/.test(perItem.bRow) && perItem.bUrl === perItem.builtinB,
      `B 行：${perItem.bRow.slice(0, 56)} | videoMap=${s(perItem.bUrl)}（自带=${s(perItem.builtinB)}）`);
    check("循环块只统计了 1 行已导入（不是整块一起变）",
      perItem.importedRows === 1, `已导入 ${perItem.importedRows} 行`);
    check("提示文案跟着更新为「已导入 1/N 个」",
      /已导入 1\//.test(perItem.hint), perItem.hint);
  }

  // 关键：跑起来时，每一段都必须播**那一段自己**的视频
  const perSegVideo = await page.evaluate(async (a, b) => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const block = window.__circuitBlock;
    const plan = fitPlanFor(block);
    const cum = idx => plan.segments.slice(0, idx).reduce((s, x) => s + x.seconds, 0);
    const total = plan.segments.reduce((s, x) => s + x.seconds, 0);
    const firstWorkIdx = ex => plan.segments.findIndex(s => s.kind === "work" && s.exId === ex);
    const idxA = firstWorkIdx(a);
    const idxB = firstWorkIdx(b);
    if (idxA < 0 || idxB < 0) return { found: false };

    window.CoachTimer.open({
      exId: block.items[0].ex, name: "循环训练", emoji: "🔁", how: "test",
      prep: false,
      segments: plan.segments, seconds: total,
      videoUrls: Object.assign({}, state.fitness.videoMap),
      restUrl: ""
    });
    const v = document.getElementById("coachVideo");
    const at = async idx => {
      window.CoachTimer.update(total - cum(idx) - 0.2);
      await wait(260);
      return {
        src: v.getAttribute("src") || "",
        hidden: v.classList.contains("hidden"),
        playing: !v.paused
      };
    };
    const sA = await at(idxA);
    const sB = await at(idxB);
    // 再回到 A 那一轮（第 2 轮的同一个动作），确认不是"一次性"
    const idxA2 = plan.segments.findIndex((s, i) => i > idxB && s.kind === "work" && s.exId === a);
    const sA2 = idxA2 >= 0 ? await at(idxA2) : null;
    window.CoachTimer.close();
    return {
      found: true, idxA, idxB,
      sA, sB, sA2,
      urlA: (state.fitness.videoMap || {})[a] || "",
      urlB: (state.fitness.videoMap || {})[b] || ""
    };
  }, exA, exB || exA);

  check("循环块在浮层里能按段找到对应动作", perSegVideo.found === true,
    `段 ${perSegVideo.idxA} / ${perSegVideo.idxB}`);
  if (perSegVideo.found) {
    check("★ 循环训练跑到「自己导入」的那一段时，播的就是这个动作自己的视频",
      perSegVideo.sA.src === perSegVideo.urlA && perSegVideo.sA.hidden === false,
      `实际 ${s(perSegVideo.sA.src)} vs 期望 ${s(perSegVideo.urlA)}（hidden=${perSegVideo.sA.hidden}）`);
    check("这一段真的在播（不是停在首帧的黑块）", perSegVideo.sA.playing === true);
    if (exB) {
      check("★ 换到另一个动作时视频跟着换（每段播自己的，不会一直播同一个）",
        perSegVideo.sB.src !== perSegVideo.sA.src && perSegVideo.sB.src === perSegVideo.urlB,
        `${s(perSegVideo.sA.src)} → ${s(perSegVideo.sB.src)}（期望 B=${s(perSegVideo.urlB)}）`);
    }
    if (perSegVideo.sA2) {
      check("第二轮回到同一个动作时，又切回它自己的视频",
        perSegVideo.sA2.src === perSegVideo.urlA,
        s(perSegVideo.sA2.src));
    }
  }

  // ---------- 逐项导入也要「下次打开还在」 ----------
  if (exB) {
    await page.evaluate(async (b, b64) => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      await importVideo(b, new File([bytes], "我拍的B.mp4", { type: "video/mp4" }));
      await new Promise(r => setTimeout(r, 250));
    }, exB, REAL_MP4);
    await boot();
    await page.evaluate(CIRCUIT_HELPER);
    const afterReload = await page.evaluate((a, b) => {
      window.__paintCircuit();
      const map = state.fitness.videoMap || {};
      return {
        aBlob: (map[a] || "").indexOf("blob:") === 0,
        bBlob: (map[b] || "").indexOf("blob:") === 0,
        rowsImported: window.__importedRowCount(),
        hint: (document.querySelector("#__circuitHost .fit-ci-video-hint") || {}).textContent || ""
      };
    }, exA, exB);
    check("★ 重新打开后，循环块里两个动作导入的视频都还在（逐项持久化）",
      afterReload.aBlob === true && afterReload.bBlob === true,
      JSON.stringify(afterReload));
    check("重开后循环块显示「已导入 2/N 个」",
      afterReload.rowsImported === 2 && /已导入 2\//.test(afterReload.hint),
      `${afterReload.rowsImported} 行 | ${afterReload.hint}`);
  }

  // 删除其中一个 → 只回落那一行
  const afterRemove = await page.evaluate(async (a, b) => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    removeVideo(a);
    await wait(450);
    window.__paintCircuit();
    return {
      aRow: window.__rowText(a),
      bRow: b ? window.__rowText(b) : "",
      aUrl: (state.fitness.videoMap || {})[a] || "",
      importedRows: window.__importedRowCount()
    };
  }, exA, exB || exA);
  check("删掉某一项的视频后，那一行回到「导入视频」",
    /导入视频/.test(afterRemove.aRow) && afterRemove.aUrl === "",
    afterRemove.aRow.slice(0, 50));
  if (exB) {
    check("删一项不影响另一项（其余行仍是「已导入」）",
      /已导入/.test(afterRemove.bRow) && afterRemove.importedRows === 1,
      `B 行：${afterRemove.bRow.slice(0, 50)} | 已导入 ${afterRemove.importedRows} 行`);
    await page.evaluate(b => removeVideo(b), exB);
  }

  // 收尾：摘掉临时宿主
  await page.evaluate(() => {
    const host = document.getElementById("__circuitHost");
    if (host) host.remove();
  });

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) { failed.forEach(f => console.log("  FAIL:", f.name, f.detail || "")); process.exit(1); }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
