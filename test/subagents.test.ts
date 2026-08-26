import assert from "node:assert/strict";
import test from "node:test";
import { type EventBus, SubagentsClient } from "../src/subagents.ts";

class FakeEvents implements EventBus {
  handlers = new Map<string, Set<(data: unknown) => void>>();
  emitted: Array<{ event: string; data: unknown }> = [];

  on(event: string, handler: (data: unknown) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }

  emit(event: string, data: unknown): void {
    this.emitted.push({ event, data });
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }
}

test("spawn subscribes before emitting and returns the durable run ID", async () => {
  const events = new FakeEvents();
  const client = new SubagentsClient(events);
  events.on("subagents:rpc:v1:request", (value) => {
    const request = value as {
      requestId: string;
      method: string;
      params: Record<string, unknown>;
    };
    assert.equal(request.method, "spawn");
    assert.equal(request.params.async, true);
    assert.equal(request.params.context, "fresh");
    assert.equal(request.params.agentScope, "user");
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
      data: { text: "started", details: { asyncId: "run-123" } },
    });
  });
  assert.equal(
    await client.spawn({ agent: "atlas", task: "Review", cwd: "/repo" }),
    "run-123",
  );
  client.dispose();
});

test("RPC errors are preserved", async () => {
  const events = new FakeEvents();
  const client = new SubagentsClient(events);
  events.on("subagents:rpc:v1:request", (value) => {
    const request = value as { requestId: string };
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: false,
      error: { code: "invalid_params", message: "Unknown agent" },
    });
  });
  await assert.rejects(
    client.spawn({ agent: "missing", task: "Review", cwd: "/repo" }),
    /invalid_params: Unknown agent/,
  );
  client.dispose();
});

test("status reconciliation uses the public async snapshot", async () => {
  const events = new FakeEvents();
  const client = new SubagentsClient(events);
  events.on("subagents:rpc:v1:request", (value) => {
    const request = value as { requestId: string; method: string };
    if (request.method !== "status") return;
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
      data: {
        asyncSnapshot: {
          runs: [
            { id: "run-1", state: "complete" },
            { id: "run-2", state: "running" },
          ],
        },
      },
    });
  });
  assert.deepEqual(
    [...(await client.statuses())],
    [
      ["run-1", "completed"],
      ["run-2", "launched"],
    ],
  );
  client.dispose();
});

test("completion events correlate by run ID and tolerate extra fields", () => {
  const events = new FakeEvents();
  const client = new SubagentsClient(events);
  const completed: unknown[] = [];
  client.onCompletion((event) => completed.push(event));
  events.emit("subagent:async-complete", {
    id: "run-7",
    state: "complete",
    extra: true,
  });
  events.emit("subagent:async-complete", { runId: "run-8", state: "running" });
  assert.deepEqual(completed, [{ runId: "run-7", status: "completed" }]);
  client.dispose();
});

test("session shutdown rejects pending RPC requests", async () => {
  const client = new SubagentsClient(new FakeEvents());
  const pending = client.spawn(
    { agent: "atlas", task: "Review", cwd: "/repo" },
    1_000,
  );
  client.dispose();
  await assert.rejects(pending, /session closed/);
});

test("probe fails closed when pi-subagents is absent", async () => {
  const client = new SubagentsClient(new FakeEvents());
  assert.equal(await client.probe(5), false);
  client.dispose();
});
