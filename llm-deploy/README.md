# llm-deploy：在 Colab GPU 上一键部署 GGUF 模型

用 `colab` CLI 开一台 Colab GPU，自动安装 llama.cpp（官方预编译 CUDA 版），下载 HuggingFace 上的 GGUF 模型，
启动 `llama-server`，预热后把 **OpenAI 兼容 API + 网页聊天** 通过 SSH 隧道转发到本地。

- `deploy.sh`：本地入口，在装了 `colab` CLI 的 Linux / WSL 里运行
- `worker.py`：由 `deploy.sh` 传到 VM 上后台执行，不要在本地运行

## 快速开始

```bash
cd llm-deploy
./deploy.sh up -s scarlet          # 默认：A100 + bartowski/ScarletKc_ScarletKc-2.0-GGUF Q8_0 + 模型最大上下文
```

在 Windows 上也可以直接调用 WSL：

```bash
wsl -e bash -lc "cd /mnt/c/Users/kc/Documents/GitHub/colab-playground/llm-deploy && ./deploy.sh up -s scarlet"
```

完成后：

| 用途 | 地址 |
|---|---|
| 网页聊天 | http://localhost:8000 |
| OpenAI API | http://localhost:8000/v1 （默认无 key；模型 id 见输出里的 `model=`） |

`up` 最后会在前台保持隧道。按 Ctrl+C **只关隧道，VM 继续计费**。用完一定要：

```bash
./deploy.sh down -s scarlet
```

## 命令

| 命令 | 作用 |
|---|---|
| `up` | 创建会话（同名已存在就复用）→ 部署 → 预热测速 → 前台开隧道 |
| `tunnel` | 只开/重连隧道（断线自动重连） |
| `status` | 部署阶段、模型信息、显存、服务日志尾部 |
| `logs` | worker / server 日志尾部 |
| `down` | 只停止 `-s` 指定的会话，不会动别的会话 |

常用选项（完整列表见 `./deploy.sh -h`）：

| 选项 | 说明 | 默认 |
|---|---|---|
| `-s NAME` | 会话名 | `llm` |
| `-g GPU` | `A100` `H100` `L4` `G4` `T4` `none` | `A100` |
| `-r REPO` / `-q QUANT` | HF 仓库 / 量化（`Q8_0`、`Q6_K`、`Q4_K_M`…） | ScarletKc-2.0 / `Q8_0` |
| `-c CTX` | 上下文，`0` = 模型最大值 | `0` |
| `-p` / `-l` | VM 端口 / 本地端口 | `8000` |
| `-a ALIAS` | API 里的模型 id | 由仓库名推导，如 `scarletkc-2.0` |
| `-k KEY` | 给 API 加 key | 无 |
| `--kv` | KV cache 类型；`auto` 先试 f16，显存不够自动降 q8_0 | `auto` |
| `--mtp` | MTP 投机解码；`auto` 检测到 MTP 层就开 | `auto` |
| `--mmproj` | 视觉投影；`auto` 有就加载（优先 f16），`none` 关闭 | `auto` |

私有 / gated 模型：先在本地 `export HF_TOKEN=...`，脚本会通过 `colab exec --env` 传给 VM（不落盘）。

## 工作原理

1. `colab new` 创建会话；GPU 名称先在本地校验（`colab new` 遇到不认识的 `--gpu` 会**静默退回 A100**）。
2. 用一次 `colab exec` 把 `worker.py` 写到 VM 的 `/content/deploy/` 并以独立进程组后台启动。
3. worker 并行做两件事：下载 llama.cpp 预编译包（`ubuntu-cuda-12.8-x64` + 对应 cudart 包），
   以及用 `hf download`（xet 加速）下载 GGUF 和 mmproj。
4. 用 `llama-server --list-devices` 确认识别到 CUDA，再以 `-ngl 999 -fa on --jinja -np 1` 启动；
   启动失败（多半是 OOM）就按 f16 → q8_0 KV、有 MTP → 无 MTP 的顺序自动降级重试。
5. 检查显存确实被占用（防止静默跑在 CPU 上），发两个请求预热并测速，写 `info.json`。
6. 本地每 10 秒用 `colab exec` 读一次 `status.txt` 显示进度；就绪后写 `~/.ssh/config` 的
   `Host colab-<会话名>`，用 `ssh -N -L` 开隧道。

VM 上的文件：`/content/deploy/{status.txt,info.json,worker.log,server.log,server.cmd}`，
模型在 `/content/models`，llama.cpp 在 `/content/llama-bin`。

## 显存怎么估（以 ScarletKc-2.0 Q8_0 为例）

Colab 的 A100 **40GB 还是 80GB 是随机分配的**，无法指定；`--high-mem` 只影响系统内存。

ScarletKc-2.0（Qwen3.5 架构）64 层里只有 16 层是全注意力，其余是线性注意力，所以 KV cache 很小：
每 token ≈ 16 层 × 2(K,V) × 4 头 × 256 维 × 2 字节 = 64 KiB。

| 项目 | 256k + f16 KV | 256k + q8_0 KV |
|---|---|---|
| Q8_0 权重 | 27.1 GiB | 27.1 GiB |
| mmproj + 计算缓冲 | ~2 GiB | ~2 GiB |
| KV cache | ~16 GiB | ~8.5 GiB |
| MTP 草稿层 KV | ~1 GiB | ~0.5 GiB |
| 合计 | ~46 GiB：80G ✅ / 40G ❌ | ~38 GiB：40G 勉强 ⚠️ |

实测（A100-80GB，256k，f16 KV，MTP 开）：显存占用 46.8 GiB，生成约 64 tok/s，MTP 接受率约 50%。
`--kv auto` 在 40G 卡上会自动落到 q8_0。

