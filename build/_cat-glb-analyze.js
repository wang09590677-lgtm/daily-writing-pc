/* 分析带操运动猫 GLB：蒙皮属性、骨骼层级与 rest pose、尺寸、朝向。
 * 用法：node build/_cat-glb-analyze.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "带操运动猫", "cat_fitness_avatar.glb");

const buf = fs.readFileSync(FILE);
let off = 12, json = null, binLen = 0;
while (off < buf.length) {
  const len = buf.readUInt32LE(off), type = buf.toString("ascii", off + 4, off + 8);
  if (type === "JSON") json = JSON.parse(buf.toString("utf8", off + 8, off + 8 + len));
  if (type === "BIN") binLen = len;
  off += 8 + len;
}
const g = json;
const gAcc = g.accessors || [], gBV = g.bufferViews || [];

console.log("=== 概览 ===");
console.log("nodes=" + g.nodes.length, "meshes=" + g.meshes.length, "skins=" + g.skins.length,
  "anims=" + (g.animations || []).length, "materials=" + g.materials.length,
  "textures=" + (g.textures || []).length, "images=" + (g.images || []).length, "BIN=" + binLen + "B");

/* ---------- 1. 蒙皮属性检查 ---------- */
console.log("\n=== 1. 蒙皮属性（每个 mesh 的 primitive attributes）===");
let skinnedCount = 0, unskinned = [];
const attrKeys = new Set();
g.meshes.forEach((m, mi) => {
  m.primitives.forEach((p, pi) => {
    const keys = Object.keys(p.attributes);
    keys.forEach(k => attrKeys.add(k));
    const skinned = keys.includes("JOINTS_0") && keys.includes("WEIGHTS_0");
    if (skinned) skinnedCount++; else unskinned.push(mi + ":" + pi + "[" + keys.join(",") + "]");
  });
});
console.log("全部属性键:", [...attrKeys].join(", "));
console.log("蒙皮 primitive 数 = " + skinnedCount + " / " + g.meshes.length + " 个 mesh");
if (unskinned.length) console.log("未蒙皮:", unskinned.slice(0, 10).join("  "));

/* ---------- 2. skin 详情 ---------- */
console.log("\n=== 2. skin ===");
const skin = g.skins[0];
console.log("joints=" + skin.joints.length, "inverseBindMatrices accessor=" + skin.inverseBindMatrices);
if (skin.inverseBindMatrices !== undefined) {
  const a = gAcc[skin.inverseBindMatrices];
  console.log("  IBM: type=" + a.type + " count=" + a.count + " componentType=" + a.componentType);
}
console.log("\njoints 索引（按 skin 顺序）→ 节点名:");
skin.joints.forEach((ni, i) => {
  const n = g.nodes[ni];
  console.log("  [" + String(i).padStart(2) + "] node#" + String(ni).padStart(3) + "  " + JSON.stringify(n.name));
});

/* ---------- 3. 骨骼层级树 + rest 变换 ---------- */
console.log("\n=== 3. 骨骼层级与 rest 变换（world 位置）===");
const parentOf = {};
g.nodes.forEach((n, i) => (n.children || []).forEach(c => (parentOf[c] = i)));

