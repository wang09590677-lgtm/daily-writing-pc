/* 直接解析 GLB 的 JSON chunk，读出节点/骨骼/蒙皮/动画结构。
   用法：node build/_probe-glb-structure.js "<glb 路径>" [--bones]
   不依赖 three.js —— 纯读二进制头 + JSON。 */
const fs = require("fs");
const path = require("path");

const file = process.argv[2];
const wantBones = process.argv.includes("--bones");
if (!file) { console.error("用法: node _probe-glb-structure.js <glb>"); process.exit(2); }

const buf = fs.readFileSync(file);
if (buf.readUInt32LE(0) !== 0x46546c67) { console.error("不是 GLB（magic 不符）"); process.exit(1); }
const version = buf.readUInt32LE(4);
const total = buf.readUInt32LE(8);
console.log("文件: " + path.basename(file));
console.log("GLB version = " + version + "  声明长度 = " + total + "  实际 = " + buf.length);

let off = 12, json = null, binLen = 0;
while (off < buf.length) {
  const clen = buf.readUInt32LE(off);
  const ctype = buf.readUInt32LE(off + 4);
  const cdata = buf.subarray(off + 8, off + 8 + clen);
  if (ctype === 0x4e4f534a) json = JSON.parse(cdata.toString("utf8"));
  else if (ctype === 0x004e4942) binLen = clen;
  off += 8 + clen + ((4 - (clen % 4)) % 4);
}
const g = json;
console.log("BIN chunk = " + binLen + " bytes");
console.log("asset: " + JSON.stringify(g.asset));

const nodes = g.nodes || [];
const meshes = g.meshes || [];
const skins = g.skins || [];
const anims = g.animations || [];

console.log("\n=== 概览 ===");
console.log("nodes      = " + nodes.length);
console.log("meshes     = " + meshes.length);
console.log("skins      = " + skins.length);
console.log("animations = " + anims.length + (anims.length ? "  [" + anims.map(a => a.name || "(无名)").join(", ") + "]" : ""));
console.log("materials  = " + (g.materials || []).length);
console.log("textures   = " + (g.textures || []).length);
console.log("images     = " + (g.images || []).length);

// 顶点总数
let verts = 0;
for (const m of meshes) for (const p of (m.primitives || [])) {
  const acc = g.accessors[p.attributes.POSITION];
  if (acc) verts += acc.count;
}
console.log("顶点总数   = " + verts);

// 有蒙皮的网格数
let skinnedMeshCount = 0;
for (const n of nodes) if (n.mesh !== undefined && n.skin !== undefined) skinnedMeshCount++;
console.log("蒙皮网格节点 = " + skinnedMeshCount);

console.log("\n=== 骨骼（skin.joints）===");
skins.forEach((s, i) => {
  const jn = (s.joints || []).map(j => nodes[j] && (nodes[j].name || ("node" + j)));
  console.log("skin[" + i + "] name=" + (s.name || "(无名)") + " joints=" + jn.length +
    " skeleton=" + (s.skeleton !== undefined ? nodes[s.skeleton].name : "-"));
  jn.forEach((n, k) => console.log("   [" + String(k).padStart(2) + "] " + n));
});

if (wantBones) {
  console.log("\n=== 全部节点（带 mesh/skin 标记）===");
  nodes.forEach((n, i) => {
    const tags = [];
    if (n.mesh !== undefined) tags.push("mesh=" + (meshes[n.mesh].name || n.mesh));
    if (n.skin !== undefined) tags.push("skin=" + n.skin);
    if (n.children) tags.push("children=" + n.children.length);
    console.log("  [" + String(i).padStart(3) + "] " + (n.name || "(无名)") + (tags.length ? "   " + tags.join(" ") : ""));
  });
}

// 各蒙皮网格绑到哪套骨骼 + 顶点数
console.log("\n=== 蒙皮网格清单 ===");
for (const n of nodes) {
  if (n.mesh !== undefined && n.skin !== undefined) {
    const m = meshes[n.mesh];
    let v = 0;
    for (const p of (m.primitives || [])) { const a = g.accessors[p.attributes.POSITION]; if (a) v += a.count; }
    console.log("  " + (n.name || "(无名)") + "  mesh=" + (m.name || n.mesh) + "  skin=" + n.skin + "  顶点=" + v);
  }
}