## 踩坑记录（2026-11-16 首次部署）

这些坑都已在脚本里规避，记录下来方便排查。

### 1. 从源码编译 llama.cpp，白白浪费 10 分钟 GPU 时间
- **现象**：`git clone` + `cmake -DGGML_CUDA=ON` 在 12 核 VM 上要编十几分钟，A100 一直空转计费。
- **原因**：误以为官方没有 Linux CUDA 预编译包。实际 release 里有
  `llama-<tag>-bin-ubuntu-cuda-12.8-x64.tar.gz` 和 `cudart-llama-<tag>-bin-ubuntu-cuda-12.8-x64.tar.gz`。
- **解决**：直接下载预编译包，cudart 包里的 `libcudart/libcublas` 拷到 `llama-server` 旁边。
  cuda-12.8 的包在 Colab 的 580 驱动（CUDA 13）上正常工作。
- 另外：Colab 的 `nvcc` 在 `/usr/local/cuda/bin`，不在 SSH 环境的 `PATH` 里，源码编译要先 `export PATH`。

### 2. 服务起来了，却在 CPU 上跑（显存 0 MiB）
- **现象**：`llama-server` 正常监听，日志没有报错，但 `nvidia-smi` 显存占用 0，
  `--list-devices` 输出 `Available devices: (none)`。
- **原因**：预编译包需要驱动库 `libcuda.so.1`，Colab 把它放在 `/usr/lib64-nvidia`，
  而 `colab ssh` / 后台进程的环境里这个目录不在库搜索路径中。CUDA 后端加载失败后**静默退回 CPU**。
- **解决**：`LD_LIBRARY_PATH=<llama 目录>:/usr/lib64-nvidia`。worker 启动前先用 `--list-devices`
  确认有 `CUDA0`，启动后再检查显存占用。

### 3. 端口 8080 绑定失败
- **现象**：`couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 8080`。
- **原因**：Colab VM 上自带的 node 进程已经监听 `*:8080`。
- **解决**：默认改用 8000，脚本拒绝 `-p 8080`。

### 4. SSH 隧道报 429
- **现象**：`Already-active SSH session (HTTP 429): another colab ssh is connected to this runtime`。
- **原因**：一个 runtime **同时只允许一个** `colab ssh` 连接。我在后台用 `colab ssh -- cmd`
  循环轮询状态，正好占住了名额，隧道就连不上（反过来也一样：隧道开着时 `colab ssh -- cmd` 会 429）。
- **解决**：SSH 名额只留给隧道，所有检查、启动都走 `colab exec`（走 Jupyter kernel，不占 SSH）。
  需要跑 shell 时用 `colab exec` 里的 `!cmd` 或 `subprocess`。

### 5. 用 `colab exec` 跑 `%%bash` 启动服务，命令没执行
- **现象**：`colab exec` 返回 `RuntimeError: Connection was lost.`，服务没起来，日志还是上一次的。
- **解决**：在 Python 里用 `subprocess.Popen(..., start_new_session=True)` 拉起后台进程，
  exec 调用本身几秒就返回；长任务放在独立进程里跑，本地只做短轮询。

### 6. 第一个请求极慢
- **现象**：重启服务后第一个请求 prompt 处理只有约 1 tok/s（56 token 用了 47 秒）。
  第二个请求起 prompt 约 85 tok/s，生成约 64 tok/s。
- **原因**：首次推理时 CUDA kernel 的 JIT / 初始化开销。
- **解决**：worker 就绪前先发预热请求，交付给你的时候已经是热的。

### 7. GitHub 的 "latest" release 下不到预编译包
- **现象**：`releases/latest` 指向一个没有附件的 `v1.0.0`，按它拼出的下载地址 404。
- **解决**：用 `git ls-remote --tags` 取最新的几个 `bNNNN` 构建 tag，逐个尝试（最新 tag 的附件可能还没上传完），
  全失败再回退到已验证的 `b12430`。不用 GitHub API，因为 Colab 出口 IP 共享，匿名调用容易被限流。

### 8. 其他
- `hf download` 需要较新的 `huggingface_hub[hf_xet]`；升级会提示和 Colab 预装的 `datasets` 版本冲突，可以忽略。
  29 GB 的 Q8_0 约 2 分钟下完。
- 在 Windows 的 Git Bash 里 `curl -d '{"content":"中文"}'` 会把中文按本地编码发出去，服务端解析失败。
  测试中文请把 JSON 写进 UTF-8 文件，再用 `--data-binary @file` 发送。
- `colab sessions` 里显示为 `[?]` 的会话不是本机 CLI 创建的（比如网页端开的），没有本地名字；
  `deploy.sh down` 只会停 `-s` 指定的会话，不会误关它们。
- 隧道进程跟着启动它的终端走，终端关了隧道就断；服务器还在，`./deploy.sh tunnel -s <名>` 重连即可。

## 验证情况

- 手动流程：A100-80GB + ScarletKc-2.0 Q8_0 + 256k 上下文，实测可用（见上方数据）。
- 脚本端到端：CPU 会话 + `unsloth/Qwen3-0.6B-GGUF` Q4_K_M 已跑通 `up` → `tunnel` → API 调用 → `status` → `down`
  （llama.cpp b12431）。脚本的 GPU 分支（`--list-devices` 检查、显存检查、OOM 降级）还没在 GPU 会话上跑过，
  首次在 A100 上使用时留意输出。

## 费用提醒

- 会话只要存在就计费，**跟有没有请求无关**。Ctrl+C 只关隧道，用完一定要执行 `./deploy.sh down -s <名>`。
- 部署耗时（A100，29 GB 模型）：建会话约 1 分钟，下载约 2 分钟，加载和预热约 2 分钟。
