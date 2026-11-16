#!/usr/bin/env bash
# 在 Colab GPU 上用 llama.cpp 部署 HuggingFace GGUF 模型，并把 OpenAI 兼容 API 转发到本地。
# 在装有 colab CLI 的 Linux / WSL 里运行。详细说明与踩坑记录见同目录 README.md。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER="$HERE/worker.py"

# ---- 默认值（可用参数覆盖）
SESSION=llm
GPU=A100
REPO=bartowski/ScarletKc_ScarletKc-2.0-GGUF
QUANT=Q8_0
CTX=0            # 0 = 模型训练时的最大上下文
PORT=8000        # VM 上 llama-server 端口（8080 被 Colab 占用）
LOCAL_PORT=""    # 本地端口，默认同 PORT
ALIAS=""
KV=auto
MMPROJ=auto
MTP=auto
HIGH_MEM=0
TUNNEL=1
LLAMA_TAG=latest
API_KEY=""
EXTRA_ARGS=""

usage() {
  cat <<'EOF'
用法: deploy.sh <命令> [选项]

命令:
  up       创建会话（已存在则复用）→ 部署模型 → 预热 → 打开端口转发（前台，Ctrl+C 只关隧道）
  tunnel   只打开/重连端口转发
  status   查看部署状态、显存、服务日志尾部
  logs     查看完整的 worker / server 日志尾部
  down     停止会话（停止计费）

选项:
  -s NAME        会话名                         默认 llm
  -g GPU         A100 | H100 | L4 | G4 | T4 | none   默认 A100
  -r REPO        HF 仓库                        默认 bartowski/ScarletKc_ScarletKc-2.0-GGUF
  -q QUANT       量化，如 Q8_0 / Q6_K / Q4_K_M   默认 Q8_0
  -c CTX         上下文长度，0 = 模型最大值      默认 0
  -p PORT        VM 端口                        默认 8000
  -l PORT        本地端口                       默认同 -p
  -a ALIAS       API 里的模型 id                默认由仓库名推导
  -k KEY         给 API 加 key（--api-key）
  --kv TYPE      auto | f16 | q8_0 | q4_0       默认 auto（先 f16，OOM 自动降 q8_0）
  --mmproj X     auto | none | 文件名片段        默认 auto（有就加载，优先 f16）
  --mtp X        auto | on | off                默认 auto（模型带 MTP 层就开）
  --llama TAG    llama.cpp 版本，如 b12430      默认 latest
  --high-mem     申请高内存机型
  --no-tunnel    up 完成后不自动开端口转发
  --extra "..."  追加给 llama-server 的参数

示例:
  ./deploy.sh up -s scarlet
  ./deploy.sh up -s small -g L4 -q Q4_K_M -c 65536
  ./deploy.sh down -s scarlet
EOF
}

log() { echo "[deploy] $*" >&2; }
die() { echo "[deploy] 错误: $*" >&2; exit 1; }

# ---- 参数解析
CMD="${1:-}"; [[ -n $CMD ]] && shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    -s) SESSION="$2"; shift 2 ;;
    -g) GPU="$2"; shift 2 ;;
    -r) REPO="$2"; shift 2 ;;
    -q) QUANT="$2"; shift 2 ;;
    -c) CTX="$2"; shift 2 ;;
    -p) PORT="$2"; shift 2 ;;
    -l) LOCAL_PORT="$2"; shift 2 ;;
    -a) ALIAS="$2"; shift 2 ;;
    -k) API_KEY="$2"; shift 2 ;;
    --kv) KV="$2"; shift 2 ;;
    --mmproj) MMPROJ="$2"; shift 2 ;;
    --mtp) MTP="$2"; shift 2 ;;
    --llama) LLAMA_TAG="$2"; shift 2 ;;
    --high-mem) HIGH_MEM=1; shift ;;
    --no-tunnel) TUNNEL=0; shift ;;
    --extra) EXTRA_ARGS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（-h 查看帮助）" ;;
  esac
