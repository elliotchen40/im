#!/usr/bin/env bash
# ============================================================
# im 服务端一键验证
#
#   ./scripts/verify.sh
#
# 依次执行：
#   1) 静态一致性守门（零依赖，先跑，快速暴露断链）
#   2) 安装依赖
#   3) TypeScript 类型检查
#   4) 启动 daemon + 端到端最小闭环（发消息 → 收回复 → 落库）
#
# 前置：cp .env.example .env 并填好
#   IM_APP_TOKEN / MODEL_<NAME>_API_KEY / SILICONFLOW_API_KEY
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1"; exit 1; }

# ---------------------------------------------------------------- 1) 守门
step "1/4 静态一致性守门"
node scripts/check_imports.mjs src || fail "静态守门未通过（上面列了断链/残留）"

# ---------------------------------------------------------------- 2) 依赖
step "2/4 安装依赖"
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund || fail "npm install 失败（检查网络 / better-sqlite3 编译环境）"
else
  echo "node_modules 已存在，跳过"
fi

# ---------------------------------------------------------------- 3) 类型
step "3/4 TypeScript 类型检查"
npx tsc --noEmit || fail "类型检查未通过"

# ---------------------------------------------------------------- 4) 端到端
step "4/4 端到端最小闭环"
[ -f .env ] || fail "缺少 .env（先 cp .env.example .env 并填写）"
TOKEN="$(grep -E '^IM_APP_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)"
[ -n "$TOKEN" ] || fail ".env 里的 IM_APP_TOKEN 为空 —— 服务端会拒绝启动（这是有意的安全设计）"

PORT="$(grep -E '^IM_HTTP_PORT=' .env | head -1 | cut -d= -f2- | tr -d ' ' || true)"
PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"

echo "启动 daemon（后台，日志 /tmp/im_verify.log）..."
npm run dev > /tmp/im_verify.log 2>&1 &
DAEMON_PID=$!
cleanup() { kill "$DAEMON_PID" 2>/dev/null || true; }
trap cleanup EXIT

for i in $(seq 1 30); do
  if curl -fsS "${BASE}/im/health" > /dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" = "30" ] && { tail -30 /tmp/im_verify.log; fail "daemon 30s 内未就绪"; }
done

echo "健康检查："
curl -fsS "${BASE}/im/health" && echo

echo "发一条消息（假装是鸿蒙 app）："
curl -fsS -X POST "${BASE}/im/send" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"clientMsgId":"verify-1","text":"你好"}' && echo

echo "长轮询拉回复（最多等 60s；需真实 LLM key）："
curl -fsS -X POST "${BASE}/im/sync" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"cursor":""}' && echo

step "全部完成"
echo "daemon 日志尾部："
tail -20 /tmp/im_verify.log
echo
echo "落库自检（可选）："
echo "  sqlite3 data/soul/wx_bot_ASHLEY.db \"SELECT role, substr(content,1,40), initiator FROM dialogues ORDER BY id DESC LIMIT 5;\""
