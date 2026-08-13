import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerSlashSubagentBridge } from "../../src/slash/slash-bridge.ts";

const REQUEST = "subagent:slash:request";
const STARTED = "subagent:slash:started";
const RESPONSE = "subagent:slash:response";

function eventBus() {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    on(event: string, handler: (data: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    },
    emit(event: string, data: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(data);
    },
  };
}

describe("slash subagent bridge requester context", () => {
  it("is passive before activation even with an explicit request context", async () => {
    const events = eventBus();
    let executeCalls = 0;
    let responses = 0;
    const bridge = registerSlashSubagentBridge({
      events,
      getContext: () => null,
      execute: async () => { executeCalls++; return { content: [], details: { mode: "management", results: [] } } as any; },
    });
    events.on(RESPONSE, () => { responses++; });
    events.emit(REQUEST, { requestId: "passive", params: { action: "list" }, ctx: { cwd: "/explicit" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executeCalls, 0);
    assert.equal(responses, 0);
    bridge.dispose();
  });

  it("does not dispatch after a reentrant stop from the started listener", async () => {
    const events = eventBus();
    let executeCalls = 0;
    const bridge = registerSlashSubagentBridge({
      events,
      getContext: () => ({ cwd: "/repo" }) as any,
      execute: async () => { executeCalls++; return { content: [], details: { mode: "management", results: [] } } as any; },
    });
    bridge.activate();
    events.on(STARTED, () => bridge.stop());
    events.emit(REQUEST, { requestId: "reentrant", params: { action: "list" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executeCalls, 0);
    bridge.dispose();
  });

  it("keeps the accepted controller when the request id is retransmitted", async () => {
    const events = eventBus();
    let settle!: (value: any) => void;
    let executeCalls = 0;
    const bridge = registerSlashSubagentBridge({
      events,
      getContext: () => ({ cwd: "/repo" }) as any,
      execute: async () => {
        executeCalls++;
        return await new Promise((resolve) => { settle = resolve; });
      },
    });
    bridge.activate();
    const responses: unknown[] = [];
    events.on(RESPONSE, (value) => responses.push(value));
    const payload = { requestId: "same", params: { action: "list" } };
    events.emit(REQUEST, payload);
    events.emit(REQUEST, payload);
    assert.equal(executeCalls, 1);
    settle({ content: [], details: { mode: "management", results: [] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(responses.length, 1);
    bridge.dispose();
  });

  it("uses request ctx instead of stale fallback context when provided", async () => {
    const events = eventBus();
    const fallbackCtx = { cwd: "/fallback" } as any;
    const requestCtx = { cwd: "/request" } as any;
    let executedCtx: any;

    const bridge = registerSlashSubagentBridge({
      events,
      getContext: () => fallbackCtx,
      execute: async (_id, _params, _signal, _onUpdate, ctx) => {
        executedCtx = ctx;
        return { content: [{ type: "text", text: "ok" }], details: { mode: "single", results: [] } } as any;
      },
    });
    bridge.activate();

    const done = new Promise<void>((resolve, reject) => {
      events.on(RESPONSE, (data: any) => {
        try {
          assert.equal(data.isError, false);
          assert.equal(executedCtx, requestCtx);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    events.emit(REQUEST, { requestId: "ctx-test", params: { action: "list" }, ctx: requestCtx });
    await done;
  });

  it("rejects direct execution inputs before executor dispatch", async () => {
    const events = eventBus();
    let executeCalls = 0;
    const bridge = registerSlashSubagentBridge({
      events,
      getContext: () => ({ cwd: "/repo" }) as any,
      execute: async () => {
        executeCalls++;
        return { content: [{ type: "text", text: "unexpected" }], details: { mode: "single", results: [] } } as any;
      },
    });
    bridge.activate();

    const done = new Promise<void>((resolve, reject) => {
      events.on(RESPONSE, (data: any) => {
        try {
          assert.equal(data.isError, true);
          assert.match(data.errorText, /Direct execution was removed/);
          assert.equal(executeCalls, 0);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    events.emit(REQUEST, { requestId: "legacy-single", params: { agent: "worker", task: "work" } });
    await done;
  });

  it("rejects removed chain and parallel inputs before executor dispatch", async () => {
    const events = eventBus();
    let executeCalls = 0;
    const bridge = registerSlashSubagentBridge({
      events,
      getContext: () => ({ cwd: "/repo" }) as any,
      execute: async () => {
        executeCalls++;
        return { content: [{ type: "text", text: "unexpected" }], details: { mode: "single", results: [] } } as any;
      },
    });
    bridge.activate();

    const done = new Promise<void>((resolve, reject) => {
      events.on(RESPONSE, (data: any) => {
        try {
          assert.equal(data.isError, true);
          assert.match(data.errorText, /removed.*workflowScript/i);
          assert.equal(executeCalls, 0);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    events.emit(REQUEST, { requestId: "legacy-parallel", params: { tasks: [{ agent: "worker", task: "work" }] } });
    await done;
  });
});
