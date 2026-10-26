// 把「听音撰文」测试段落追加进 smoke-test.js（一次性脚本）
const fs = require("fs");
const path = require("path");
const FILE = path.join(__dirname, "smoke-test.js");
let s = fs.readFileSync(FILE, "utf8");

const marker = 'console.log("\\n全部通过，无运行时异常。");';
const block = [
  'console.log("== 听音撰文 ==");',
  'console.log("  场景总数:", P.AUDIO_SCENES.length);',
  'console.log("  任务池中的听音题:", P.tasksOfType("audio").length);',
  'P.generateSmartTask("audio");',
  'const at = P.getCurrentTask();',
  'console.log("  抽样题目:", at.title, "| sceneId:", at.sceneId, "| 能力:", at.skill);',
  'for (let i = 0; i < 3; i++) {',
  '  P.rerollAudio();',
  '  const sc = P.getCurrentAudio();',
  '  console.log("  声音", sc.id, "《" + sc.title + "》[" + sc.category + "]", sc.seconds + "s", "图层:" + sc.layers.map(l => l[0]).join("+"));',
  '}',
  'P.setAudioCategory("交通");',
  'console.log("  交通分类筛选后:", P.getCurrentAudio().title, "| 池内", P.audioScenesInCategory().length, "段");',
  'P.setAudioCategory("全部");',
  'P.generateSmartTask("audio");',
  'P.startAudioWriting();',
  'console.log("  activeWriting:", P.state.activeWriting.kind, "|", P.state.activeWriting.type, "| sceneId:", P.state.activeWriting.sceneId);',
  'console.log("  播放接口:", typeof (globalThis.AudioSceneEngine || {}).play);',
  '',
  marker
].join("\n");

if (!s.includes(marker)) { console.log("未找到标记"); process.exit(1); }
if (s.includes("== 听音撰文 ==")) { console.log("已存在，跳过"); process.exit(0); }
s = s.replace(marker, block);
fs.writeFileSync(FILE, s, "utf8");
console.log("已追加听音撰文测试段落");
