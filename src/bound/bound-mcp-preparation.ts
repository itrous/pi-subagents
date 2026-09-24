import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import { canonicalSha256 } from "../shared/canonical-json.ts";
import type { BoundMcpConfigContractV2 } from "./bound-mcp-config.ts";
import type { BoundMcpDeclarationV1, BoundMcpDiscovery } from "./bound-mcp-direct-bridge.ts";
import type { BoundMcpSelectionsHandle } from "./bound-mcp-selections.ts";
import { BOUND_RFC4122_UUID } from "./bound-request.ts";

export const BOUND_MCP_PREPARATION_VERSION = 1 as const;
/** A ticket is usable this long after discovery finished (D2). */
export const BOUND_MCP_TICKET_TTL_MS = 30_000;
/** Live preparation records per server generation (D2); overflow never evicts a live neighbour. */
export const BOUND_MCP_PREPARATION_CAPACITY = 32;

const HEX_64 = /^[0-9a-f]{64}$/u;
const TICKET = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** `mcpSnapshot` of the D4 registry. */
export interface BoundMcpSnapshotV1 {
	requestBaseDigest: string;
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	prospectiveRunId: string;
	serverInstanceId: string;
	sourceIdentityDigest: string;
	activeSessionDigest: string;
	canonicalCwd: string;
	sourcePathDigest: string;
	contentDigest: string;
	effectiveDigest: string;
	packageEvidenceDigest: string;
	selectors: string[];
	declarations: BoundMcpDeclarationV1[];
}

/** `mcpPreparationReply` of D4. */
export interface BoundMcpPreparationReplyV1 {
	version: typeof BOUND_MCP_PREPARATION_VERSION;
	ticket: string;
	snapshot: BoundMcpSnapshotV1;
	snapshotDigest: string;
	/** Wall-clock milliseconds, informational; the producer decides expiry on its monotonic clock. */
	expiresAt: number;
}

export type BoundMcpReleaseStatus = "released" | "absent" | "admitted";

export interface BoundMcpReleaseParamsV1 {
	version: typeof BOUND_MCP_PREPARATION_VERSION;
	targetServerInstanceId: string;
	activeSessionDigest: string;
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	ticket: string;
}

export interface BoundMcpPreparationParamsV1 {
	version: typeof BOUND_MCP_PREPARATION_VERSION;
	targetServerInstanceId: string;
	request: unknown;
}

type PreparationState = "prepared" | "admitted" | "released" | "expired";
// "released" and "expired" stay in the map only while their close did not
// finish: they keep counting against the capacity (their connections may be
// open), and a repeated release retries the close instead of answering
// `released`/`absent` for connections nobody closed.

/**
 * One producer-owned preparation (D2): the immutable snapshot, the live
 * discovery it was measured from, and who owns the connections. The ticket is a
 * random handle to this record, not a client-held proof.
 */
export interface BoundMcpPreparation {
	readonly ticket: string;
	readonly requestId: string;
	readonly ownerRunId: string;
	readonly nodeId: string;
	readonly prospectiveRunId: string;
	readonly serverInstanceId: string;
	readonly sourceIdentityDigest: string;
	readonly activeSessionDigest: string;
	readonly configPath: string;
	readonly config: Readonly<Record<string, unknown>>;
	readonly snapshot: Readonly<BoundMcpSnapshotV1>;
	readonly snapshotDigest: string;
	readonly contract: Readonly<BoundMcpConfigContractV2>;
	readonly discovery: BoundMcpDiscovery;
	readonly selections: BoundMcpSelectionsHandle;
	readonly expiresAt: number;
	/** Bounded close of the connections: a finished close is final, an unfinished one may be retried; after admission the run calls it. */
	close(): Promise<"closed" | "timeout" | "failed">;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function ownData(value: Record<string, unknown>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && "value" in descriptor && descriptor.enumerable ? descriptor.value : undefined;
}

function identity(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\r\n]/u.test(value);
}

function closedKeys(value: Record<string, unknown>, keys: string): boolean {
	const own = Reflect.ownKeys(value);
	return own.every((key) => typeof key === "string") && [...own as string[]].sort().join(",") === keys
		&& own.every((key) => { const descriptor = Object.getOwnPropertyDescriptor(value, key)!; return "value" in descriptor && descriptor.enumerable; });
}

/** Descriptor-safe routing key of both new methods. */
export function boundMcpParamsTarget(params: unknown): string | undefined {
	if (!plainRecord(params)) return undefined;
	const target = ownData(params, "targetServerInstanceId");
	return typeof target === "string" && BOUND_RFC4122_UUID.test(target) ? target : undefined;
}

