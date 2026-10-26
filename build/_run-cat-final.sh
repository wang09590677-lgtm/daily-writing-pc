#!/bin/bash
export NODE_PATH="C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules"
NODE="C:/Users/lixue/.workbuddy-ai/binaries/node/versions/22.22.2-3/node.exe"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
cd "$(dirname "$0")"
for t in accept-cat-glb cat-avatar-test avatar-test accept-motion-autostart accept-motion-autonext; do
  echo ""
  echo "############ $t ############"
  "$NODE" "$t.js" 2>&1 | grep -E "通过|PASS|FAIL|FATAL" | tail -6
  sleep 6
done
echo ""
echo "############ 完成 ############"
