import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

const DEFAULT_PROXY_TARGET = "http://127.0.0.1:3000";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function readWorkspaceVersion(): string {
  const configDir = dirname(fileURLToPath(import.meta.url));
  const cargoTomlPath = resolve(configDir, "../../../Cargo.toml");
  const content = readFileSync(cargoTomlPath, "utf8");
  let inWorkspacePackage = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("[")) {
      inWorkspacePackage = line === "[workspace.package]";
      continue;
    }
    if (inWorkspacePackage) {
      const match = /^version\s*=\s*"([^"]+)"$/.exec(line);
      if (match?.[1]) {
        return match[1];
      }
    }
  }
  throw new Error(`Failed to read [workspace.package].version from ${cargoTomlPath}`);
}

function parseLoopbackTarget(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `CPG_WEB_PROXY_TARGET must be an http:// loopback URL (got ${raw})`,
    );
  }
  return url;
}

function hasSingleOriginHeader(req: IncomingMessage): boolean {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === "origin") {
      count += 1;
    }
  }
  return count === 1;
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
  return normalizedHost === parsed.host.toLowerCase();
}

function rejectForeignOrigin(
  req: IncomingMessage,
  res: ServerResponse | undefined,
): boolean {
  const incomingOrigin = req.headers.origin;
  if (incomingOrigin === undefined) {
    return false;
  }
  if (
    typeof incomingOrigin === "string" &&
    hasSingleOriginHeader(req) &&
    isActiveViteDevOrigin(
      incomingOrigin,
      req.headers.host,
      req.socket.localPort,
    )
  ) {
    return false;
  }
  if (res) {
    res.statusCode = 403;
    res.setHeader("Content-Security-Policy", "default-src 'self'");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.end();
  }
  return true;
}

function createBackendProxy(targetUrl: URL): ProxyOptions {
  return {
    target: targetUrl.origin,
    changeOrigin: true,
    bypass(req, res) {
      // Reject foreign Origin headers (including the backend's own origin) before
      // changeOrigin rewrites Host; leave missing Origin untouched for Rust's check.
      if (rejectForeignOrigin(req, res)) {
        return false;
      }
      return undefined;
    },
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq, req) => {
        const incomingOrigin = req.headers.origin;
        if (
          typeof incomingOrigin === "string" &&
          hasSingleOriginHeader(req) &&
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
  const appVersion = readWorkspaceVersion();
  const proxyTarget = parseLoopbackTarget(
    process.env.CPG_WEB_PROXY_TARGET ?? DEFAULT_PROXY_TARGET,
  );
  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
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
