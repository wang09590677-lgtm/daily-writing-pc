/* 纯 Node 读 GLB，算出**静止骨架**的世界坐标，并反推出引擎归一化约定下的
   「人形自然站姿」关节表（用于重写 IDLE_JOINTS）。

   为什么不问浏览器要：页面里 `animate()` 每帧都在驱动骨骼，
   读到的"当前姿势"永远是被 IDLE_JOINTS 驱动后的结果，**不是 rest**（踩过这个坑）。
   GLB 里的 node 层级才是 rest 的唯一真值。

   用法：node build/_probe-human-rest-norm.js
   输出：① rest 世界坐标 ② 建议的 IDLE_JOINTS ③ 比例核对 */
const fs = require("fs");
const path = require("path");

const GLB = path.join(__dirname, "..", "体能训练动作演示", "体感练模型.glb");
const GLB2 = path.join(__dirname, "..", "体能训练动作演示", "体感跟练模型.glb");
const file = fs.existsSync(GLB2) ? GLB2 : GLB;
const buf = fs.readFileSync(file);

/* ---- 解析 GLB 容器 ---- */
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("不是 GLB");
let off = 12, json = null, bin = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8"));
  if (type === 0x004e4942) bin = data;
  off += 8 + len + ((4 - (len % 4)) % 4);
}
console.log("文件 = " + path.basename(file) + "  nodes=" + json.nodes.length);

/* ---- 4x4 矩阵（列主序，与 three.js 一致）---- */
const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {              // a * b
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

/* ---- 建树 ---- */
const nodes = json.nodes;
const parent = new Array(nodes.length).fill(-1);
nodes.forEach((n, i) => (n.children || []).forEach(c => { parent[c] = i; }));
const world = new Array(nodes.length);
function compute(i) {
  if (world[i]) return world[i];
  const n = nodes[i];
  let local;
  if (n.matrix) local = n.matrix.slice();
  else local = fromTRS(n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1]);
  const w = parent[i] >= 0 ? mul(compute(parent[i]), local) : local;
  world[i] = w;
  return w;
}
nodes.forEach((_, i) => compute(i));

const byName = {};
nodes.forEach((n, i) => { byName[n.name] = i; });
const W = (name) => {
  const i = byName[name];
  if (i === undefined) return null;
  return posOf(world[i]);
};
const shortName = s => s.replace(/^mixamorig:?/i, "");

/* 打印全部骨骼的 rest 世界坐标（短名） */
console.log("\n== rest 世界坐标（模型局部，y 向上）==");
const want = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "HeadTop_End",
  "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
  "RightShoulder", "RightArm", "RightForeArm", "RightHand",
  "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "LeftToe_End",
  "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase", "RightToe_End"];
const R = {};
want.forEach(n => {
  // ⚠️ GLB 里节点名**带冒号**（`mixamorig:Hips`）；GLTFLoader 加载后才会洗成 `mixamorigHips`。
  //    这是本项目第三次踩"外部资源的名字不能照自己的假设写"，两种写法都试。
  const cand = ["mixamorig:" + n, "mixamorig" + n, n];
  let p = null, used = null;
  for (const c of cand) { if (byName[c] !== undefined) { p = W(c); used = c; break; } }
  R[n] = p;
  console.log("  " + n.padEnd(14) + (p ? p.map(v => +v.toFixed(5)).join(", ") : "缺") +
    (used && used !== n ? "   ← " + used : ""));
});

/* ---- 蒙皮网格的静止包围盒（用 accessor 的 min/max × 节点世界矩阵）---- */
let meshBot = Infinity, meshTop = -Infinity;
json.nodes.forEach((n, i) => {
  if (n.mesh === undefined || !n.skin === undefined) return;
  const m = json.meshes[n.mesh];
  m.primitives.forEach(pr => {
    const acc = json.accessors[pr.attributes.POSITION];
    if (!acc.min) return;
    // 8 个角点
    for (let k = 0; k < 8; k++) {
      const v = [k & 1 ? acc.max[0] : acc.min[0], k & 2 ? acc.max[1] : acc.min[1], k & 4 ? acc.max[2] : acc.min[2]];
      const w = world[i];
      const y = w[4] * v[0] + w[5] * v[1] + w[6] * v[2] + w[13];
      meshBot = Math.min(meshBot, y); meshTop = Math.max(meshTop, y);
    }
  });
});
console.log("\n网格静止包围盒 y: " + meshBot.toFixed(5) + " ~ " + meshTop.toFixed(5) +
  "  (注意：蒙皮网格的 accessor 是绑定姿势，未必等于实际渲染范围)");

