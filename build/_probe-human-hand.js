/* 纯 Node 读 GLB：列出**手部链**的全部真实骨名 + rest 世界坐标 + 骨长，
   用于回答「腕→中指尖到底多长」——决定 REACH_UP 该取多少。

   背景（第二份独立评审发现）：`__poseSnapshot().RightHand` 是**腕**（骨 origin），
   所以 accept-human-glb ⑧ 报的"指尖 226.6px"其实是腕；真指尖还要再往上 ~19cm。
   本脚本给出**真值**，别照假设写（踩坑第 3 条）。

   用法：node build/_probe-human-hand.js */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "体能训练动作演示", "体感跟练模型.glb");
const buf = fs.readFileSync(file);

if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("不是 GLB");
let off = 12, json = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8"));
  off += 8 + len + ((4 - (len % 4)) % 4);
}

function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function fromTRS(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1
  ];
}
const posOf = m => [m[12], m[13], m[14]];

const nodes = json.nodes;
const parent = new Array(nodes.length).fill(-1);
nodes.forEach((n, i) => (n.children || []).forEach(c => { parent[c] = i; }));
const world = new Array(nodes.length);
function compute(i) {
  if (world[i]) return world[i];
  const n = nodes[i];
  const local = n.matrix ? n.matrix.slice()
    : fromTRS(n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1]);
  world[i] = parent[i] >= 0 ? mul(compute(parent[i]), local) : local;
  return world[i];
}
nodes.forEach((_, i) => compute(i));

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const byName = {};
nodes.forEach((n, i) => { byName[n.name] = i; });
const W = name => { const i = byName[name]; return i === undefined ? null : posOf(world[i]); };
const cand = n => { for (const c of ["mixamorig:" + n, "mixamorig" + n, n]) if (byName[c] !== undefined) return c; return null; };
const P = n => { const c = cand(n); return c ? W(c) : null; };

/* 打印所有名字里含 Hand / Thumb / Index / Middle / Ring / Pinky 的节点 */
console.log("== 手部相关节点（GLB 原始名）==");
const handish = nodes.map((n, i) => ({ n, i })).filter(o => /hand|thumb|index|middle|ring|pinky/i.test(o.n.name));
handish.forEach(o => {
  const p = posOf(world[o.i]);
  console.log("  " + o.n.name.padEnd(34) + p.map(v => v.toFixed(5).padStart(9)).join(" ") +
    (o.n.children ? "   children=" + o.n.children.length : ""));
});

/* 身高基准 */
const toeEnd = P("RightToe_End"), headTop = P("HeadTop_End");
const Hw = headTop[1] - Math.min(toeEnd[1], P("LeftToe_End")[1]);
console.log("\n身高(HeadTop_End→Toe_End) = " + Hw.toFixed(5));

/* 关键长度 */
const wristR = P("RightHand");
console.log("\n== 腕 → 各手指骨（模型自身右侧 / mixamorigRight*）==");
["RightHandThumb1", "RightHandThumb2", "RightHandThumb3", "RightHandThumb4",
 "RightHandIndex1", "RightHandIndex2", "RightHandIndex3", "RightHandIndex4",
 "RightHandMiddle1", "RightHandMiddle2", "RightHandMiddle3", "RightHandMiddle4",
 "RightHandRing1", "RightHandRing2", "RightHandRing3", "RightHandRing4",
 "RightHandPinky1", "RightHandPinky2", "RightHandPinky3", "RightHandPinky4"].forEach(n => {
  const p = P(n);
  if (!p) { console.log("  " + n.padEnd(22) + "缺"); return; }
  const d = dist(wristR, p);
  console.log("  " + n.padEnd(22) + "腕距=" + d.toFixed(5) + "  归一化=" + (d / Hw).toFixed(5));
});

/* 中指尖：Middle4 的**子节点**（如果有）或 Middle4 本身 */
const mid4 = cand("RightHandMiddle4");
if (mid4 !== null) {
  const idx = byName[mid4];
  const kids = nodes[idx].children || [];
  console.log("\nMiddle4 的子节点: " + (kids.length ? kids.map(k => nodes[k].name + "(" + dist(wristR, posOf(world[k])).toFixed(5) + ")").join(", ") : "无"));
}

/* 整条手链从腕到最远骨 */
let far = 0, farName = "";
handish.filter(o => /^mixamorig:?Right/i.test(o.n.name)).forEach(o => {
  const d = dist(wristR, posOf(world[o.i]));
  if (d > far) { far = d; farName = o.n.name; }
});
console.log("\n★ 腕→右手最远骨 = " + far.toFixed(5) + "  (" + farName + ")  归一化=" + (far / Hw).toFixed(5));

/* ---- 蒙皮网格静止包围盒 ----
 * ⚠️ 这里**算不对**（本项目的老坑）：网格节点挂在带 scale 0.01 的 `Armature` 下，
 *    且 accessor 的 POSITION 在**绑定空间**，`accessor × matrixWorld` 得到的是 0.003 量级。
 *    运行时的 `measureSkinnedBox()` 走 `SkinnedMesh.applyBoneTransform` 逐顶点算，
 *    才是真值（实测 RAW_H = 1.8092）。所以这里只打印出来**提醒你别信它**，
 *    换算一律用下面 `RAW_H_TRUE`。 */
