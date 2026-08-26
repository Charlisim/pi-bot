import { randomUUID } from "node:crypto";

const REQUEST_EVENT = "subagents:rpc:v1:request";
const READY_EVENT = "subagents:rpc:v1:ready";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";
const COMPLETE_EVENT = "subagent:async-complete";

export interface EventBus {
  on(event: string, handler: (data: unknown) => void): unknown;
  emit(event: string, data: unknown): void;
}

interface RpcSuccess {
  version: 1;
  requestId: string;
  success: true;
  data: unknown;
}

interface RpcFailure {
  version: 1;
  requestId: string;
  success: false;
  error: { code: string; message: string };
}

type RpcReply = RpcSuccess | RpcFailure;

class SubagentsRpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SubagentsRpcError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseReply(value: unknown, requestId: string): RpcReply {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.requestId !== requestId ||
    typeof value.success !== "boolean"
  ) {
    throw new Error("pi-subagents returned an invalid RPC response.");
  }
  if (value.success) return value as unknown as RpcSuccess;
  if (
    !isRecord(value.error) ||
    typeof value.error.message !== "string" ||
    typeof value.error.code !== "string"
  ) {
    throw new Error("pi-subagents returned an invalid RPC error.");
  }
  return value as unknown as RpcFailure;
}

function textFromData(data: unknown): string {
  if (!isRecord(data) || typeof data.text !== "string")
    throw new Error("pi-subagents did not return run details.");
  return data.text;
}

function runIdFromData(data: unknown): string {
  if (!isRecord(data))
    throw new Error("pi-subagents did not return launch details.");
  const details = isRecord(data.details) ? data.details : undefined;
  const runId = details?.runId ?? details?.asyncId;
  if (typeof runId !== "string" || runId.length === 0)
    throw new Error("pi-subagents did not return a run ID.");
  return runId;
}

export interface CompletionEvent {
  runId: string;
  status: "completed" | "failed" | "paused" | "stopped";
  output?: string;
  error?: string;
}

type RpcMethod = "ping" | "resume" | "spawn" | "status" | "stop";

function normalizeRunState(
  state: unknown,
): CompletionEvent["status"] | "launched" | undefined {
  if (state === "complete" || state === "completed") return "completed";
  if (state === "failed" || state === "paused" || state === "stopped")
    return state;
  if (state === "running" || state === "queued") return "launched";
  return undefined;
}

function runStatusesFromData(
  data: unknown,
): Map<string, CompletionEvent["status"] | "launched"> {
  const statuses = new Map<string, CompletionEvent["status"] | "launched">();
  if (
    !isRecord(data) ||
    !isRecord(data.asyncSnapshot) ||
    !Array.isArray(data.asyncSnapshot.runs)
  )
    return statuses;
  for (const candidate of data.asyncSnapshot.runs) {
    if (!isRecord(candidate) || typeof candidate.id !== "string") continue;
    const status = normalizeRunState(candidate.state);
    if (status) statuses.set(candidate.id, status);
  }
  return statuses;
}

export class SubagentsClient {
  private ready = false;
  private closed = false;
  private readonly events: EventBus;
  private readonly disposers: Array<() => void> = [];
  private readonly pendingRejectors = new Set<(error: Error) => void>();
  private readonly completionHandlers = new Set<
    (event: CompletionEvent) => void
  >();