// 计算每个节点的世界矩阵（只考虑 TRS，忽略蒙皮）
function trsMatrix(n) {
  const t = n.translation || [0, 0, 0];
  const r = n.rotation || [0, 0, 0, 1];
  const s = n.scale || [1, 1, 1];
  // 手工构造 T*R*S 的 4x4（列主序，与 glTF 一致）
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m = [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1
  ];
  return m;
}
function mul(a, b) { // a*b, 列主序
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
const worldCache = {};
function worldOf(i) {
  if (worldCache[i]) return worldCache[i];
  const local = trsMatrix(g.nodes[i]);
  const p = parentOf[i];
  const w = p === undefined ? local : mul(worldOf(p), local);
  worldCache[i] = w;
  return w;
}

const jointSet = new Set(skin.joints);
const nodeIndexByName = {};
g.nodes.forEach((n, i) => { if (n.name) nodeIndexByName[n.name] = i; });

console.log("名称".padEnd(18) + "节点#".padStart(6) + "  世界位置(x,y,z)".padStart(34) + "  父级");
skin.joints.forEach(ni => {
  const w = worldOf(ni);
  const pos = [w[12], w[13], w[14]].map(v => (Math.abs(v) < 1e-6 ? 0 : v).toFixed(4));
  const pn = parentOf[ni];
  console.log((g.nodes[ni].name || "?").padEnd(18) + String(ni).padStart(6) +
    ("  (" + pos.join(", ") + ")").padStart(34) + "  " + (pn !== undefined ? (g.nodes[pn].name || "#" + pn) : "(root)"));
});

/* ---------- 4. 整体包围盒（骨骼端点） ---------- */
console.log("\n=== 4. 骨架包围盒（由骨骼世界位置得出）===");
let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
skin.joints.forEach(ni => {
  const w = worldOf(ni);
  for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], w[12 + k]); mx[k] = Math.max(mx[k], w[12 + k]); }
});
console.log("min=(" + mn.map(v => v.toFixed(4)).join(", ") + ")");
console.log("max=(" + mx.map(v => v.toFixed(4)).join(", ") + ")");
console.log("size=(" + [0, 1, 2].map(k => (mx[k] - mn[k]).toFixed(4)).join(", ") + ")");

/* ---------- 5. POSITION accessor 的范围（真实网格尺寸）---------- */
console.log("\n=== 5. 网格几何包围盒（POSITION accessor 的 min/max 汇总）===");
let gmn = [1e9, 1e9, 1e9], gmx = [-1e9, -1e9, -1e9], vtx = 0, tri = 0;
g.meshes.forEach(m => m.primitives.forEach(p => {
  const a = gAcc[p.attributes.POSITION];
  vtx += a.count;
  if (p.indices !== undefined) tri += gAcc[p.indices].count / 3;
  if (a.min && a.max) for (let k = 0; k < 3; k++) { gmn[k] = Math.min(gmn[k], a.min[k]); gmx[k] = Math.max(gmx[k], a.max[k]); }
}));
console.log("顶点总数=" + vtx + "  三角面=" + Math.round(tri));
console.log("min=(" + gmn.map(v => v.toFixed(4)).join(", ") + ")");
console.log("max=(" + gmx.map(v => v.toFixed(4)).join(", ") + ")");
console.log("size=(" + [0, 1, 2].map(k => (gmx[k] - gmn[k]).toFixed(4)).join(", ") + ")");

/* ---------- 6. 材质 ---------- */
console.log("\n=== 6. 材质 ===");
g.materials.forEach((m, i) => {
  const pbr = m.pbrMetallicRoughness || {};
  console.log("[" + i + "] " + JSON.stringify(m.name) +
    " baseColor=" + JSON.stringify(pbr.baseColorFactor || "默认") +
    " metal=" + pbr.metallicFactor + " rough=" + pbr.roughnessFactor +
    (pbr.baseColorTexture ? " 有贴图" : ""));
});

/* ---------- 7. 骨骼树（层级结构）---------- */
console.log("\n=== 7. 骨骼层级树（仅骨架节点）===");
function tree(i, depth, maxDepth) {
  const n = g.nodes[i];
  const isJoint = jointSet.has(i);
  if (!isJoint && depth > 0) return;
  const w = worldOf(i);
  const tag = (jointSet.has(i) ? "●" : "○") + " " + (n.name || "#" + i);
  console.log("  ".repeat(depth) + tag + "   y=" + w[13].toFixed(4) + "  z=" + w[14].toFixed(4));
  if (depth > maxDepth) { console.log("  ".repeat(depth + 1) + "..."); return; }
  (n.children || []).forEach(c => tree(c, depth + 1, maxDepth));
}
const rootJoint = skin.joints.find(ni => parentOf[ni] === undefined || !jointSet.has(parentOf[ni]));
console.log("骨架根:", g.nodes[rootJoint].name);
tree(rootJoint, 0, 4);