let meshBot = Infinity, meshTop = -Infinity;
json.nodes.forEach((n, i) => {
  if (n.mesh === undefined || n.skin === undefined) return;
  json.meshes[n.mesh].primitives.forEach(pr => {
    const acc = json.accessors[pr.attributes.POSITION];
    if (!acc || !acc.min) return;
    for (let k = 0; k < 8; k++) {
      const v = [k & 1 ? acc.max[0] : acc.min[0], k & 2 ? acc.max[1] : acc.min[1], k & 4 ? acc.max[2] : acc.min[2]];
      const w = world[i];
      const y = w[4] * v[0] + w[5] * v[1] + w[6] * v[2] + w[13];
      meshBot = Math.min(meshBot, y); meshTop = Math.max(meshTop, y);
    }
  });
});
console.log("\n(参考，别用) accessor×matrixWorld 的网格 y 范围 = " + meshBot.toFixed(5) + " ~ " + meshTop.toFixed(5));

/* **真值**：运行时 measureSkinnedBox 逐顶点实测得到（见 accept-human-glb 打印）。
 * 骨架节点树里 Toe_End 在 y≈0、HeadTop_End 在 y≈1.8197，而网格身高 1.8092
 * —— 说明网格顶（含头发）比 HeadTop_End 骨骼低一点点，最低点是脚底。 */
const RAW_H = 1.8092;

/* ---- 代码换算约定 ----
 * motion-avatar 里：`scale = layout.H / RAW_H`（网格身高 ↔ H），
 * `k2 = layout.H / span`（引擎归一化 span 0.827 ↔ H）。
 * ⇒ **引擎归一化 0.827 ↔ 网格身高 RAW_H**，换算式：归一化 = 模型长度 × 0.827 / RAW_H。 */
const SPAN = 0.827;
const toNorm = L => L * SPAN / RAW_H;
const meshTopLocal = 0;            // 网格底对齐到模型局部 y=0（applyLayout 把 y=0 放到 footY）
const meshTopY = meshTopLocal + RAW_H;

const arm = P("RightArm"), fore = P("RightForeArm"), hand = P("RightHand"), tip = P("RightHandMiddle4");
/* 手臂链**最大伸展** = 各段长之和（rest 是 T-pose，链近似共线，和 ≈ 直线距离） */
const armChain = dist(arm, fore) + dist(fore, hand) + dist(hand, tip);

console.log("\n== 模型局部实测（网格底 0、顶 " + meshTopY.toFixed(5) + "、RAW_H " + RAW_H.toFixed(5) +
  "；肩 " + arm[1].toFixed(5) + "）==");
console.log("  上臂(肩→肘)         = " + dist(arm, fore).toFixed(5) + "  归一化=" + toNorm(dist(arm, fore)).toFixed(4));
console.log("  前臂(肘→腕)         = " + dist(fore, hand).toFixed(5) + "  归一化=" + toNorm(dist(fore, hand)).toFixed(4));
console.log("  手  (腕→中指尖)     = " + dist(hand, tip).toFixed(5) + "  归一化=" + toNorm(dist(hand, tip)).toFixed(4));
console.log("  手臂链总长(肩→指尖) = " + armChain.toFixed(5) + "  归一化=" + toNorm(armChain).toFixed(4));

/* ---- REACH_UP 真值：举手过顶时指尖高过"网格头顶"多少 / 网格身高 ---- */
const reach = (arm[1] + armChain) - meshTopY;
console.log("\n★ 举手过顶：指尖 y = 肩 " + arm[1].toFixed(5) + " + 臂长 " + armChain.toFixed(5) +
  " = " + (arm[1] + armChain).toFixed(5));
console.log("  网格头顶 = " + meshTopY.toFixed(5) + "  ⇒ 指尖高过头顶 " + reach.toFixed(5) +
  "（归一化 " + toNorm(reach).toFixed(4) + "）");
console.log("★ REACH_UP 真值 = " + (reach / RAW_H).toFixed(5) +
  "   （当前代码写的是 " + (0.108 / 0.827).toFixed(4) + "）");

/* ---- 与当前代码里的假设对比 ---- */
console.log("\n== 与代码假设对比 ==");
console.log("  IDLE 手写 上臂+前臂 = 0.2553  实测 " + (toNorm(dist(arm, fore) + dist(fore, hand))).toFixed(4));
console.log("  IDLE 手写 手段      = 0.0260  实测 " + toNorm(dist(hand, tip)).toFixed(4) + "  ← 差 " +
  ((toNorm(dist(hand, tip)) / 0.026 - 1) * 100).toFixed(0) + "%");
console.log("  IDLE 手写 总臂长    = 0.2813  实测 " + toNorm(armChain).toFixed(4));
