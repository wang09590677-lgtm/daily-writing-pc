#!/bin/bash
# 写作模块（AI 评分 / AI 范文参考 / 结果页 / 积分）的回归子集。
# 为什么是这几条：本子集覆盖"每日一写 → 提交 → 评分 → 结果页 → 范文"这条链路，
#   2026-10-11 在写作页新增了「AI 范文参考」按钮 + 门禁，改的就是这条链路（R8）。
#
# ⚠️ 别写死 managed runtime 的版本号后缀：目录名会变（实测 22.22.2-3 → 22.22.2-6）。
#    写死时的表现是 **exit=127、整批用例全红**，非常容易被误判成代码回归。
export NODE_PATH="C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules"
NV=$(ls -1 "C:/Users/lixue/.workbuddy-ai/binaries/node/versions/" | grep -E '^[0-9]' | sort -V | tail -1)
NODE="C:/Users/lixue/.workbuddy-ai/binaries/node/versions/$NV/node.exe"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
cd "$(dirname "$0")"
echo "node = $NODE"
for t in _probe-fillgap-grader _probe-fillgap _probe-genmodel-gate _probe-ai-model-card ai-grader-test ai-grader-e2e ai-model-e2e result-layout-password-test admin-password-test points-browser-test; do
  echo ""; echo "###### $t ######"
  if [ -f "$t.js" ]; then
    "$NODE" "$t.js" 2>&1 | grep -E "合计|通过|PASS|FAIL|FATAL" | tail -4
  else echo "(不存在)"; fi
  sleep 6
done
echo ""; echo "###### 完成 ######"