done
LOCAL_PORT="${LOCAL_PORT:-$PORT}"
GPU="$(echo "$GPU" | tr '[:lower:]' '[:upper:]')"
# colab new 遇到不认识的 --gpu 会静默退回 A100，这里先校验
case "$GPU" in A100|H100|L4|G4|T4|NONE) ;; *) die "不支持的 GPU: $GPU" ;; esac
[[ $PORT == 8080 ]] && die "VM 的 8080 端口被 Colab 自己的服务占用，换一个 -p"

command -v colab >/dev/null || die "找不到 colab CLI（uv tool install google-colab-cli）"

session_exists() { colab sessions 2>/dev/null | grep -q "^\[$SESSION\] "; }

# 在 VM 上执行 stdin 中的 Python，只用 colab exec（不占 SSH 名额）
vm_py() { colab exec -s "$SESSION" --timeout 120 "$@"; }

ensure_ssh_host() {
  local cfg="$HOME/.ssh/config" host="colab-$SESSION"
  mkdir -p "$HOME/.ssh"; touch "$cfg"; chmod 600 "$cfg"
  grep -q "^Host $host\$" "$cfg" && return 0
  [[ -f $HOME/.ssh/id_ed25519.pub || -f $HOME/.ssh/id_ecdsa.pub ]] ||
    ssh-keygen -q -t ed25519 -N "" -f "$HOME/.ssh/id_ed25519"
  printf '\nHost %s\n  ProxyCommand %s ssh --proxy-mode -s %s\n  User root\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n  ServerAliveInterval 30\n' \
    "$host" "$(command -v colab)" "$SESSION" >> "$cfg"
  log "已在 $cfg 添加 Host $host"
}

launch_worker() {
  local b64 envs=()
  b64="$(base64 -w0 "$WORKER")"
  envs+=(--env "DEPLOY_REPO=$REPO" --env "DEPLOY_QUANT=$QUANT" --env "DEPLOY_CTX=$CTX"
         --env "DEPLOY_PORT=$PORT" --env "DEPLOY_ALIAS=$ALIAS" --env "DEPLOY_KV=$KV"
         --env "DEPLOY_MMPROJ=$MMPROJ" --env "DEPLOY_MTP=$MTP" --env "DEPLOY_LLAMA_TAG=$LLAMA_TAG"
         --env "DEPLOY_API_KEY=$API_KEY" --env "DEPLOY_EXTRA_ARGS=$EXTRA_ARGS")
  [[ -n ${HF_TOKEN:-} ]] && envs+=(--env "HF_TOKEN=$HF_TOKEN")
  # worker 以独立进程组在后台跑；本地只做短轮询，exec 掉线不影响部署
  vm_py "${envs[@]}" <<EOF
import base64, os, subprocess
os.makedirs('/content/deploy', exist_ok=True)
subprocess.run(['pkill', '-f', '/content/deploy/worker.py'], check=False)
for f in ('status.txt', 'info.json'):
    try: os.remove('/content/deploy/' + f)
    except FileNotFoundError: pass
open('/content/deploy/worker.py', 'wb').write(base64.b64decode('$b64'))
p = subprocess.Popen(['python3', '-u', '/content/deploy/worker.py'],
                     stdout=open('/content/deploy/worker.log', 'w'), stderr=subprocess.STDOUT,
                     stdin=subprocess.DEVNULL, start_new_session=True, env=dict(os.environ))
print('worker pid', p.pid)
EOF
}

read_status() {
  vm_py 2>/dev/null <<'EOF' | tail -n 1
import os
p = '/content/deploy/status.txt'
print(open(p).read().strip() if os.path.exists(p) else 'starting\t等待 worker 启动')
EOF
}

wait_ready() {
  local line stage msg last="" t0=$SECONDS
  while :; do
    line="$(read_status || true)"
    stage="${line%%$'\t'*}"; msg="${line#*$'\t'}"
    if [[ -n $line && $line != "$last" ]]; then
      log "[$(( (SECONDS - t0) / 60 ))m$(( (SECONDS - t0) % 60 ))s] $stage: $msg"
      last="$line"
    fi
    case "$stage" in
      ready) return 0 ;;
      failed)
        log "部署失败，日志尾部："; cmd_logs || true
        die "会话 $SESSION 仍在运行（计费中），排查完用: $0 down -s $SESSION" ;;
    esac
    (( SECONDS - t0 > 3600 )) && die "等待超过 60 分钟，用 '$0 status -s $SESSION' 排查"
    sleep 10
  done
}

