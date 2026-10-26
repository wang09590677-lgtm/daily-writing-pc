#!/usr/bin/env bash
# 深度→关节 z 这一轮改动之后的**受影响子集**回归。
# 为什么只跑子集：全量里的 3 个 AI 用例要走网络，占掉整轮一大半时间；
#   而本轮改动只碰 skeletonSnapshot / rawWorld / depth-link，受影响的就是下面这些。
# 跑完子集之后仍要跑一次全量（R8）。
#
# 为什么必须串行 + 间隔：见 build/_final-regress.sh 顶部说明（并行开 Chrome 会假失败）。
# ⚠️ 跑之前先确认没有别的重负载在跑（尤其别同时开摄像头探针）——
#    实测：并发占摄像头/CPU 会让 pose-calib-test 整组 seen=false 假失败。
# ⚠️ 并且必须**没有深度桥在跑**：_verify-roomscan-timeout.js 要自己占 8765
#    起假桥（见该文件头部）；真桥占着端口时它会 exit 2 并给出明确提示。
cd "$(dirname "$0")/.." || exit 1
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY

NODE="C:/Users/lixue/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe"
export NODE_PATH="C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules"

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
fit-sequence-test.js
fit-motion-voice-test.js
"

PASS=0
FAIL=0
FAILED=""
LOG="build/_regress-depthz.log"
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
    printf '%s\n' "$OUT" | tail -20 >> "$LOG"
  fi
  sleep 4
done

echo "" | tee -a "$LOG"
echo "===== 子集合计：$PASS 个通过 / $FAIL 个失败 =====" | tee -a "$LOG"
[ -n "$FAILED" ] && echo "失败项:$FAILED" | tee -a "$LOG"
exit $FAIL
