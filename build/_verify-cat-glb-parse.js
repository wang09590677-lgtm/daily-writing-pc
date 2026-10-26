/* 【verifier-oneshot 猫模型离线解析】不启动浏览器。
 * 目的：独立读 GLB 的节点树，算出各骨骼的 **rest 世界坐标**，用于判定：
 *   · 模型面朝哪个方向（+Z 还是 -Z）
 *   · LeftUpperArm 在 +X 还是 -X
 *   · 与 motion-avatar.js 的 BONE_SEG 左右交叉映射是否自洽
 * GLB 格式：12B header + chunks(JSON/BIN)。只解析 JSON chunk 的 nodes/scenes。
 */
"use strict";
const fs = require("fs"), path = require("path");
const p = path.join(__dirname, "..", "assets", "models", "cat_fitness_avatar.glb");
const buf = fs.readFileSync(p);
const magic = buf.readUInt32LE(0), ver = buf.readUInt32LE(4), total = buf.readUInt32LE(8);
console.log(`GLB magic=0x${magic.toString(16)} (期望 0x46546c67 'glTF')  version=${ver}  bytes=${total}  实际=${buf.length}`);
let off = 12, json = null, binLen = 0;
while (off + 8 <= buf.length) {
  const clen = buf.readUInt32LE(off), ctype = buf.readUInt32LE(off + 4);
  const data = buf.slice(off + 8, off + 8 + clen);
  if (ctype === 0x4E4F534A) json = JSON.parse(data.toString("utf8"));      // 'JSON'
  else if (ctype === 0x004E4942) binLen = clen;                            // 'BIN\0'
  off += 8 + clen;
}
console.log(`JSON chunk 解析: ${json ? "成功" : "失败"}   BIN chunk=${binLen}B`);
console.log(`nodes=${json.nodes.length}  meshes=${(json.meshes || []).length}  skins=${(json.skins || []).length}  scenes=${(json.scenes || []).length}`);

// 场景根
const sceneRoots = (json.scenes[json.scene || 0] || {}).nodes || [];
// 计算世界矩阵（节点可能带 matrix 或 TRS）
function mul(a, b) { // a*b, 列主序 4x4
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function trs(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation || [0, 0, 0], r = node.rotation || [0, 0, 0, 1], s = node.scale || [1, 1, 1];
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m = [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1
  ];
  return m;
}
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const worldByName = {};
function walk(gi, parentM) {
  const node = json.nodes[gi];
  const m = mul(parentM, trs(node));
  worldByName[node.name || ("#" + gi)] = { m, node };
  (node.children || []).forEach(c => walk(c, m));
}
sceneRoots.forEach(r => walk(r, I));

const WANT = ["Hips", "Spine", "Chest", "UpperChest", "Neck", "Head",
  "LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand",
  "RightShoulder", "RightUpperArm", "RightLowerArm", "RightHand",
  "LeftUpperLeg", "LeftLowerLeg", "LeftFoot",
  "RightUpperLeg", "RightLowerLeg", "RightFoot",
  "Tail_01", "Tail_06"];
console.log("\n骨骼 rest 世界坐标（glTF 右手系，+Y 上）：");
console.log("  名称".padEnd(18) + "x".padStart(10) + "y".padStart(10) + "z".padStart(10));
let found = 0;
for (const n of WANT) {
  const w = worldByName[n];
  if (!w) { console.log("  " + n.padEnd(16) + "  (无此节点)"); continue; }
  found++;
  const t = [w.m[12], w.m[13], w.m[14]];
  console.log("  " + n.padEnd(16) + t.map(v => v.toFixed(4).padStart(10)).join(""));
}
console.log(`\n命中 ${found}/${WANT.length}`);

// 结论性判定
const lu = worldByName["LeftUpperArm"], ru = worldByName["RightUpperArm"];
if (lu && ru) {
  console.log("\n【判定】");
  console.log(`  LeftUpperArm.x  = ${lu.m[12].toFixed(4)}`);
  console.log(`  RightUpperArm.x = ${ru.m[12].toFixed(4)}`);
  console.log(`  → 模型 LeftUpperArm ${lu.m[12] > 0 ? "在 +X（屏幕右）" : "在 -X（屏幕左）"}；RightUpperArm ${ru.m[12] > 0 ? "在 +X" : "在 -X"}`);
}
// 头部前突方向推断朝向：看 Head 的 z 相对 Neck
const hd = worldByName["Head"], nk = worldByName["Neck"], nose = worldByName["Nose"] || worldByName["nose"];
if (hd && nk) console.log(`  Head.z=${hd.m[14].toFixed(4)} vs Neck.z=${nk.m[14].toFixed(4)} → 头 ${hd.m[14] > nk.m[14] ? "偏 +Z" : "偏 -Z"}`);
// 全部骨骼名列表（诊断用）
const names = Object.keys(worldByName);
console.log(`\n全部节点名(${names.length}): ` + names.slice(0, 60).join(", ") + (names.length > 60 ? " ..." : ""));