  constructor(events: EventBus) {
    this.events = events;
    this.subscribe(READY_EVENT, () => {
      this.ready = true;
    });
    this.subscribe(COMPLETE_EVENT, (payload) => {
      const event = this.parseCompletion(payload);
      if (event) for (const handler of this.completionHandlers) handler(event);
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  onCompletion(handler: (event: CompletionEvent) => void): () => void {
    this.completionHandlers.add(handler);
    return () => this.completionHandlers.delete(handler);
  }

  async probe(timeoutMs = 750): Promise<boolean> {
    try {
      await this.request("ping", {}, timeoutMs);
      this.ready = true;
    } catch {
      this.ready = false;
    }
    return this.ready;
  }

  async spawn(
    input: { agent: string; task: string; cwd: string; output?: string },
    timeoutMs = 10_000,
  ): Promise<string> {
    const data = await this.request(
      "spawn",
      {
        agent: input.agent,
        task: input.task,
        cwd: input.cwd,
        context: "fresh",
        agentScope: "user",
        async: true,
        ...(input.output
          ? { output: input.output, outputMode: "file-only" }
          : {}),
      },
      timeoutMs,
    );
    this.ready = true;
    return runIdFromData(data);
  }

  async statuses(
    timeoutMs = 5_000,
  ): Promise<Map<string, CompletionEvent["status"] | "launched">> {
    const data = await this.request("status", {}, timeoutMs);
    return runStatusesFromData(data);
  }

  async inspect(runId: string, timeoutMs = 5_000): Promise<string> {
    return textFromData(await this.request("status", { id: runId }, timeoutMs));
  }

  async resumeAvailable(runId: string, timeoutMs = 5_000): Promise<boolean> {
    try {
      const status = await this.inspect(runId, timeoutMs);
      return !(
        /^\s*State:\s*(stopped|rejected)\b/im.test(status) ||
        /^\s*Resume:\s*unavailable\b/im.test(status)
      );
    } catch (error) {
      if (
        error instanceof SubagentsRpcError &&
        /\bnot found\b/i.test(error.message)
      )
        return false;
      throw error;
    }
  }

  async resume(
    runId: string,
    message: string,
    output?: string,
    timeoutMs = 10_000,
  ): Promise<string> {
    return runIdFromData(
      await this.request(
        "resume",
        {
          id: runId,
          message,
          ...(output ? { output, outputMode: "file-only" } : {}),
        },
        timeoutMs,
      ),
    );
  }

  async stop(runId: string, timeoutMs = 5_000): Promise<void> {
    await this.request("stop", { id: runId }, timeoutMs);
  }

  dispose(): void {
    this.closed = true;
    for (const reject of [...this.pendingRejectors])
      reject(new Error("Pi Bot session closed before pi-subagents replied."));
    for (const dispose of this.disposers.splice(0)) dispose();
    this.completionHandlers.clear();
  }

  private subscribe(event: string, handler: (data: unknown) => void): void {
    const dispose = this.events.on(event, handler);
    if (typeof dispose === "function")
      this.disposers.push(dispose as () => void);
  }

  private request(
    method: RpcMethod,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error("Pi Bot session is closed."));
    const requestId = randomUUID();
    const replyEvent = `${REPLY_PREFIX}${requestId}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      let timer: NodeJS.Timeout | undefined;
      const rejectOnDispose = (error: Error) => finish(() => reject(error));
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe?.();
        this.pendingRejectors.delete(rejectOnDispose);
        callback();
      };
      const listener = (payload: unknown) => {
        try {
          const reply = parseReply(payload, requestId);
          if (reply.success) finish(() => resolve(reply.data));
          else
            finish(() =>
              reject(
                new SubagentsRpcError(reply.error.code, reply.error.message),
              ),
            );
        } catch (error) {
          finish(() => reject(error));
        }
      };
      const registered = this.events.on(replyEvent, listener);
      if (typeof registered === "function")
        unsubscribe = registered as () => void;
      this.pendingRejectors.add(rejectOnDispose);
      timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new Error(
                "pi-subagents is not available. Install it as a Pi package and run /reload.",
              ),
            ),
          ),
        timeoutMs,
      );
      timer.unref?.();
      this.events.emit(REQUEST_EVENT, {
        version: 1,
        requestId,
        method,
        params,
        source: { extension: "pi-bot" },
      });
    });
  }

  private parseCompletion(payload: unknown): CompletionEvent | undefined {
    if (!isRecord(payload)) return undefined;
    const runId = payload.runId ?? payload.id;
    const rawState = payload.state ?? payload.status;
    if (typeof runId !== "string") return undefined;
    const status =
      rawState === "complete" || rawState === "completed"
        ? "completed"
        : rawState === "failed"
          ? "failed"
          : rawState === "paused"
            ? "paused"
            : rawState === "stopped"
              ? "stopped"
              : undefined;
    if (!status) return undefined;
    const child =
      Array.isArray(payload.results) && isRecord(payload.results[0])
        ? payload.results[0]
        : undefined;
    const outputValue = child?.output ?? payload.output ?? payload.summary;
    const errorValue = child?.error ?? payload.error;
    const output =
      typeof outputValue === "string" && outputValue.trim()
        ? outputValue
            .trim()
            .replaceAll("\0", "�")
            .slice(0, 64 * 1_024)
        : undefined;
    const error =
      typeof errorValue === "string" && errorValue.trim()
        ? errorValue.trim().replaceAll("\0", "�").slice(0, 8_192)
        : undefined;
    return {
      runId,
      status,
      ...(output ? { output } : {}),
      ...(error ? { error } : {}),
    };
  }
}
