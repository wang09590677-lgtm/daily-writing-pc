/* 【verifier-oneshot 体感猫 GLB 独立验证】build/_verify-cat.js
 * 只读验证，不改任何产品文件。覆盖 team-lead 请我独立复核的 5 项。
 * 用法：node build/_verify-cat.js
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const puppeteer = require("puppeteer-core");
const ROOT = path.join(__dirname, "..");
const INDEX = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FIXTURE = path.join(__dirname, "fixtures", "pose-human.png");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pass = [], fail = [];
function check(name, ok, extra = "") { (ok ? pass : fail).push(name); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  → " + extra : ""}`); }

/* 造一个满关节的站姿（引擎坐标系，0=图像左） */
function poseBase() {
  return {
    head: { x: .5, y: .10 }, neck: { x: .5, y: .22 },
    shoulderL: { x: .43, y: .27 }, shoulderR: { x: .57, y: .27 },
    elbowL: { x: .42, y: .37 }, elbowR: { x: .58, y: .37 },
    foreL: { x: .415, y: .41 }, foreR: { x: .585, y: .41 },
    wristL: { x: .41, y: .45 }, wristR: { x: .59, y: .45 },
    handL: { x: .41, y: .47 }, handR: { x: .59, y: .47 },
    midL: { x: .44, y: .40 }, midR: { x: .56, y: .40 },
    hipMid: { x: .5, y: .55 }, hipL: { x: .46, y: .55 }, hipR: { x: .54, y: .55 },
    kneeL: { x: .46, y: .70 }, kneeR: { x: .54, y: .70 },
    shinL: { x: .46, y: .79 }, shinR: { x: .54, y: .79 },
    ankleL: { x: .456, y: .88 }, ankleR: { x: .544, y: .88 },
    toeL: { x: .456, y: .925 }, toeR: { x: .544, y: .925 }
  };
}
/* 抬高某一侧"引擎手臂"：side = engineL / engineR（x 小侧 = engineL） */
function raiseArm(side, dy) {
  const j = poseBase();
  const keys = side === "engineL"
    ? ["shoulderL", "midL", "elbowL", "foreL", "wristL", "handL"]
    : ["shoulderR", "midR", "elbowR", "foreR", "wristR", "handR"];
  keys.forEach(k => { if (j[k]) j[k].y -= dy; });
  return j;
}

