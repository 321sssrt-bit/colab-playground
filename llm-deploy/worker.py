#!/usr/bin/env python3
"""在 Colab VM 上后台运行的部署 worker（由 deploy.sh 上传并启动，不要在本地运行）。

流程：探测 GPU → 并行下载 llama.cpp 预编译 CUDA 版与 GGUF 模型 → 启动 llama-server
（显存不够时自动降级 KV cache）→ 预热（吃掉首个请求的 CUDA JIT 开销）→ 测速。

进度写入 /content/deploy/status.txt，格式为一行 "stage<TAB>message"，
stage ∈ starting / detect / download / server / warmup / ready / failed。
配置全部来自 DEPLOY_* 环境变量（由 deploy.sh 通过 `colab exec --env` 传入）。
"""
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

BASE = "/content/deploy"
MODELS = "/content/models"
BIN_ROOT = "/content/llama-bin"
SERVER_LOG = f"{BASE}/server.log"
FALLBACK_TAG = "b12430"  # 已验证可用的版本，取不到 latest 时使用
NVIDIA_LIB = "/usr/lib64-nvidia"  # Colab 的 libcuda.so.1 在这里，不在默认库路径

E = os.environ.get
REPO = E("DEPLOY_REPO", "")
QUANT = E("DEPLOY_QUANT", "Q8_0")
CTX = int(E("DEPLOY_CTX", "0"))
PORT = int(E("DEPLOY_PORT", "8000"))
ALIAS = E("DEPLOY_ALIAS", "")
KV = E("DEPLOY_KV", "auto")
MMPROJ = E("DEPLOY_MMPROJ", "auto")
MTP = E("DEPLOY_MTP", "auto")
TAG = E("DEPLOY_LLAMA_TAG", "latest")
API_KEY = E("DEPLOY_API_KEY", "")
EXTRA = E("DEPLOY_EXTRA_ARGS", "")
HF_TOKEN = E("HF_TOKEN", "")


def status(stage, msg=""):
    msg = msg.replace("\t", " ").replace("\n", " ")
    print(f"[{time.strftime('%H:%M:%S')}] {stage}: {msg}", flush=True)
    tmp = f"{BASE}/status.tmp"
    with open(tmp, "w") as f:
        f.write(f"{stage}\t{msg}\n")
    os.replace(tmp, f"{BASE}/status.txt")


def fail(msg):
    status("failed", msg)
    sys.exit(1)


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, **kw)


def http(url, data=None, timeout=30, headers=None):
    h = {"Content-Type": "application/json", **(headers or {})}
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def hf_headers():
    return {"Authorization": f"Bearer {HF_TOKEN}"} if HF_TOKEN else {}


def api_headers():
    return {"Authorization": f"Bearer {API_KEY}"} if API_KEY else {}


# ---------------------------------------------------------------- GPU
def gpu_info():
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, check=True).stdout.strip().splitlines()[0]
        name, mem = [x.strip() for x in out.split(",")]
        return name, int(mem)
    except Exception:
        return None, 0


def gpu_used_mib():
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, check=True).stdout.strip().splitlines()[0]
        return int(out.strip())
    except Exception:
        return 0


# ---------------------------------------------------------------- llama.cpp
def candidate_tags():
    """最新的几个 bNNNN 构建 tag（新到旧），最后兜底已验证版本。

    不用 releases/latest：它目前指向没有附件的 v1.0.0；也不用 GitHub API：Colab 出口 IP
    共享，匿名 API 容易被限流。git ls-remote 无此限制。最新 tag 的附件可能还没上传完，所以多给几个。
    """
    if TAG != "latest":
        return [TAG]
    tags = []
    try:
        out = subprocess.run(["git", "ls-remote", "--tags", "--refs",
                              "https://github.com/ggml-org/llama.cpp", "b*"],
                             capture_output=True, text=True, timeout=60).stdout
        nums = sorted({int(m.group(1)) for m in re.finditer(r"refs/tags/b(\d+)$", out, re.M)},
                      reverse=True)
        tags = [f"b{n}" for n in nums[:5]]
    except Exception:
        pass
    return tags + ([FALLBACK_TAG] if FALLBACK_TAG not in tags else [])