/* ---- 比例核对 ---- */
const wBot = Math.min(R.LeftToe_End[1], R.RightToe_End[1]);
const Hw = R.HeadTop_End[1] - wBot;
console.log("\n== 比例（相对身高，脚底=Toe_End）==");
const frac = v => +((v[1] - wBot) / Hw).toFixed(4);
console.log("身高(HeadTop_End→Toe_End) = " + Hw.toFixed(4));
console.log("髋(UpLeg) = " + frac(R.RightUpLeg) + "  膝 = " + frac(R.RightLeg) +
  "  踝 = " + frac(R.RightFoot) + "  肩 = " + frac(R.RightArm) +
  "  颈 = " + frac(R.Neck) + "  头(Head) = " + frac(R.Head));
console.log("腿长(髋→踝)/身高 = " + ((R.RightUpLeg[1] - R.RightFoot[1]) / Hw).toFixed(4) +
  "   (髋→趾)/身高 = " + ((R.RightUpLeg[1] - R.RightToe_End[1]) / Hw).toFixed(4));
console.log("臂长(肩→腕)/身高 = " + ((R.RightArm[1] - R.RightHand[1]) / Hw).toFixed(4));

/* ---- 反推归一化 IDLE_JOINTS ----
   引擎约定（见 motion-avatar.js rawWorld）：
     worldX = (nx - 0.5) * k2,  worldY = footY + REST_LOWEST*scale + (bot - ny) * k2
     k2 = layout.H / span,  span = bot - head(ny)
   取 head_ny = 0.098、bot_ny = 0.925（沿用旧表约定），并把"模型最低点"对到 bot。
   ⚠️ 模型最低点用 **Toe_End**（人形脚趾尖贴地），不是网格包围盒底。 */
const yHead = 0.098, yBot = 0.925, span = yBot - yHead;
const nx = wx => +(0.5 + wx / Hw * span).toFixed(4);
const ny = wy => +(yBot - (wy - wBot) / Hw * span).toFixed(4);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const P = v => ({ x: nx(v[0]), y: ny(v[1]) });

const out = {};
out.head = P(R.Head);
out.neck = P(R.Neck);
/* 引擎 shoulderL = 图像 x 较小侧 = **被拍摄者的右** → 模型 Right*（交叉映射） */
out.shoulderL = P(R.RightArm);
out.shoulderR = P(R.LeftArm);
out.midL = P(mid(R.RightArm, R.RightForeArm));
out.midR = P(mid(R.LeftArm, R.LeftForeArm));
out.elbowL = P(R.RightForeArm);
out.elbowR = P(R.LeftForeArm);
out.foreL = P(mid(R.RightForeArm, R.RightHand));
out.foreR = P(mid(R.LeftForeArm, R.LeftHand));
out.wristL = P(R.RightHand);
out.wristR = P(R.LeftHand);
out.handL = P(R.RightHand);
out.handR = P(R.LeftHand);
out.hipMid = P(R.Hips);
out.hipL = P(R.RightUpLeg);
out.hipR = P(R.LeftUpLeg);
out.kneeL = P(R.RightLeg);
out.kneeR = P(R.LeftLeg);
out.shinL = P(mid(R.RightLeg, R.RightFoot));
out.shinR = P(mid(R.LeftLeg, R.LeftFoot));
out.ankleL = P(R.RightFoot);
out.ankleR = P(R.LeftFoot);
out.toeL = P(R.RightToeBase);
out.toeR = P(R.LeftToeBase);

console.log("\n== 建议 IDLE_JOINTS（人形自然站姿）==");
console.log(JSON.stringify(out, null, 1));

console.log("\n== 旧表 vs 新表（归一化 y，越小越靠上）==");
const OLD = {
  head: 0.098, neck: 0.215, shoulderL: 0.262, midL: 0.330, elbowL: 0.380,
  foreL: 0.425, wristL: 0.452, handL: 0.474, hipMid: 0.545, hipL: 0.548,
  kneeL: 0.700, shinL: 0.800, ankleL: 0.888, toeL: 0.930
};
Object.keys(OLD).forEach(k => {
  const nv = out[k] ? out[k].y : null;
  console.log("  " + k.padEnd(10) + " 旧=" + OLD[k].toFixed(3) + "  新=" + (nv === null ? "-" : nv.toFixed(3)) +
    "  Δ=" + (nv === null ? "-" : (nv - OLD[k]).toFixed(3)));
});
