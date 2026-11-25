import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

const DEFAULT_PROXY_TARGET = "http://127.0.0.1:3000";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parseLoopbackTarget(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `CPG_WEB_PROXY_TARGET must be an http:// loopback URL (got ${raw})`,
    );
  }
  return url;
}

function isActiveViteDevOrigin(
  incomingOrigin: string,
  requestHost: string | undefined,
  localPort: number | undefined,
): boolean {
  if (!requestHost || !localPort) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(incomingOrigin);
  } catch {
    return false;
  }
  if (parsed.origin !== incomingOrigin || parsed.protocol !== "http:") {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    return false;
  }
  const effectivePort = parsed.port === "" ? 80 : Number(parsed.port);
  if (effectivePort !== localPort) {
    return false;
  }
  const normalizedHost = requestHost.toLowerCase();
  return (
    normalizedHost === parsed.host.toLowerCase() ||
    (localPort === 80 && normalizedHost === parsed.hostname.toLowerCase())
  );
}

function createBackendProxy(targetUrl: URL): ProxyOptions {
  return {
    target: targetUrl.origin,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq, req) => {
        // Rewrite Origin only when it strictly matches this Vite dev origin so
        // foreign origins and missing-Origin mutations still hit Rust's 403 gate.
        const incomingOrigin = req.headers.origin;
        if (typeof incomingOrigin !== "string") {
          return;
        }
        if (
          isActiveViteDevOrigin(
            incomingOrigin,
            req.headers.host,
            req.socket.localPort,
          )
        ) {
          proxyReq.setHeader("origin", targetUrl.origin);
        }
      });
    },
  };
}

export default defineConfig(({ command }) => {
  const proxyTarget = parseLoopbackTarget(
    process.env.CPG_WEB_PROXY_TARGET ?? DEFAULT_PROXY_TARGET,
  );
  return {
    plugins: [react()],
    base: command === "build" ? "/assets/" : "/",
    build: {
      outDir: "dist",
      emptyOutDir: true,
      assetsDir: "",
      assetsInlineLimit: 0,
    },
    server: {
      host: "127.0.0.1",
      proxy: {
        "^/api(?:/|$)": createBackendProxy(proxyTarget),
        "^/assets/i18n(?:/|$)": createBackendProxy(proxyTarget),
      },
    },
  };
});