export function parseBoundMcpPreparationParams(params: unknown): BoundMcpPreparationParamsV1 | undefined {
	if (!plainRecord(params) || !closedKeys(params, "request,targetServerInstanceId,version")) return undefined;
	const target = ownData(params, "targetServerInstanceId");
	if (ownData(params, "version") !== BOUND_MCP_PREPARATION_VERSION || typeof target !== "string" || !BOUND_RFC4122_UUID.test(target)) return undefined;
	return { version: BOUND_MCP_PREPARATION_VERSION, targetServerInstanceId: target, request: ownData(params, "request") };
}

export function parseBoundMcpReleaseParams(params: unknown): BoundMcpReleaseParamsV1 | undefined {
	if (!plainRecord(params) || !closedKeys(params, "activeSessionDigest,nodeId,ownerRunId,requestId,targetServerInstanceId,ticket,version")) return undefined;
	const read = (key: string) => ownData(params, key);
	const target = read("targetServerInstanceId"); const session = read("activeSessionDigest"); const ticket = read("ticket");
	const requestId = read("requestId"); const ownerRunId = read("ownerRunId"); const nodeId = read("nodeId");
	if (read("version") !== BOUND_MCP_PREPARATION_VERSION || typeof target !== "string" || !BOUND_RFC4122_UUID.test(target)
		|| typeof session !== "string" || !HEX_64.test(session) || typeof ticket !== "string" || !TICKET.test(ticket)
		|| !identity(requestId) || !identity(ownerRunId) || !identity(nodeId)) return undefined;
	return { version: BOUND_MCP_PREPARATION_VERSION, targetServerInstanceId: target, activeSessionDigest: session, requestId, ownerRunId, nodeId, ticket };
}

export function boundMcpSnapshotDigest(snapshot: BoundMcpSnapshotV1): string {
	return canonicalSha256(snapshot);
}

interface Entry {
	preparation: BoundMcpPreparation;
	state: PreparationState;
	expiresAtMono: number;
	timer: ReturnType<typeof setTimeout> | undefined;
}

export interface BoundMcpPreparationRegistryOptions {
	clock?: () => number;
	ttlMs?: number;
	capacity?: number;
}

/**
 * Generation-scoped preparation records (D2). Ownership moves exactly once:
 * a release that wins closes the preparation and admission refuses; an
 * admission that wins moves the connections into the run and a later release
 * answers `admitted` without touching the run. Both transitions are
 * synchronous, so no interleaving can give ownership twice.
 */
export class BoundMcpPreparationRegistry {
	private readonly entries = new Map<string, Entry>();
	private reserved = 0;
	private disposed = false;
	private readonly clock: () => number;
	private readonly ttlMs: number;
	private readonly capacity: number;

	constructor(options: BoundMcpPreparationRegistryOptions = {}) {
		this.clock = options.clock ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
		this.ttlMs = options.ttlMs ?? BOUND_MCP_TICKET_TTL_MS;
		this.capacity = options.capacity ?? BOUND_MCP_PREPARATION_CAPACITY;
	}

	/** A slot for one discovery; false at capacity (`mcp_discovery_capacity`). */
	reserve(): boolean {
		if (this.disposed || this.live() + this.reserved >= this.capacity) return false;
		this.reserved++;
		return true;
	}

	unreserve(): void {
		if (this.reserved > 0) this.reserved--;
	}

	now(): number {
		return this.clock();
	}

	ttl(): number {
		return this.ttlMs;
	}

	newTicket(): string {
		return randomUUID();
	}

	/** The caller released its reservation just before, in the same tick. False (and the caller closes) after dispose. */
	add(preparation: BoundMcpPreparation, expiresAtMono: number): boolean {
		if (this.disposed || this.entries.has(preparation.ticket)) return false;
		const entry: Entry = { preparation, state: "prepared", expiresAtMono, timer: undefined };
		const delay = Math.max(0, expiresAtMono - this.clock());
		entry.timer = setTimeout(() => this.expire(preparation.ticket), delay);
		entry.timer.unref?.();
		this.entries.set(preparation.ticket, entry);
		return true;
	}

	/** Every kept record may hold open connections: prepared, admitted, and released or expired ones whose close did not finish. */
	private live(): number {
		return this.entries.size;
	}

	private expire(ticket: string): void {
		const entry = this.entries.get(ticket);
		if (!entry || entry.state !== "prepared") return;
		entry.state = "expired";
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = undefined;
		void this.closeKept(ticket, entry);
	}

