/* 扩展侦察：节点层级 / 动画通道 / 静止姿态包围盒 / 朝向
   用法：node build/_probe-glb-deep.js "<glb>" */
const fs = require("fs");
const path = require("path");
const file = process.argv[2];
const buf = fs.readFileSync(file);
let off = 12, g = null;
while (off < buf.length) {
  const clen = buf.readUInt32LE(off), ctype = buf.readUInt32LE(off + 4);
  const cdata = buf.subarray(off + 8, off + 8 + clen);
  if (ctype === 0x4e4f534a) g = JSON.parse(cdata.toString("utf8"));
  off += 8 + clen + ((4 - (clen % 4)) % 4);
}
const nodes = g.nodes || [];
console.log("=== 文件: " + path.basename(file) + " ===");

// 场景根
console.log("\n=== 场景根节点 ===");
(g.scenes[g.scene || 0].nodes || []).forEach(i => {
  console.log("  [" + i + "] " + nodes[i].name + "  " + JSON.stringify({
    t: nodes[i].translation, r: nodes[i].rotation, s: nodes[i].scale, m: !!nodes[i].matrix
  }));
});

// 层级树
const parentOf = new Array(nodes.length).fill(-1);
nodes.forEach((n, i) => (n.children || []).forEach(c => parentOf[c] = i));
function tree(i, d) {
  const n = nodes[i];
  const tags = [];
  if (n.mesh !== undefined) tags.push("mesh");
  if (n.skin !== undefined) tags.push("skin");
  if (n.translation) tags.push("T=" + n.translation.map(v => v.toFixed(3)).join(","));
  console.log("  ".repeat(d) + "- " + (n.name || "(无名)") + (tags.length ? "  [" + tags.join(" ") + "]" : ""));
  (n.children || []).forEach(c => tree(c, d + 1));
}
console.log("\n=== 层级树（只到躯干/四肢主干，跳过手指）===");
function treeFiltered(i, d) {
  const n = nodes[i];
  const nm = n.name || "";
  if (/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(nm)) return;   // 手指整枝跳过
  const tags = [];
  if (n.mesh !== undefined) tags.push("mesh=" + g.meshes[n.mesh].name);
  if (n.skin !== undefined) tags.push("skin");
  if (n.translation) tags.push("T=" + n.translation.map(v => v.toFixed(3)).join(","));
  if (n.rotation) tags.push("R=" + n.rotation.map(v => v.toFixed(3)).join(","));
  if (n.scale) tags.push("S=" + n.scale.map(v => v.toFixed(3)).join(","));
  console.log("  ".repeat(d) + "- " + nm + (tags.length ? "  [" + tags.join(" ") + "]" : ""));
  (n.children || []).forEach(c => treeFiltered(c, d + 1));
}
(g.scenes[g.scene || 0].nodes || []).forEach(i => treeFiltered(i, 0));

// 静止姿态包围盒（用 accessor 的 min/max，最省事）
console.log("\n=== 网格静止包围盒（accessor min/max，局部坐标）===");
(g.meshes || []).forEach((m, mi) => {
  (m.primitives || []).forEach((p, pi) => {
    const a = g.accessors[p.attributes.POSITION];
    if (a && a.min && a.max) {
      console.log("  mesh[" + mi + "] " + (m.name || "") + " prim" + pi +
        "  min=[" + a.min.map(v => v.toFixed(3)).join(", ") + "]" +
        "  max=[" + a.max.map(v => v.toFixed(3)).join(", ") + "]");
      console.log("        尺寸 = [" + a.max.map((v, k) => (v - a.min[k]).toFixed(3)).join(", ") + "]");
    }
  });
});

// 动画
console.log("\n=== 动画 ===");
(g.animations || []).forEach((an, ai) => {
  const boneSet = new Set();
  let maxT = 0;
  (an.samplers || []).forEach(s => {
    const inp = g.accessors[s.input];
    if (inp && inp.max) maxT = Math.max(maxT, inp.max[0]);
  });
  (an.channels || []).forEach(c => boneSet.add(nodes[c.target.node].name + ":" + c.target.path));
  console.log("  anim[" + ai + "] name=" + (an.name || "(无名)") +
    "  时长=" + maxT.toFixed(2) + "s  通道=" + an.channels.length + "  采样器=" + an.samplers.length);
  const byBone = {};
  [...boneSet].forEach(k => { const [b, p] = k.split(":"); (byBone[b] = byBone[b] || []).push(p); });
  const keys = Object.keys(byBone);
  console.log("        涉及骨骼 " + keys.length + " 根：");
  keys.forEach(b => console.log("           " + b + "  [" + byBone[b].join(",") + "]"));
});
