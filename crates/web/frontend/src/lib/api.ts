/**
 * In-memory Bearer authentication and HTTP / POST-SSE client.
 *
 * Security boundary (ADR-0004): the Bearer credential lives strictly inside
 * module closure memory and is never persisted to cookies, localStorage, or
 * sessionStorage. All requests omit cookies and guard 401 invalidation by
 * session generation to avoid cross-session races.
 */

import { parseSseStream, type SseFrame } from "./sse.ts";
import type { ApiErrorPayload, Snapshot } from "./types.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type AuthEvent =
  | { readonly type: "authenticated"; readonly generation: number; readonly expiresAtMs: number }
  | { readonly type: "logged_out"; readonly generation: number }
  | { readonly type: "unauthorized"; readonly generation: number };

export interface LoginResult {
  readonly generation: number;
  readonly expiresInSecs: number;
  readonly expiresAtMs: number;
}

export interface ApiRequestOptions {
  readonly method?: HttpMethod;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface EventStreamOptions {
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly onOpen?: () => void;
  readonly onFrame: (frame: SseFrame) => void;
}

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface ApiClient {
  isAuthenticated(): boolean;
  getSessionGeneration(): number;
  getSessionExpiresAt(): number | null;
  subscribeAuth(listener: (event: AuthEvent) => void): () => void;
  onUnauthorized(listener: (generation: number) => void): () => void;
  login(accessKey: string, signal?: AbortSignal): Promise<LoginResult>;
  logout(): void;
  request<T = void>(path: string, options?: ApiRequestOptions): Promise<T>;
  checkSession(signal?: AbortSignal): Promise<void>;
  getSnapshot(signal?: AbortSignal): Promise<Snapshot>;
  openEventStream(path: string, options: EventStreamOptions): Promise<void>;
}

const MS_PER_SECOND = 1000;

export class ApiError extends Error {
  readonly status: number;
  readonly kind: string;
  readonly messageKey: string | null;
  readonly args: Readonly<Record<string, string>>;
  readonly hintKey: string | null;
  readonly actionKey: string | null;
  readonly operationId: number | null;
  readonly isUnauthorized: boolean;
  readonly isAbort: boolean;

