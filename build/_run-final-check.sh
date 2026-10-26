#!/bin/bash
export NODE_PATH="C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules"
NODE="C:/Users/lixue/.workbuddy-ai/binaries/node/versions/22.22.2-3/node.exe"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
cd "$(dirname "$0")"
for t in accept-cat-glb cat-avatar-test avatar-test accept-motion-autostart pose-calib-test; do
  echo ""; echo "###### $t ######"
  "$NODE" "$t.js" 2>&1 | grep -E "通过|PASS|FAIL|FATAL" | tail -5
  sleep 7
done
echo ""; echo "###### 空房扫描超时闸 ######"
"$NODE" _verify-roomscan-timeout.js 2>&1 | tail -4
echo ""; echo "###### 完成 ######"