def fetch_llama(tag):
    url = f"https://github.com/ggml-org/llama.cpp/releases/download/{tag}"
    names = (f"llama-{tag}-bin-ubuntu-cuda-12.8-x64.tar.gz",
             f"cudart-llama-{tag}-bin-ubuntu-cuda-12.8-x64.tar.gz")
    for name in names:
        dst = f"{BIN_ROOT}/{name}"
        r = subprocess.run(["curl", "-fsSL", "--retry", "3", "-o", dst, f"{url}/{name}"])
        if r.returncode != 0:
            return False
    for name in names:
        run(["tar", "xzf", f"{BIN_ROOT}/{name}", "-C", BIN_ROOT])
        os.remove(f"{BIN_ROOT}/{name}")
    return True


def install_llama(result):
    """下载官方预编译 CUDA 版（比源码编译快 10 分钟以上）。结果写入 result dict。"""
    try:
        os.makedirs(BIN_ROOT, exist_ok=True)
        tag = None
        for cand in candidate_tags():
            if os.path.exists(f"{BIN_ROOT}/llama-{cand}/llama-server") or fetch_llama(cand):
                tag = cand
                break
            print(f"llama.cpp {cand} 预编译包下载失败，尝试下一个", flush=True)
        if not tag:
            raise RuntimeError("所有候选版本的预编译包都下载失败")
        bindir = f"{BIN_ROOT}/llama-{tag}"
        if not os.path.exists(f"{bindir}/llama-server"):
            found = [r for r, _, fs in os.walk(BIN_ROOT) if "llama-server" in fs and tag in r]
            if not found:
                raise RuntimeError(f"解压后找不到 llama-server（{tag}）")
            bindir = found[0]
        # cudart 包（libcudart/libcublas）解压在单独目录，拷到 llama-server 旁边
        for r, _, fs in os.walk(BIN_ROOT):
            if "cudart" in os.path.basename(r) and tag in r:
                for f in fs:
                    if ".so" in f and not os.path.exists(f"{bindir}/{f}"):
                        run(["cp", "-a", f"{r}/{f}", f"{bindir}/{f}"])
        result["tag"], result["bindir"] = tag, bindir
    except Exception as e:  # noqa: BLE001
        result["error"] = f"安装 llama.cpp 失败: {e}"


def server_env(bindir):
    paths = [bindir, NVIDIA_LIB, os.environ.get("LD_LIBRARY_PATH", "")]
    return dict(os.environ, LD_LIBRARY_PATH=":".join(p for p in paths if p))


# ---------------------------------------------------------------- 模型
def resolve_files():
    try:
        tree = http(f"https://huggingface.co/api/models/{REPO}/tree/main?recursive=true",
                    headers=hf_headers())
    except urllib.error.HTTPError as e:
        fail(f"读取 HF 仓库 {REPO} 失败: HTTP {e.code}（私有/gated 模型需在本地 export HF_TOKEN）")
    files = {f["path"]: f.get("size", 0) for f in tree
             if f.get("type") == "file" and f["path"].endswith(".gguf")}
    q = re.escape(QUANT.lower())
    pat = re.compile(rf"[-_.]{q}([-.]|$)")
    model = sorted(p for p in files
                   if "mmproj" not in p.lower() and pat.search(os.path.basename(p).lower()))
    if not model:
        quants = sorted({m.group(1) for p in files if "mmproj" not in p.lower()
                         for m in [re.search(r"-((?:I?Q|BF|F)\d[\w]*?)(?:-\d{5}-of-\d{5})?\.gguf$",
                                             os.path.basename(p), re.I)] if m})
        fail(f"仓库里没有 {QUANT} 的 GGUF。可选: {', '.join(quants) or '（无）'}")
    mm = None
    if MMPROJ != "none":
        cands = [p for p in files if "mmproj" in os.path.basename(p).lower()]
        if MMPROJ != "auto":
            cands = [p for p in cands if MMPROJ.lower() in p.lower()]
            if not cands:
                fail(f"找不到匹配 {MMPROJ} 的 mmproj 文件")
        # f16 兼容性最好（T4 没有原生 bf16），其次 bf16
        cands.sort(key=lambda p: (0 if re.search(r"[-_]f16", p.lower()) else
                                  1 if "bf16" in p.lower() else 2, p))
        mm = cands[0] if cands else None
    total = sum(files[p] for p in model) + (files[mm] if mm else 0)
    return model, mm, total


