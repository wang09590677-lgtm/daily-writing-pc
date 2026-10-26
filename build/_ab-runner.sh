#!/bin/bash
# A/B 对照 + 直测探针（非生产脚本，跑完即删）。
# 铁律：任何退出路径都必须把 motion-engine.js 还原成 168d6829（现行版）。
cd "D:/workbuddy/2026-09-26-20-02-15/daily-writing-pc" || exit 9
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
export NODE_PATH=C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules
N="C:/Users/lixue/.workbuddy-ai/binaries/node/versions/22.22.2-3/node.exe"
CUR_MD5="168d6829b0e965be95eb9a99865f5890"
OLD_SRC="build/_rollback/motion-engine.before-autonext.js"   # 无门限引擎 4d5da7a1
CUR_BAK="build/_ab-backup-current-motion-engine.js"          # 现行引擎备份

restore(){
  cp "$CUR_BAK" motion-engine.js
  local m=$(md5sum motion-engine.js | cut -d' ' -f1)
  if [ "$m" != "$CUR_MD5" ]; then echo "!!! 还原失败：$m != $CUR_MD5"; else echo "[restore] motion-engine.js 已还原 = $m ✓"; fi
}
trap restore EXIT INT TERM

echo "=== [0] 前置校验 ==="
echo "现行备份 md5 = $(md5sum $CUR_BAK | cut -d' ' -f1)"
echo "旧引擎   md5 = $(md5sum $OLD_SRC | cut -d' ' -f1)"

echo "" | tee -a build/_regress-repfix-AB.txt
echo "=== [1] 直测探针（现行引擎 168d6829）：合成人形的 repGate vs repSpread ===" | tee -a build/_regress-repfix-AB.txt
timeout -k 10 120 "$N" build/_probe-repgate.js > build/_regress-repfix-probe.log 2>&1
echo "probe EXIT=$? engine=$(md5sum motion-engine.js | cut -c1-8)" | tee -a build/_regress-repfix-AB.txt

echo "" | tee -a build/_regress-repfix-AB.txt
echo "=== [2] A/B：换入【无门限】旧引擎，跑 motion-browser-test.js ===" | tee -a build/_regress-repfix-AB.txt
cp "$OLD_SRC" motion-engine.js
echo "A/B 运行期引擎 md5 = $(md5sum motion-engine.js | cut -d' ' -f1)（应为 4d5da7a1…）" | tee -a build/_regress-repfix-AB.txt
timeout -k 10 260 "$N" build/motion-browser-test.js > build/_regress-repfix-AB-oldengine.log 2>&1
echo "old-engine run EXIT=$?" | tee -a build/_regress-repfix-AB.txt

echo "" | tee -a build/_regress-repfix-AB.txt
echo "=== [3] 还原现行引擎 ===" | tee -a build/_regress-repfix-AB.txt
restore | tee -a build/_regress-repfix-AB.txt
trap - EXIT INT TERM

echo "" | tee -a build/_regress-repfix-AB.txt
echo "=== [4] 复跑 fit-voice-prep（确认那条失败是否可复现）===" | tee -a build/_regress-repfix-AB.txt
timeout -k 10 260 "$N" build/fit-voice-prep-test.js > build/_regress-repfix-fit-voice-prep-2.log 2>&1
echo "fit-voice-prep rerun EXIT=$? engine=$(md5sum motion-engine.js | cut -c1-8)" | tee -a build/_regress-repfix-AB.txt
echo "AB_ALL_DONE 最终引擎 md5=$(md5sum motion-engine.js | cut -d' ' -f1)" | tee -a build/_regress-repfix-AB.txt