	/** Close, and forget the record only once the close finished. */
	private async closeKept(ticket: string, entry: Entry): Promise<boolean> {
		let closed: "closed" | "timeout" | "failed";
		try { closed = await entry.preparation.close(); } catch { closed = "failed"; }
		if (closed !== "closed") return false;
		if (this.entries.get(ticket) === entry) this.entries.delete(ticket);
		return true;
	}

	/**
	 * The prepared, unexpired record for this ticket, or undefined. Expiry is
	 * decided on the monotonic clock here too, not only by the timer.
	 */
	prepared(ticket: string): BoundMcpPreparation | undefined {
		const entry = this.entries.get(ticket);
		if (!entry || entry.state !== "prepared") return undefined;
		if (this.clock() >= entry.expiresAtMono) { this.expire(ticket); return undefined; }
		return entry.preparation;
	}

	/** Atomic ownership transfer into a run: exactly once, only while prepared and unexpired. */
	claim(ticket: string, expected: BoundMcpPreparation): boolean {
		const entry = this.entries.get(ticket);
		if (!entry || entry.preparation !== expected || entry.state !== "prepared") return false;
		if (this.clock() >= entry.expiresAtMono) { this.expire(ticket); return false; }
		entry.state = "admitted";
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = undefined;
		return true;
	}

	/**
	 * `releaseMcp` (D4): `released` only after the owned preparation actually
	 * closed; `absent` for an unknown, expired or already released ticket;
	 * `admitted` when a run owns it. Another tuple or session never gets
	 * ownership; a cleanup that did not finish is an error, not `released`.
	 */
	async release(params: BoundMcpReleaseParamsV1): Promise<{ ok: true; status: BoundMcpReleaseStatus } | { ok: false; code: "invalid_request" | "mcp_release_failed" }> {
		const entry = this.entries.get(params.ticket);
		if (!entry) return { ok: true, status: "absent" };
		const preparation = entry.preparation;
		if (preparation.requestId !== params.requestId || preparation.ownerRunId !== params.ownerRunId || preparation.nodeId !== params.nodeId
			|| preparation.activeSessionDigest !== params.activeSessionDigest || preparation.serverInstanceId !== params.targetServerInstanceId) return { ok: false, code: "invalid_request" };
		if (entry.state === "admitted") return { ok: true, status: "admitted" };
		if (entry.state === "released") return this.closeReleased(params.ticket, entry);
		// An expired ticket is `absent` only once its connections are closed.
		if (entry.state === "expired") return await this.closeKept(params.ticket, entry) ? { ok: true, status: "absent" } : { ok: false, code: "mcp_release_failed" };
		// Expiry is decided on the monotonic clock, not only by the timer.
		if (this.clock() >= entry.expiresAtMono) {
			entry.state = "expired";
			if (entry.timer) clearTimeout(entry.timer);
			entry.timer = undefined;
			return await this.closeKept(params.ticket, entry) ? { ok: true, status: "absent" } : { ok: false, code: "mcp_release_failed" };
		}
		entry.state = "released";
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = undefined;
		return this.closeReleased(params.ticket, entry);
	}

	private async closeReleased(ticket: string, entry: Entry): Promise<{ ok: true; status: "released" } | { ok: false; code: "mcp_release_failed" }> {
		return await this.closeKept(ticket, entry) ? { ok: true, status: "released" } : { ok: false, code: "mcp_release_failed" };
	}

	/** After admission the record is only a marker that answers `admitted`; the run closes its connections. */
	forget(ticket: string): void {
		const entry = this.entries.get(ticket);
		if (entry && entry.state === "admitted") this.entries.delete(ticket);
	}

	/** Generation stop: every preparation not owned by a run is closed; tickets become unusable. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const [ticket, entry] of this.entries) {
			if (entry.timer) clearTimeout(entry.timer);
			this.entries.delete(ticket);
			// The generation ends here, so nobody could retry later: one retry now.
			if (entry.state !== "admitted") {
				entry.state = "expired";
				void entry.preparation.close().then((outcome) => outcome === "closed" ? outcome : entry.preparation.close(), () => entry.preparation.close()).catch(() => {});
			}
		}
	}

	snapshot(): { prepared: number; admitted: number; reserved: number } {
		let prepared = 0; let admitted = 0;
		for (const entry of this.entries.values()) {
			if (entry.state === "prepared") prepared++;
			else if (entry.state === "admitted") admitted++;
		}
		return { prepared, admitted, reserved: this.reserved };
	}
}