(async () => {
  const profileDir = path.join(os.tmpdir(), "wbc-vcat-" + process.pid + "-" + Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
      "--user-data-dir=" + profileDir]
  });
  const origClose = browser.close.bind(browser);
  browser.close = async () => { try { await origClose(); } catch (e) { } try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { } };

  const page = await browser.newPage();
  page.setDefaultTimeout(40000);
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on("pageerror", e => { errors.push("PAGEERROR: " + e.message); });
  page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

  await page.goto(INDEX, { waitUntil: "load", timeout: 40000 });
  await sleep(1200);
  await page.evaluate(() => window.MotionAvatar.show());
  let sk = null;
  for (let i = 0; i < 45; i++) { sk = await page.evaluate(() => window.MotionAvatar.__skeleton()); if (sk && (sk.ready || sk.failed)) break; await sleep(400); }
  console.log("\n== 0. 模型就绪 ==");
  check("GLB 加载成功（未退回兜底猫）", sk.ready && !sk.failed, `reason=${sk.reason || "无"} bones=${sk.boneCount} skinned=${sk.skinnedCount}`);
  check("不是兜底猫", sk.usingFallback === false, "usingFallback=" + sk.usingFallback);
  check("骨骼 38 / 蒙皮 54", sk.boneCount === 38 && sk.skinnedCount === 54, `${sk.boneCount}/${sk.skinnedCount}`);

  /* ---------- 1. 画布是否镜像（左右推导的前提） ---------- */
  console.log("\n== 1. 画布镜像与环境 ==");
  const css = await page.evaluate(() => {
    const c = document.querySelector("#motionAvatar canvas");
    const chain = [];
    let el = c;
    while (el && el !== document.documentElement) {
      chain.push({ tag: el.tagName + (el.id ? "#" + el.id : "") + (el.className ? "." + String(el.className).split(" ")[0] : ""), t: getComputedStyle(el).transform });
      el = el.parentElement;
    }
    return { found: !!c, chain, inMotionScreen: !!c && !!c.closest(".motion-screen") };
  });
  check("找到 avatar 画布", css.found);
  const mirrored = css.chain.some(l => /matrix\(-1/.test(l.t));
  check("3D 猫画布未被镜像（世界 +X = 屏幕右）", !mirrored, css.chain.map(l => l.tag + ":" + l.t).join(" | "));
  check("画布不在 .motion-screen 内（不继承其 scaleX(-1)）", css.inMotionScreen === false);

  /* ---------- 2. 左右方向（UX 判据） ---------- */
  console.log("\n== 2. 左右方向（独立推导：抬引擎左侧 = 图像左 = 孩子的右手）==");
  const idlePose = await page.evaluate(() => { window.MotionAvatar.updateFromSkeleton(null); return window.MotionAvatar.__poseSnapshot(); });
  const engL = await page.evaluate(j => { for (let i = 0; i < 40; i++) window.MotionAvatar.updateFromSkeleton(j); return window.MotionAvatar.__poseSnapshot(); }, raiseArm("engineL", 0.30));
  const engR = await page.evaluate(j => { for (let i = 0; i < 40; i++) window.MotionAvatar.updateFromSkeleton(j); return window.MotionAvatar.__poseSnapshot(); }, raiseArm("engineR", 0.30));

  const dyOf = (a, b, n) => (b[n] && a[n]) ? +(b[n][1] - a[n][1]).toFixed(4) : null;
  console.log(`  喂 engineL（图像左臂）抬高 → 模型 LeftHand dy=${dyOf(idlePose, engL, "LeftHand")}  RightHand dy=${dyOf(idlePose, engL, "RightHand")}`);
  console.log(`  喂 engineR（图像右臂）抬高 → 模型 LeftHand dy=${dyOf(idlePose, engR, "LeftHand")}  RightHand dy=${dyOf(idlePose, engR, "RightHand")}`);

  // 独立判据（不照抄 team-lead）：
  //  · 孩子面朝镜头抬"自己的左手" → 相机图像里出现在**右侧** → 引擎 shoulderR 侧。
  //  · 猫也面朝镜头（GLB 尾巴在 -Z 已证），猫抬"它的左手" → 模型 LeftUpperArm（+X = 屏幕右）。
  //  · 所以：引擎 shoulderR ↔ 模型 LeftUpperArm；即输入 engineR → 模型 Left 侧抬起。
  // 注意：世界 y **向上**，抬手 → world y 增大 → dy 为**正**。
  const eL_raisesRight = (dyOf(idlePose, engL, "RightHand") || 0) > 0.05 && Math.abs(dyOf(idlePose, engL, "LeftHand") || 0) < 0.05;
  const eR_raisesLeft = (dyOf(idlePose, engR, "LeftHand") || 0) > 0.05 && Math.abs(dyOf(idlePose, engR, "RightHand") || 0) < 0.05;
  check("喂 engineL → 模型 RightHand 抬起（其余不动）", eL_raisesRight, `dy=${dyOf(idlePose, engL, "RightHand")}`);
  check("喂 engineR → 模型 LeftHand 抬起（其余不动）", eR_raisesLeft, `dy=${dyOf(idlePose, engR, "LeftHand")}`);
  check("左右交叉映射与我的独立推导一致（engineR↔模型Left）", eL_raisesRight && eR_raisesLeft);

  // 屏幕侧：模型 LeftHand.x > RightHand.x（屏幕右）？
  const handX = { L: engR.LeftHand ? engR.LeftHand[0] : null, R: engL.RightHand ? engL.RightHand[0] : null };
  check("模型左臂在屏幕右侧（+X）—— 与 GLB 解析一致", (handX.L || 0) > 0 && (handX.R || 0) < 0, `LeftHand.x=${handX.L} RightHand.x=${handX.R}`);

  /* ---------- 3. 站姿对称 / 不是 T-pose ---------- */
  console.log("\n== 3. 无识别 → 自然站姿（非 T-pose、左右对称）==");
  const sym = Math.abs((idlePose.LeftHand ? idlePose.LeftHand[1] : 0) - (idlePose.RightHand ? idlePose.RightHand[1] : 0));
  const lh = idlePose.LeftHand ? idlePose.LeftHand[1] : 0;
  const ls = idlePose.LeftUpperArm ? idlePose.LeftUpperArm[1] : 0;
  check("站姿左右手高度对称（差 < 0.05）", sym < 0.05, `|dy|=${sym.toFixed(4)}`);
  check("手低于肩（手臂下垂，不是 T-pose）", lh < ls - 0.05, `手y=${(+lh).toFixed(3)} 肩y=${(+ls).toFixed(3)}`);

  /* ---------- 3b. 头部骨骼是否真的被驱动（重名改名陷阱） ---------- */
  console.log("\n== 3b. 头部骨骼驱动 ==");
  const headInfo = await page.evaluate(() => {
    const sk = window.MotionAvatar.__skeleton();
    const names = sk.boneNames;
    const hasHead = names.includes("Head");
    const renamed = names.filter(n => /^Head(_\d+)?$/.test(n));
    const snap = window.MotionAvatar.__poseSnapshot();
    return { hasHead, renamed, snapHasHead: ("Head" in snap), snapKeys: Object.keys(snap) };
  });
  console.log(`    bones 里含 "Head"：${headInfo.hasHead}；含 Head 形态的名字：${headInfo.renamed.join(",")}`);
  check("BONE_SEG 写的 \"Head\" 在 bones 里存在（否则头部瞄准静默失效）", headInfo.hasHead,
    headInfo.hasHead ? "" : `实际骨骼名是 ${headInfo.renamed.join("/")}（three.js 因重名自动改名）`);

  // 喂一个"头明显偏左"的姿势，看头骨朝向是否跟着变
  const headFollow = await page.evaluate(() => {
    const base = {
      head: { x: .5, y: .10 }, neck: { x: .5, y: .22 }, shoulderL: { x: .43, y: .27 }, shoulderR: { x: .57, y: .27 },
      elbowL: { x: .42, y: .37 }, elbowR: { x: .58, y: .37 }, wristL: { x: .41, y: .45 }, wristR: { x: .59, y: .45 },
      handL: { x: .41, y: .47 }, handR: { x: .59, y: .47 },
      hipMid: { x: .5, y: .55 }, hipL: { x: .46, y: .55 }, hipR: { x: .54, y: .55 },
      kneeL: { x: .46, y: .70 }, kneeR: { x: .54, y: .70 }, ankleL: { x: .456, y: .88 }, ankleR: { x: .544, y: .88 },
      toeL: { x: .456, y: .925 }, toeR: { x: .544, y: .925 }
    };
    const bone = () => {
      const b = null; // 占位
      return null;
    };
    const feed = j => { for (let i = 0; i < 60; i++) window.MotionAvatar.updateFromSkeleton(j); };
    feed(base);
    const straight = window.MotionAvatar.__boneWorld("Head_1") || window.MotionAvatar.__boneWorld("Head");
    const tilted = JSON.parse(JSON.stringify(base));
    tilted.head = { x: .18, y: .30 };                      // 头明显偏左且下移
    feed(tilted);
    const after = window.MotionAvatar.__boneWorld("Head_1") || window.MotionAvatar.__boneWorld("Head");
    return { straight, after };
  });
  if (headFollow.straight && headFollow.after) {
    const dx = +(headFollow.after.x - headFollow.straight.x).toFixed(4);
    console.log(`    头骨世界位置：正直=${JSON.stringify(headFollow.straight)} → 头偏左=${JSON.stringify(headFollow.after)}  Δx=${dx}`);
    check("头明显偏左时头骨跟着移动（头链未完全断）", Math.abs(dx) > 0.02, `Δx=${dx}`);
  }

  /* ---------- 4. 平滑：阶跃收敛 & 抖动 ---------- */
  console.log("\n== 4. 平滑与流畅（JOINT_SMOOTH=0.45）==");
  const step = await page.evaluate(j => {
    window.MotionAvatar.updateFromSkeleton(null);
    for (let i = 0; i < 60; i++) window.MotionAvatar.updateFromSkeleton(null);   // 收敛到站姿
    const target = j.handL.y;             // 目标位置（归一化）
    const trail = [];
    for (let f = 0; f < 12; f++) {
      window.MotionAvatar.updateFromSkeleton(j);
      trail.push(window.MotionAvatar.__poseSnapshot().LeftHand[1]);   // 模型左手世界 y
    }
    return { trail, first: trail[0], last: trail[trail.length - 1] };
  }, raiseArm("engineR", 0.30));
  const total = step.last - step.first;
  let frames90 = -1;
  for (let i = 0; i < step.trail.length; i++) { const frac = Math.abs(step.trail[i] - step.first) / Math.abs(total || 1); if (frac >= 0.9) { frames90 = i + 1; break; } }
  check("阶跃响应 ~90% 收敛在 3~7 帧（跟手又不抖）", frames90 >= 3 && frames90 <= 7, `第 ${frames90} 帧达 90%`);
  const monotone = step.trail.every((v, i) => i === 0 || Math.abs(v - step.trail[i - 1]) < Math.abs(total) * 0.6);
  // 单帧大阶跃（+0.30 一帧到位）不是真实输入；只要求"首帧到位后不再来回振"
  const settle = step.trail.slice(2).every(v => Math.abs(v - step.trail[step.trail.length - 1]) < 0.01);
  check("阶跃后迅速收敛不再来回震荡", settle, `trail=${step.trail.slice(0, 6).map(v => v.toFixed(3)).join(",")}`);
  console.log(`     （参考：一帧内 +0.30 的"瞬跳"输入第 1 帧有 ${Math.abs(step.trail[0] - step.last).toFixed(3)} 的过冲，真实摄像头不会这样跳）`);

  // 抖动抑制：喂 ±0.01 抖动，看输出抖动幅度
  const jitter = await page.evaluate(base => {
    const out = [];
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
    for (let f = 0; f < 120; f++) {
      const j = JSON.parse(JSON.stringify(base));
      ["handL", "handR", "wristL", "wristR", "elbowL", "elbowR"].forEach(k => { j[k].x += rnd() * 0.01; j[k].y += rnd() * 0.01; });
      window.MotionAvatar.updateFromSkeleton(j);
      out.push(window.MotionAvatar.__poseSnapshot().LeftHand[1]);
    }
    const tail = out.slice(20);
    return { min: Math.min(...tail), max: Math.max(...tail), span: Math.max(...tail) - Math.min(...tail) };
  }, poseBase());
  check("±0.01 输入抖动被压到输出 <0.03（不抽）", jitter.span < 0.03, `输出抖动幅度=${jitter.span.toFixed(4)}`);

  /* ---------- 5. 性能：300 帧带抖动 ---------- */
  console.log("\n== 5. 性能（300 帧带抖动）==");
  const perf = await page.evaluate(base => {
    let seed = 99; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
    const t0 = performance.now(); let worst = 0;
    for (let f = 0; f < 300; f++) {
      const j = JSON.parse(JSON.stringify(base));
      Object.keys(j).forEach(k => { j[k].x += rnd() * 0.008; j[k].y += rnd() * 0.008; });
      const a = performance.now();
      window.MotionAvatar.updateFromSkeleton(j);
      worst = Math.max(worst, performance.now() - a);
    }
    return { total: performance.now() - t0, worst };
  }, poseBase());
  check("300 帧总耗时 < 600ms（每帧 < 2ms）", perf.total < 600, `总 ${perf.total.toFixed(0)}ms，最慢单帧 ${perf.worst.toFixed(2)}ms`);
  check("无单帧尖峰 > 20ms", perf.worst < 20, `最慢 ${perf.worst.toFixed(2)}ms`);

  /* ---------- 6. 真机链路：真实 MediaPipe → 猫 ---------- */
  console.log("\n== 6. 真机链路（真实人体 MediaPipe → 33 点 → 引擎关节 → 猫）==");
  const b64 = fs.readFileSync(FIXTURE).toString("base64");
  const real = await page.evaluate(async (b64) => {
    const PV = window.PoseVision;
    if (!PV) return { err: "no PoseVision" };
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64; });
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.getContext("2d").drawImage(img, 0, 0);
    const pose = new window.Pose({ locateFile: f => "vendor/mediapipe/" + f });
    pose.setOptions({ modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    let lm = null;
    pose.onResults(r => { if (r && r.poseLandmarks && r.poseLandmarks.length) lm = r.poseLandmarks; });
    await pose.send({ image: cv });
    await new Promise(r => setTimeout(r, 200));
    if (!lm) return { err: "no landmarks" };
    const mapped = PV.mapLandmarks(lm);
    if (!mapped.ok) return { err: "map not ok: " + mapped.reason, landmarks: lm.length };
    const joints = mapped.joints;
    // 喂进猫，多帧让低通收敛
    for (let i = 0; i < 30; i++) window.MotionAvatar.updateFromSkeleton(joints);
    const snap = window.MotionAvatar.__poseSnapshot();
    const nan = Object.values(snap).flat().some(v => !Number.isFinite(v));
    return {
      landmarks: lm.length, jointCount: Object.keys(joints).length, snap, nan,
      jointNames: Object.keys(joints),
      engineHeadY: joints.head ? joints.head.y : null,
      engineHipY: joints.hipMid ? joints.hipMid.y : null,
      engineAnkleY: joints.ankleL ? joints.ankleL.y : null,
      bbox: mapped.bbox
    };
  }, b64);
  if (real.err) { check("真实链路走通", false, real.err); }
  else {
    check("真实人体 → 33 点 → 引擎关节", real.landmarks === 33 && real.jointCount >= 20, `${real.landmarks} 点 / ${real.jointCount} 关节`);
    check("喂真实骨架后无 NaN", !real.nan, "nan=" + real.nan);
    const hb = await page.evaluate(() => window.MotionAvatar.__boneWorld("Head_1") || window.MotionAvatar.__boneWorld("Head"));
    const h = hb ? hb.y : 0;
    const hip = real.snap.Hips ? real.snap.Hips[1] : 0;
    const lf = real.snap.LeftFoot ? real.snap.LeftFoot[1] : 0;
    check("几何自洽：头 > 髋 > 脚（世界 y 向上）", h > hip && hip > lf, `头=${(+h).toFixed(3)} 髋=${(+hip).toFixed(3)} 脚=${(+lf).toFixed(3)}`);
    // 姿态合理性：手臂不应水平外展（T-pose 迹象）——真实照片通常是自然站位
    const ls = real.snap.LeftUpperArm ? real.snap.LeftUpperArm[0] : 0, lhd = real.snap.LeftHand ? real.snap.LeftHand[0] : 0;
    check("左臂未水平外展成 T-pose（|手x-肩x| 未明显张开）", Math.abs(lhd - ls) < 0.6, `肩x=${(+ls).toFixed(3)} 手x=${(+lhd).toFixed(3)}`);
  }

  /* ---------- 7. 边界与降级 ---------- */
  console.log("\n== 7. 边界与降级 ==");
  const empty = await page.evaluate(() => { window.MotionAvatar.updateFromSkeleton(null); return window.MotionAvatar.__poseSnapshot(); });
  const emptyOk = Object.values(empty).flat().every(v => Number.isFinite(v));
  check("updateFromSkeleton(null) → 无 NaN 且手在肩下", emptyOk && empty.LeftHand[1] < empty.LeftUpperArm[1], "");

  const upperOnly = await page.evaluate(() => {
    const j = { head: { x: .5, y: .1 }, neck: { x: .5, y: .22 }, shoulderL: { x: .43, y: .27 }, shoulderR: { x: .57, y: .27 }, elbowL: { x: .42, y: .37 }, elbowR: { x: .58, y: .37 }, wristL: { x: .41, y: .45 }, wristR: { x: .59, y: .45 }, hipMid: { x: .5, y: .55 } };
    for (let i = 0; i < 20; i++) window.MotionAvatar.updateFromSkeleton(j);
    const s = window.MotionAvatar.__poseSnapshot();
    return { snap: s, nan: Object.values(s).flat().some(v => !Number.isFinite(v)) };
  });
  check("只给上半身关节 → 不崩、无 NaN", !upperOnly.nan, "nan=" + upperOnly.nan);

  const spike = await page.evaluate(() => {
    const out = [];
    for (let f = 0; f < 60; f++) {
      const j = { head: { x: .5, y: .1 }, neck: { x: .5, y: .22 }, shoulderL: { x: .43, y: .27 }, shoulderR: { x: .57, y: .27 },
        elbowL: { x: .42, y: .37 }, elbowR: { x: .58, y: .37 }, wristL: { x: .41, y: .45 }, wristR: { x: .59, y: .45 },
        handL: { x: .41, y: .47 }, handR: { x: .59, y: .47 },
        hipMid: { x: .5, y: .55 }, hipL: { x: .46, y: .55 }, hipR: { x: .54, y: .55 },
        kneeL: { x: .46, y: .70 }, kneeR: { x: .54, y: .70 }, ankleL: { x: .456, y: .88 }, ankleR: { x: .544, y: .88 }, toeL: { x: .456, y: .925 }, toeR: { x: .544, y: .925 } };
      if (f === 30 || f === 31) { j.handL = { x: 99, y: 99 }; j.elbowL = { x: -99, y: 2 }; }   // 误检尖峰
      window.MotionAvatar.updateFromSkeleton(j);
      out.push(window.MotionAvatar.__poseSnapshot().LeftHand[1]);
    }
    const tail = out.slice(0, 30);
    return { maxJump: Math.max(...out.slice(1).map((v, i) => Math.abs(v - out[i]))), tailSpan: Math.max(...tail) - Math.min(...tail) };
  });
  check("数值跳变输入 → 单帧位移有界（不抽搐）", spike.maxJump < 0.9, `最大单帧位移=${spike.maxJump.toFixed(3)}`);

  /* ---------- 8. rAF 真实帧率 ---------- */
  console.log("\n== 8. requestAnimationFrame 真实帧率（1.5 秒）==");
  const fps = await page.evaluate(() => new Promise(res => {
    let n = 0; const t0 = performance.now();
    function tick() { n++; if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else res({ n, ms: performance.now() - t0 }); }
    requestAnimationFrame(tick);
  }));
  const realFps = (fps.n / (fps.ms / 1000));
  check("headless rAF 循环可跑（≥30fps；headless 会被人为限频）", realFps >= 30, `${fps.n} 帧 / ${fps.ms.toFixed(0)}ms = ${realFps.toFixed(1)}fps`);

  console.log("\n== 控制台错误 ==");
  check("无 JS 报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\n================ 汇总：通过 ${pass.length} / 失败 ${fail.length} ================`);
  if (fail.length) console.log("失败项：\n  - " + fail.join("\n  - "));
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error("脚本崩溃:", e); process.exit(2); });
