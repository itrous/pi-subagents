// C4 probe extension: reports what a path-loaded extension's tool sees in an in-process child session.
const BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";
const REGISTRY = Symbol.for("c4.sessionBindings"); // alternative: host-owned Map<sessionId, bindings>
let instanceSeq = ((globalThis as any).__c4ProbeInstances = ((globalThis as any).__c4ProbeInstances ?? 0) + 1);

export default function (pi: any) {
  const factoryEnvBindings = process.env[BINDINGS_ENV] ?? null; // captured inside the load window
  const factoryProcessCwd = process.cwd();
  pi.registerTool({
    name: "probe",
    label: "probe",
    description: "report cwd and bindings",
    parameters: { type: "object", properties: {} },
    async execute(_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: any) {
      const startedAt = Date.now();
      await new Promise((r) => setTimeout(r, 400)); // force overlap between parallel sessions
      const sessionId = ctx.sessionManager.getSessionId();
      const registry: Map<string, unknown> | undefined = (globalThis as any)[REGISTRY];
      const report = {
        instance: instanceSeq,
        sessionId,
        ctxCwd: ctx.cwd,
        processCwd: process.cwd(),
        factoryProcessCwd,
        bindingsFactoryEnv: factoryEnvBindings,
        bindingsCallEnv: process.env[BINDINGS_ENV] ?? null,
        bindingsBySessionId: registry?.get(sessionId) ?? null,
        startedAt,
        endedAt: Date.now(),
      };
      return { content: [{ type: "text", text: "PROBE" + JSON.stringify(report) }], details: report };
    },
  });
}