print_summary() {
  local base="http://localhost:$LOCAL_PORT"
  cat >&2 <<EOF

[deploy] ✅ 部署完成（会话 $SESSION）
  网页聊天:  $base
  OpenAI API: $base/v1   （模型 id 见上面 model=，或 GET $base/v1/models）
  重连隧道:  $0 tunnel -s $SESSION -p $PORT${LOCAL_PORT:+ -l $LOCAL_PORT}
  停止计费:  $0 down -s $SESSION
EOF
}

cmd_up() {
  [[ -f $WORKER ]] || die "缺少 $WORKER"
  if session_exists; then
    log "会话 $SESSION 已存在，复用"
  else
    local args=(new -s "$SESSION")
    [[ $GPU != NONE ]] && args+=(--gpu "$GPU")
    (( HIGH_MEM )) && args+=(--high-mem)
    log "创建会话 $SESSION（GPU=$GPU）..."
    colab "${args[@]}" || die "创建会话失败（400 通常是没有该 GPU 的配额，换 -g L4 / T4 试试）"
  fi
  launch_worker >/dev/null || die "启动 worker 失败"
  wait_ready
  ensure_ssh_host
  print_summary
  (( TUNNEL )) && cmd_tunnel
  return 0
}

cmd_tunnel() {
  session_exists || die "会话 $SESSION 不存在"
  ensure_ssh_host
  log "端口转发 localhost:$LOCAL_PORT → VM:$PORT（Ctrl+C 关闭隧道，VM 仍在计费）"
  trap 'echo >&2; log "隧道已关闭。停止计费: $0 down -s $SESSION"; exit 0' INT TERM
  local fails=0 t
  while :; do
    t=$SECONDS
    ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      -L "127.0.0.1:$LOCAL_PORT:127.0.0.1:$PORT" "colab-$SESSION" || true
    if (( SECONDS - t < 10 )); then fails=$((fails + 1)); else fails=0; fi
    if (( fails >= 5 )); then
      die "隧道连续失败。常见原因：本地端口 $LOCAL_PORT 被占用（换 -l）；有别的 colab ssh 连着该 runtime（429，同时只允许一个）；会话已被回收"
    fi
    session_exists || die "会话 $SESSION 已不存在"
    log "隧道断开，3 秒后重连..."
    sleep 3
  done
}

cmd_status() {
  session_exists || die "会话 $SESSION 不存在"
  vm_py <<'EOF'
import os, subprocess
def cat(p):
    return open(p).read().strip() if os.path.exists(p) else '(无)'
print('状态:', cat('/content/deploy/status.txt').replace('\t', ': '))
print('信息:', cat('/content/deploy/info.json'))
print(subprocess.run('nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader; '
                     'pgrep -a llama-server | cut -c1-200; tail -n 5 /content/deploy/server.log',
                     shell=True, capture_output=True, text=True).stdout)
EOF
}

cmd_logs() {
  vm_py <<'EOF'
import subprocess
print(subprocess.run('echo "== worker.log"; tail -n 30 /content/deploy/worker.log; '
                     'echo "== server.log"; tail -n 30 /content/deploy/server.log',
                     shell=True, capture_output=True, text=True).stdout)
EOF
}

cmd_down() {
  session_exists || { log "会话 $SESSION 不存在（可能已停止）"; colab sessions || true; return 0; }
  colab stop -s "$SESSION"
  log "剩余会话："; colab sessions || true
}

case "$CMD" in
  up) cmd_up ;;
  tunnel) cmd_tunnel ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  down) cmd_down ;;
  ""|-h|--help|help) usage ;;
  *) die "未知命令: $CMD（-h 查看帮助）" ;;
esac
