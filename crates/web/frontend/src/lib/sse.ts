/**
 * Incremental Server-Sent Events (SSE) decoder for `fetch` response bodies.
 *
 * Implements line splitting across arbitrary UTF-8 chunk boundaries (LF, CRLF,
 * and CR), comment skipping, and `event` / `id` / `data` frame assembly.
 */

export interface SseFrame {
  readonly event: string;
  readonly id: string | null;
  readonly data: string;
}

const DEFAULT_EVENT = "message";

/**
 * Decodes an SSE `ReadableStream<Uint8Array>` incrementally and invokes
 * `onFrame` for each complete event terminated by a blank line.
 */
export async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");

  let firstChunk = true;
  let pendingCr = false;
  let lineBuffer = "";
  let eventName = DEFAULT_EVENT;
  let frameId: string | null = null;
  let dataLines: string[] = [];

  const dispatchFrame = (): void => {
    if (dataLines.length === 0) {
      eventName = DEFAULT_EVENT;
      frameId = null;
      return;
    }
    const frame: SseFrame = {
      event: eventName,
      id: frameId,
      data: dataLines.join("\n"),
    };
    eventName = DEFAULT_EVENT;
    frameId = null;
    dataLines = [];
    if (!signal?.aborted) {
      onFrame(frame);
    }
  };

  const processLine = (line: string): void => {
    if (line === "") {
      dispatchFrame();
      return;
    }
    if (line.startsWith(":")) {
      return;
    }
    const colonIndex = line.indexOf(":");
    let field: string;
    let value: string;
    if (colonIndex === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colonIndex);
      value = line.slice(colonIndex + 1);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
    }
    if (field === "event") {
      eventName = value === "" ? DEFAULT_EVENT : value;
    } else if (field === "data") {
      dataLines.push(value);
    } else if (field === "id" && !value.includes("\0")) {
      frameId = value;
    }
  };

  const consumeText = (text: string): void => {
    let start = 0;
    if (firstChunk) {
      firstChunk = false;
      if (text.startsWith("\uFEFF")) {
        start = 1;
      }
    }
    if (pendingCr) {
      pendingCr = false;
      if (start < text.length && text.charCodeAt(start) === 10) {
        start += 1;
      }
    }
    for (let i = start; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code === 10 || code === 13) {
        lineBuffer += text.slice(start, i);
        processLine(lineBuffer);
        lineBuffer = "";
        if (code === 13) {
          if (i + 1 < text.length) {
            if (text.charCodeAt(i + 1) === 10) {
              i += 1;
            }
          } else {
            // Defer LF check until the next chunk so CRLF split across chunks is one newline.
            pendingCr = true;
          }
        }
        start = i + 1;
        if (signal?.aborted) {
          return;
        }
      }
    }
    if (start < text.length) {
      lineBuffer += text.slice(start);
    }
  };

  const onAbort = (): void => {
    void reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail.length > 0) {
          consumeText(tail);
        }
        // Only a blank line terminates a frame; a truncated trailing line at EOF is discarded.
        break;
      }
      if (value && value.byteLength > 0) {
        consumeText(decoder.decode(value, { stream: true }));
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
      // Stream may already be closed or errored when aborted.
    }
    reader.releaseLock();
  }
}
