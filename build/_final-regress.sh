#!/usr/bin/env bash
# 四条需求全部改完后的最终全量回归。
# 为什么必须串行：并行开多个 Chrome 会互相抢资源导致假失败（本项目实测过多次）。
# 为什么每个之间要 sleep：连跑后异常先单独复跑确认，别急着改代码。
#
# ⚠️ 跑之前必须**没有深度桥在跑**（tools/orbbec/openni-bridge.py 占 8765）。
#    原因：_verify-roomscan-timeout.js 现在自己占 8765 起一个"只握手、零推帧"的
#    假桥来验"桥连上但不推帧"那个分支（R9 密闭）。真桥占着端口时它会直接报
#    EADDRINUSE 并 exit 2 —— 那是**明确报错**，不是假失败，关掉桥重跑即可。
#    顺带：其余用例在桥关掉时跑得更干净（accept-real-room 等本来就不依赖真桥）。
cd "$(dirname "$0")/.." || exit 1
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY

NODE="C:/Users/lixue/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe"
export NODE_PATH="C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules"

# 已知既有失败（不是回归，不要修也不要放宽阈值）：
#   motion-browser-test 70/3、fit-voice-prep-test 53/1 —— 合成夹具摆幅小于幅度闸门
TESTS="
_probe-depthz.js
_probe-yaw-view.js
_probe-z-bend.js
_avatar-fixtures-check.js
accept-motion-autostart.js
accept-motion-autonext.js
accept-human-glb.js
human-avatar-test.js
avatar-test.js
avatar-portrait.js
pose-calib-test.js
accept-pose-vision.js
accept-pose-model-tier.js
accept-real-room.js
accept-no-file-access.js
_verify-roomscan-timeout.js
ai-model-e2e.js
ai-grader-e2e.js
ai-grader-test.js
history-calendar-test.js
fit-sequence-test.js
fit-motion-voice-test.js
result-layout-password-test.js
points-browser-test.js
"

PASS=0
FAIL=0
FAILED=""
LOG="build/_final-regress.log"
: > "$LOG"

for t in $TESTS; do
  if [ ! -f "build/$t" ]; then
    echo "SKIP  build/$t (不存在)" | tee -a "$LOG"
    continue
  fi
  OUT=$("$NODE" "build/$t" 2>&1)
  RC=$?
  LAST=$(printf '%s\n' "$OUT" | grep -E "PASS [0-9]+/[0-9]+|PASS|FAIL" | tail -1)
  if [ $RC -eq 0 ]; then
    PASS=$((PASS+1))
    printf 'OK    %-32s exit=0  %s\n' "$t" "$LAST" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1))
    FAILED="$FAILED $t"
    printf 'FAIL  %-32s exit=%d  %s\n' "$t" "$RC" "$LAST" | tee -a "$LOG"
    printf '%s\n' "$OUT" | tail -25 >> "$LOG"
  fi
  sleep 3
done

echo "" | tee -a "$LOG"
echo "===== 合计：$PASS 个通过 / $FAIL 个失败 =====" | tee -a "$LOG"
[ -n "$FAILED" ] && echo "失败项:$FAILED" | tee -a "$LOG"
exit $FAIL
