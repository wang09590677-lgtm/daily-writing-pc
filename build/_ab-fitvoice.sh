#!/bin/bash
# 聚焦 A/B：fit-voice-prep 那条失败是否由本轮 app.js 改动引入。
# 换入改前 app.js（0ad6c397），跑 fit-voice-prep，再还原（trap 保证）。
cd "D:/workbuddy/2026-09-26-20-02-15/daily-writing-pc" || exit 9
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
export NODE_PATH=C:/Users/lixue/.workbuddy-ai/binaries/node/workspace/node_modules
N="C:/Users/lixue/.workbuddy-ai/binaries/node/versions/22.22.2-3/node.exe"
CUR_MD5="b98ce335dd5dd55b60dac7188a04c457"
BAK="build/_ab-backup-current-app.js"
OLD="build/_rollback/app.before-repgate.js"   # 0ad6c397 = 本轮 app.js 改动之前

restore(){
  cp "$BAK" app.js
  local m=$(md5sum app.js | cut -d' ' -f1)
  [ "$m" = "$CUR_MD5" ] && echo "[restore] app.js 已还原 = $m ✓" || echo "!!! app.js 还原失败：$m"
}
trap restore EXIT INT TERM

cp app.js "$BAK"
echo "app.js 现行 = $(md5sum app.js | cut -d' ' -f1)（应为 $CUR_MD5）"
echo "改前 app.js = $(md5sum $OLD | cut -d' ' -f1)（应为 0ad6c397…）"
cp "$OLD" app.js
echo "A/B 运行期 app.js md5 = $(md5sum app.js | cut -d' ' -f1)  engine=$(md5sum motion-engine.js | cut -c1-8)"
timeout -k 10 260 "$N" build/fit-voice-prep-test.js > build/_regress-repfix-fit-voice-prep-oldapp.log 2>&1
echo "old-app run EXIT=$?"
restore
trap - EXIT INT TERM
echo "FITVOICE_AB_DONE engine=$(md5sum motion-engine.js | cut -d' ' -f1) app=$(md5sum app.js | cut -d' ' -f1)"