  constructor(init: {
    status: number;
    kind: string;
    message?: string;
    messageKey?: string | null;
    args?: Readonly<Record<string, string>>;
    hintKey?: string | null;
    actionKey?: string | null;
    operationId?: number | null;
    isAbort?: boolean;
    cause?: unknown;
  }) {
    super(init.message ?? init.kind, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "ApiError";
    this.status = init.status;
    this.kind = init.kind;
    this.messageKey = init.messageKey ?? null;
    this.args = init.args ?? {};
    this.hintKey = init.hintKey ?? null;
    this.actionKey = init.actionKey ?? null;
    this.operationId = init.operationId ?? null;
    this.isUnauthorized = init.status === 401;
    this.isAbort = init.isAbort ?? false;
  }
}

function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Wraps a shared in-flight promise with a caller-local `AbortSignal` so one
 * unmounting consumer can abort its own await without cancelling the underlying request.
 */
export function attachAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  const makeAbortError = (): ApiError =>
    new ApiError({
      status: 0,
      kind: "cancelled",
      message: "request aborted",
      isAbort: true,
    });
  if (signal.aborted) {
    // Suppress unhandled rejection on the caller branch while leaving the shared promise alive.
    void promise.catch(() => {});
    return Promise.reject(makeAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(makeAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (!signal.aborted) {
          resolve(value);
        }
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (!signal.aborted) {
          reject(error);
        }
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseApiErrorPayload(raw: unknown): ApiErrorPayload | null {
  if (!isRecord(raw) || !isRecord(raw.error)) {
    return null;
  }
  const err = raw.error;
  if (typeof err.kind !== "string" || typeof err.message_key !== "string") {
    return null;
  }
  const args: Record<string, string> = {};
  if (isRecord(err.args)) {
    for (const [k, v] of Object.entries(err.args)) {
      if (typeof v === "string") {
        args[k] = v;
      }
    }
  }
  return {
    kind: err.kind,
    message_key: err.message_key,
    args,
    hint_key: typeof err.hint_key === "string" ? err.hint_key : null,
    action_key: typeof err.action_key === "string" ? err.action_key : null,
    operation_id: typeof err.operation_id === "number" ? err.operation_id : null,
  };
}

async function readErrorResponse(response: Response): Promise<ApiError> {
  if (response.status === 401) {
    return new ApiError({
      status: 401,
      kind: "auth_required",
      message: "HTTP 401",
    });
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    try {
      const payload = parseApiErrorPayload(await response.json());
      if (payload) {
        return new ApiError({
          status: response.status,
          kind: payload.kind,
          message: `HTTP ${response.status}: ${payload.kind}`,
          messageKey: payload.message_key,
          args: payload.args,
          hintKey: payload.hint_key,
          actionKey: payload.action_key,
          operationId: payload.operation_id,
        });
      }
    } catch {
      // Fall through to status-only HTTP error when body is empty or malformed.
    }
  }
  return new ApiError({
    status: response.status,
    kind: response.status === 503 ? "http_unavailable" : "http",
    message: `HTTP ${response.status}`,
  });
}

function isSnapshot(value: unknown): value is Snapshot {
  return isRecord(value) && typeof value.version === "number" && Number.isFinite(value.version);
}

/**
 * Creates an isolated in-memory Bearer API client.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
  const resolveFetch = (): typeof fetch => options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;

  // Kept strictly in closure memory so credentials cannot be read from storage or React state.
  let token: string | null = null;
  let expiresAtMs: number | null = null;
  let generation = 0;
  let authMutationSeq = 0;

  const authListeners = new Set<(event: AuthEvent) => void>();

  const emitAuth = (event: AuthEvent): void => {
    for (const listener of authListeners) {
      try {
        listener(event);
      } catch {
        // Isolate subscriber errors so every auth listener observes session transitions.
      }
    }
  };

  const buildUrl = (path: string): string => {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${baseUrl}${normalized}`;
  };

  const invalidateSession = (expectedGeneration: number): void => {
    if (expectedGeneration !== generation || token === null) {
      return;
    }
    token = null;
    expiresAtMs = null;
    generation += 1;
    emitAuth({ type: "unauthorized", generation });
  };

  const performFetch = async (
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> => {
    try {
      return await resolveFetch()(url, init);
    } catch (error) {
      if (isAbortFailure(error, signal)) {
        throw new ApiError({
          status: 0,
          kind: "cancelled",
          message: "request aborted",
          isAbort: true,
          cause: error,
        });
      }
      throw new ApiError({
        status: 0,
        kind: "http",
        message: "network request failed",
        cause: error,
      });
    }
  };

  const authorizedFetch = async (
    path: string,
    method: HttpMethod,
    accept: string,
    body: unknown,
    extraHeaders?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<{ response: Response; requestGeneration: number }> => {
    const requestToken = token;
    const requestGeneration = generation;
    if (requestToken === null) {
      throw new ApiError({
        status: 401,
        kind: "auth_required",
        message: "not authenticated",
      });
    }

    const headers = new Headers(extraHeaders);
    headers.set("Accept", accept);
    headers.set("Authorization", `Bearer ${requestToken}`);

    const init: RequestInit = {
      method,
      headers,
      credentials: "omit",
      cache: "no-store",
      signal,
    };

    if (method !== "GET") {
      // Backend Origin/CSRF middleware requires application/json on every non-safe method.
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(body === undefined ? {} : body);
    }

    const response = await performFetch(buildUrl(path), init, signal);
    if (response.status === 401) {
      invalidateSession(requestGeneration);
      throw await readErrorResponse(response);
    }
    if (!response.ok) {
      throw await readErrorResponse(response);
    }
    return { response, requestGeneration };
  };

  return {
    isAuthenticated(): boolean {
      return token !== null;
    },

    getSessionGeneration(): number {
      return generation;
    },

    getSessionExpiresAt(): number | null {
      return expiresAtMs;
    },

    subscribeAuth(listener: (event: AuthEvent) => void): () => void {
      authListeners.add(listener);
      return () => {
        authListeners.delete(listener);
      };
    },

    onUnauthorized(listener: (gen: number) => void): () => void {
      return this.subscribeAuth((event) => {
        if (event.type === "unauthorized") {
          listener(event.generation);
        }
      });
    },

    async login(accessKey: string, signal?: AbortSignal): Promise<LoginResult> {
      const attemptSeq = ++authMutationSeq;
      const response = await performFetch(
        buildUrl("/api/login"),
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ access_key: accessKey }),
          credentials: "omit",
          cache: "no-store",
          signal,
        },
        signal,
      );

      if (!response.ok) {
        throw await readErrorResponse(response);
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch (error) {
        throw new ApiError({
          status: response.status,
          kind: "parse",
          message: "invalid login response",
          cause: error,
        });
      }

      if (
        !isRecord(raw) ||
        typeof raw.token !== "string" ||
        raw.token.length === 0 ||
        typeof raw.expires_in !== "number" ||
        !Number.isFinite(raw.expires_in) ||
        raw.expires_in <= 0
      ) {
        throw new ApiError({
          status: response.status,
          kind: "parse",
          message: "invalid login credential payload",
        });
      }

      if (attemptSeq !== authMutationSeq) {
        throw new ApiError({
          status: 0,
          kind: "cancelled",
          message: "login superseded",
          isAbort: true,
        });
      }

      const nextExpiresAtMs = now() + raw.expires_in * MS_PER_SECOND;
      token = raw.token;
      expiresAtMs = nextExpiresAtMs;
      generation += 1;
      const currentGen = generation;
      emitAuth({
        type: "authenticated",
        generation: currentGen,
        expiresAtMs: nextExpiresAtMs,
      });
      return {
        generation: currentGen,
        expiresInSecs: raw.expires_in,
        expiresAtMs: nextExpiresAtMs,
      };
    },

    logout(): void {
      authMutationSeq += 1;
      const hadToken = token !== null;
      token = null;
      expiresAtMs = null;
      generation += 1;
      if (hadToken) {
        emitAuth({ type: "logged_out", generation });
      }
    },

    async request<T = void>(path: string, reqOptions: ApiRequestOptions = {}): Promise<T> {
      const method = reqOptions.method ?? "GET";
      const { response } = await authorizedFetch(
        path,
        method,
        "application/json",
        reqOptions.body,
        reqOptions.headers,
        reqOptions.signal,
      );
      if (response.status === 204) {
        return undefined as T;
      }
      const text = await response.text();
      if (text.trim().length === 0) {
        return undefined as T;
      }
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new ApiError({
          status: response.status,
          kind: "parse",
          message: "invalid JSON response",
          cause: error,
        });
      }
    },

    async checkSession(signal?: AbortSignal): Promise<void> {
      await this.request("/api/session", { method: "GET", signal });
    },

    async getSnapshot(signal?: AbortSignal): Promise<Snapshot> {
      const payload = await this.request<unknown>("/api/snapshot", { method: "GET", signal });
      if (!isSnapshot(payload)) {
        throw new ApiError({
          status: 200,
          kind: "parse",
          message: "invalid snapshot payload",
        });
      }
      return payload;
    },

    async openEventStream(path: string, streamOptions: EventStreamOptions): Promise<void> {
      const streamAbort = new AbortController();
      const onExternalAbort = (): void => {
        streamAbort.abort();
      };
      if (streamOptions.signal) {
        if (streamOptions.signal.aborted) {
          streamAbort.abort();
        } else {
          streamOptions.signal.addEventListener("abort", onExternalAbort, { once: true });
        }
      }

      const initialGeneration = generation;
      const unsubscribeStreamAuth = this.subscribeAuth((event) => {
        if (event.generation !== initialGeneration) {
          streamAbort.abort();
        }
      });

      try {
        const { response, requestGeneration } = await authorizedFetch(
          path,
          "POST",
          "text/event-stream",
          streamOptions.body,
          undefined,
          streamAbort.signal,
        );

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("text/event-stream") || !response.body) {
          try {
            await response.body?.cancel();
          } catch {
            // Ignore stream cleanup failures on unexpected content types.
          }
          throw new ApiError({
            status: response.status,
            kind: "parse",
            message: "expected text/event-stream response",
          });
        }

        if (requestGeneration !== generation || streamAbort.signal.aborted) {
          try {
            await response.body.cancel();
          } catch {
            // Ignore stream cleanup failures on superseded sessions.
          }
          return;
        }

        streamOptions.onOpen?.();

        await parseSseStream(response.body, streamOptions.onFrame, streamAbort.signal);
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }
        if (isAbortFailure(error, streamOptions.signal) || streamAbort.signal.aborted) {
          throw new ApiError({
            status: 0,
            kind: "cancelled",
            message: "event stream aborted",
            isAbort: true,
            cause: error,
          });
        }
        throw new ApiError({
          status: 0,
          kind: "connection_lost",
          message: "event stream interrupted",
          cause: error,
        });
      } finally {
        unsubscribeStreamAuth();
        streamOptions.signal?.removeEventListener("abort", onExternalAbort);
      }
    },
  };
}

/** Shared browser-session API client instance. */
export const apiClient: ApiClient = createApiClient();
