#!/bin/bash
# 新猫模型替换后的既有回归（串行 + 间隔，避免多个 Chrome 互抢资源造成假失败）
export NODE_PATH="C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules"
NODE="C:/Users/lixue/.workbuddy-ai/binaries/node/versions/22.22.2-3/node.exe"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
cd "$(dirname "$0")"
for t in accept-motion-autostart pose-calib-test accept-pose-vision accept-motion-autonext avatar-test accept-pose-model-tier; do
  echo ""
  echo "############ $t ############"
  if [ -f "$t.js" ]; then
    "$NODE" "$t.js" 2>&1 | grep -E "通过|PASS|FAIL|FATAL|Error|错误" | tail -8
  else
    echo "(文件不存在)"
  fi
  sleep 6
done
echo ""
echo "############ 完成 ############"
