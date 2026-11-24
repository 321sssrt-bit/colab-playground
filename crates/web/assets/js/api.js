// Strictly in-memory Bearer token: never written to cookies, localStorage, or sessionStorage.
let bearerToken = null;
let unauthorizedHandler = null;

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

export function hasToken() {
  return bearerToken !== null;
}

export function clearToken() {
  bearerToken = null;
}

export async function login(accessKey) {
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ access_key: accessKey }),
  });
  if (response.ok) {
    const data = await response.json();
    bearerToken = data.token;
    return { ok: true, status: response.status, expiresIn: data.expires_in };
  }
  return { ok: false, status: response.status };
}

export class ApiError extends Error {
  constructor(status, payload) {
    super(`HTTP ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

export async function apiRequest(path, { method = "GET", body = undefined, signal = undefined } = {}) {
  const headers = { Accept: "application/json" };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  const init = { method, headers, signal };
  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body === undefined ? {} : body);
  }
  const response = await fetch(path, init);
  if (response.status === 401) {
    bearerToken = null;
    if (unauthorizedHandler) {
      unauthorizedHandler();
    }
    throw new ApiError(401, null);
  }
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    throw new ApiError(response.status, payload);
  }
  return payload;
}

// Consumes Server-Sent Events via authenticated JSON POST fetch (never browser cookies).
export async function streamSse(path, body, { onEvent, onOpen, signal } = {}) {
  const headers = {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  let response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body === undefined ? {} : body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) {
      return { outcome: "aborted" };
    }
    return { outcome: "network_error", error: err };
  }

  if (response.status === 401) {
    bearerToken = null;
    if (unauthorizedHandler) {
      unauthorizedHandler();
    }
    return { outcome: "unauthorized" };
  }
  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { outcome: "http_error", status: response.status, payload };
  }
  if (!response.body) {
    return { outcome: "closed" };
  }

  if (onOpen) {
    onOpen();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventName = "message";
  let eventId = null;
  let dataLines = [];

  const flushEvent = () => {
    if (dataLines.length === 0) {
      eventName = "message";
      eventId = null;
      return;
    }
    const raw = dataLines.join("\n");
    let data = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // Non-JSON payload stays raw string.
    }
    if (onEvent) {
      onEvent({ event: eventName, id: eventId, data });
    }
    eventName = "message";
    eventId = null;
    dataLines = [];
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          flushEvent();
          continue;
        }
        if (line.startsWith(":")) {
          continue;
        }
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let fieldValue = colon === -1 ? "" : line.slice(colon + 1);
        if (fieldValue.startsWith(" ")) {
          fieldValue = fieldValue.slice(1);
        }
        if (field === "event") {
          eventName = fieldValue || "message";
        } else if (field === "id") {
          eventId = fieldValue;
        } else if (field === "data") {
          dataLines.push(fieldValue);
        }
      }
    }
    flushEvent();
    return { outcome: "closed" };
  } catch (err) {
    if (signal?.aborted) {
      return { outcome: "aborted" };
    }
    return { outcome: "network_error", error: err };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader already released.
    }
  }
}
