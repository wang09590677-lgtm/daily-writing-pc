#!/bin/bash
# 临时回归跑批脚本（非生产文件）：串行 + 每条硬超时 + 记录引擎 md5 锁定版本。
# 跑完即删。用法: bash build/_regress-runner.sh
cd "D:/workbuddy/2026-09-26-20-02-15/daily-writing-pc" || exit 9
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
export NODE_PATH=C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules
N="C:/Users/lixue/.workbuddy-ai/binaries/node/versions/22.22.2-3/node.exe"
V=build/_regress-repfix-versions.txt
echo "ENGINE_AT_START $(md5sum motion-engine.js)" > "$V"
run(){
  local name="$1" file="$2" tmo="${3:-220}"
  echo "[$(date +%H:%M:%S)] START $file" | tee -a "$V"
  timeout -k 10 "$tmo" "$N" "build/$file" > "build/_regress-repfix-$name.log" 2>&1
  local ec=$?
  echo "[$(date +%H:%M:%S)] END $file EXIT=$ec engine=$(md5sum motion-engine.js | cut -c1-8)" | tee -a "$V"
  sleep 6
}
run motion-browser motion-browser-test.js 220
run autostart accept-motion-autostart.js 220
run pose-calib pose-calib-test.js 220
run pose-vision accept-pose-vision.js 220
run cat-avatar cat-avatar-test.js 220
run fit-voice-prep fit-voice-prep-test.js 220
echo "ENGINE_AT_END $(md5sum motion-engine.js)" | tee -a "$V"
echo "ALL_DONE" | tee -a "$V"