def dir_size(path):
    n = 0
    for r, _, fs in os.walk(path):
        for f in fs:
            try:
                n += os.path.getsize(os.path.join(r, f))
            except OSError:
                pass
    return n


def download(files, total):
    run([sys.executable, "-m", "pip", "install", "-q", "-U", "huggingface_hub[hf_xet]"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.makedirs(MODELS, exist_ok=True)
    done = threading.Event()

    def progress():
        while not done.wait(10):
            status("download", f"{dir_size(MODELS) / 1e9:.1f} / {total / 1e9:.1f} GB")
    threading.Thread(target=progress, daemon=True).start()
    try:
        run(["hf", "download", REPO, *files, "--local-dir", MODELS],
            stdout=open(f"{BASE}/download.log", "w"), stderr=subprocess.STDOUT)
    except subprocess.CalledProcessError:
        fail(f"模型下载失败，见 {BASE}/download.log")
    finally:
        done.set()


def has_mtp(path):
    """GGUF 头部元数据里有 nextn/MTP 相关键就认为带 MTP 层。"""
    try:
        with open(path, "rb") as f:
            head = f.read(64 * 1024 * 1024)
        return bool(re.search(rb"nextn_predict_layers|mtp_num_hidden_layers", head))
    except OSError:
        return False


# ---------------------------------------------------------------- 服务
def port_busy(port):
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


def kill_server():
    subprocess.run(["pkill", "-x", "llama-server"], check=False)
    for _ in range(30):
        if subprocess.run(["pgrep", "-x", "llama-server"], capture_output=True).returncode != 0:
            return
        time.sleep(1)


def start_server(bindir, model, mm, alias, kv, mtp):
    cmd = [f"{bindir}/llama-server", "-m", model, "-c", str(CTX), "-np", "1", "-ngl", "999",
           "-fa", "on", "--jinja", "--alias", alias,
           "--cache-type-k", kv, "--cache-type-v", kv,
           "--host", "127.0.0.1", "--port", str(PORT)]
    if mm:
        cmd += ["--mmproj", mm]
    if mtp:
        cmd += ["--spec-type", "draft-mtp"]
    if API_KEY:
        cmd += ["--api-key", API_KEY]
    cmd += shlex.split(EXTRA)
    with open(f"{BASE}/server.cmd", "w") as f:
        f.write(shlex.join(cmd) + "\n")
    # start_new_session：与 worker / kernel 脱离，exec 断开也不会被带走
    return subprocess.Popen(cmd, env=server_env(bindir), stdout=open(SERVER_LOG, "w"),
                            stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                            start_new_session=True)


def wait_healthy(p, timeout=1200):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if p.poll() is not None:
            return False
        try:
            if http(f"http://127.0.0.1:{PORT}/health", timeout=5).get("status") == "ok":
                return True
        except Exception:
            pass
        time.sleep(3)
    p.kill()
    return False


def log_tail(n=6):
    try:
        with open(SERVER_LOG, errors="replace") as f:
            return " | ".join(l.strip() for l in f.readlines()[-n:])
    except OSError:
        return ""


def chat(max_tokens, content):
    return http(f"http://127.0.0.1:{PORT}/v1/chat/completions",
                {"messages": [{"role": "user", "content": content}], "max_tokens": max_tokens},
                timeout=900, headers=api_headers())


def default_alias():
    name = REPO.rsplit("/", 1)[-1]
    name = re.sub(r"[-_]gguf$", "", name, flags=re.I)
    if "_" in name:  # bartowski 风格 "Org_Model"
        name = name.split("_", 1)[1]
    return name.lower()


def main():
    os.makedirs(BASE, exist_ok=True)
    if not REPO:
        fail("缺少 DEPLOY_REPO")
    status("detect", "探测 GPU")
    gpu, vram = gpu_info()
    status("detect", f"{gpu} {vram} MiB" if gpu else "无 GPU（CPU 运行）")

    llama = {}
    t = threading.Thread(target=install_llama, args=(llama,), daemon=True)
    t.start()
    status("download", "解析模型文件")
    model_files, mm_file, total = resolve_files()
    download(model_files + ([mm_file] if mm_file else []), total)
    t.join()
    if "error" in llama:
        fail(llama["error"])
    bindir = llama["bindir"]

    if gpu:  # 预编译包找不到 libcuda 时会静默退回 CPU，提前拦住
        out = subprocess.run([f"{bindir}/llama-server", "--list-devices"], env=server_env(bindir),
                             capture_output=True, text=True).stdout
        if "CUDA0" not in out:
            fail(f"llama.cpp 没识别到 GPU（检查 {NVIDIA_LIB}/libcuda.so.1）: {out.strip()[-200:]}")

    model = f"{MODELS}/{model_files[0]}"
    mm = f"{MODELS}/{mm_file}" if mm_file else None
    alias = ALIAS or default_alias()
    kv_opts = ["f16", "q8_0"] if KV == "auto" else [KV]
    if MTP == "auto":
        mtp_opts = [True, False] if has_mtp(model) else [False]
    else:
        mtp_opts = [MTP == "on"]

    kill_server()
    if port_busy(PORT):
        fail(f"VM 上端口 {PORT} 已被占用（Colab 自己占了 8080），换 -p")

    ok = False
    for mtp in mtp_opts:
        for kv in kv_opts:
            status("server", f"启动 llama-server（KV={kv}, MTP={'on' if mtp else 'off'}）")
            p = start_server(bindir, model, mm, alias, kv, mtp)
            if wait_healthy(p):
                ok = True
                break
            print(f"启动失败: {log_tail()}", flush=True)
            kill_server()
        if ok:
            break
    if not ok:
        fail(f"llama-server 启动失败: {log_tail()}")

    used = gpu_used_mib()
    if gpu and used < 1024:
        fail(f"服务起来了但显存只用了 {used} MiB，实际在 CPU 上跑")

    status("warmup", "预热（首个请求会触发 CUDA JIT，可能要 1 分钟左右）")
    try:
        chat(16, "hi")
        r = chat(256, "用三句话介绍一下你自己。")
        tps = r.get("timings", {}).get("predicted_per_second", 0)
    except Exception as e:  # noqa: BLE001
        fail(f"预热请求失败: {e}")
    try:
        n_ctx = http(f"http://127.0.0.1:{PORT}/props", timeout=10,
                     headers=api_headers())["default_generation_settings"].get("n_ctx", CTX)
    except Exception:
        n_ctx = CTX
    info = {"model_id": alias, "file": model_files[0], "mmproj": mm_file, "n_ctx": n_ctx,
            "kv": kv, "mtp": mtp, "gpu": gpu, "vram_used_mib": gpu_used_mib(),
            "vram_total_mib": vram, "tok_per_s": round(tps, 1), "llama_cpp": llama["tag"]}
    with open(f"{BASE}/info.json", "w") as f:
        json.dump(info, f, ensure_ascii=False, indent=1)
    status("ready", f"model={alias} ctx={n_ctx} KV={kv} MTP={'on' if mtp else 'off'} "
                    f"显存 {info['vram_used_mib']}/{vram} MiB 速度≈{info['tok_per_s']} tok/s")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        fail(f"worker 异常: {e!r}")
