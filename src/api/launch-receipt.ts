import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cloneJsonWithinByteLimit } from "../bound/bound-json.ts";

export const LAUNCH_RECEIPT_VERSION = 1 as const;
export const LAUNCH_RECEIPT_TTL_MS = 30_000 as const;
const HEX_64 = /^[0-9a-f]{64}$/;
const RFC4122_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface LaunchReceiptPayloadV1 {
	version: typeof LAUNCH_RECEIPT_VERSION;
	serverInstanceId: string;
	sourceIdentityDigest: string;
	activeSessionDigest: string;
	prospectiveRunId: string;
	requestDigest: string;
	launchContractDigest: string;
	issuedAt: number;
	expiresAt: number;
}
export interface LaunchReceiptV1 {
	version: typeof LAUNCH_RECEIPT_VERSION;
	algorithm: "HMAC-SHA256";
	payload: LaunchReceiptPayloadV1;
	mac: string;
}
export interface LaunchCancellationTokenPayloadV1 extends LaunchReceiptPayloadV1 {
	requestId: string;
	ownerRunId: string;
	nodeId: string;
}
export interface LaunchCancellationTokenV1 {
	version: 1;
	algorithm: "HMAC-SHA256";
	payload: LaunchCancellationTokenPayloadV1;
	mac: string;
}
export interface LaunchReceiptIssueInput extends Omit<LaunchReceiptPayloadV1, "version" | "issuedAt" | "expiresAt"> {}
export interface LaunchReceiptService {
	issue(input: LaunchReceiptIssueInput): LaunchReceiptV1;
	verify(receipt: LaunchReceiptV1): boolean;
	issueCancellation(receipt: LaunchReceiptV1, tuple: { requestId: string; ownerRunId: string; nodeId: string }): LaunchCancellationTokenV1;
	verifyCancellation(token: LaunchCancellationTokenV1): boolean;
	verifyCancellationAuthenticity(token: LaunchCancellationTokenV1): boolean;
	dispose(): void;
}
export interface CreateLaunchReceiptServiceOptions {
	secret?: Uint8Array;
	clock?: () => number;
	random?: (size: number) => Uint8Array;
}

export function projectLaunchReceiptPayload(payload: LaunchReceiptPayloadV1): Record<string, unknown> {
	return {
		version: payload.version, serverInstanceId: payload.serverInstanceId,
		sourceIdentityDigest: payload.sourceIdentityDigest, activeSessionDigest: payload.activeSessionDigest,
		prospectiveRunId: payload.prospectiveRunId, requestDigest: payload.requestDigest,
		launchContractDigest: payload.launchContractDigest, issuedAt: payload.issuedAt, expiresAt: payload.expiresAt,
	};
}
export function encodeLaunchReceiptPayload(payload: LaunchReceiptPayloadV1): string {
	return JSON.stringify(projectLaunchReceiptPayload(payload));
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
function validIdentity(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\r\n]/u.test(value); }
function validPayload(payload: LaunchReceiptPayloadV1): boolean {
	return payload?.version === 1
		&& RFC4122_UUID.test(payload.serverInstanceId) && RFC4122_UUID.test(payload.prospectiveRunId)
		&& [payload.sourceIdentityDigest, payload.activeSessionDigest, payload.requestDigest, payload.launchContractDigest].every((value) => typeof value === "string" && HEX_64.test(value))
		&& Number.isSafeInteger(payload.issuedAt) && Number.isSafeInteger(payload.expiresAt)
		&& payload.expiresAt - payload.issuedAt === LAUNCH_RECEIPT_TTL_MS;
}

/** Per-runtime receipt authority. Default time is monotonic and unrelated to Date.now(). */
export function createLaunchReceiptService(options: CreateLaunchReceiptServiceOptions = {}): LaunchReceiptService {
	let secret: Buffer | undefined = Buffer.from(options.secret ?? (options.random ?? randomBytes)(32));
	if (secret.byteLength !== 32) {
		secret.fill(0);
		throw new Error("Launch receipt secret must be exactly 32 bytes.");
	}
	const clock = options.clock ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
	const requireSecret = (): Buffer => {
		if (!secret) throw new Error("Launch receipt service is disposed.");
		return secret;
	};
	const mac = (payload: LaunchReceiptPayloadV1): string => createHmac("sha256", requireSecret()).update(encodeLaunchReceiptPayload(payload), "utf8").digest("hex");
	const cancellationMac = (payload: LaunchCancellationTokenPayloadV1): string => createHmac("sha256", requireSecret())
		.update("pi-subagents:active-bound-cancel:v1\0", "utf8").update(JSON.stringify({ ...projectLaunchReceiptPayload(payload), requestId: payload.requestId, ownerRunId: payload.ownerRunId, nodeId: payload.nodeId }), "utf8").digest("hex");
	const validCancellation = (token: LaunchCancellationTokenV1, enforceLifetime: boolean): boolean => {
		const cloned = cloneJsonWithinByteLimit(token, 32 * 1024);
		if (!cloned.ok || !cloned.value || typeof cloned.value !== "object" || Array.isArray(cloned.value)) return false;
		const candidate = cloned.value as unknown as LaunchCancellationTokenV1;
		if (!exactKeys(candidate as unknown as Record<string, unknown>, ["version", "algorithm", "payload", "mac"])
			|| !candidate.payload || typeof candidate.payload !== "object" || Array.isArray(candidate.payload)
			|| !exactKeys(candidate.payload as unknown as Record<string, unknown>, ["version", "serverInstanceId", "sourceIdentityDigest", "activeSessionDigest", "prospectiveRunId", "requestDigest", "launchContractDigest", "issuedAt", "expiresAt", "requestId", "ownerRunId", "nodeId"])
			|| candidate.version !== 1 || candidate.algorithm !== "HMAC-SHA256" || !validPayload(candidate.payload)
			|| !validIdentity(candidate.payload.requestId) || !validIdentity(candidate.payload.ownerRunId) || !validIdentity(candidate.payload.nodeId) || !HEX_64.test(candidate.mac)) return false;
		if (enforceLifetime) {
			const now = Math.trunc(clock());
			if (!Number.isSafeInteger(now) || now < candidate.payload.issuedAt || now >= candidate.payload.expiresAt) return false;
		}
		const expected = Buffer.from(cancellationMac(candidate.payload), "hex"); const actual = Buffer.from(candidate.mac, "hex");
		return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
	};
	return {
		issue(input) {
			const issuedAt = Math.trunc(clock());
			if (!Number.isSafeInteger(issuedAt)) throw new Error("Launch receipt clock returned an invalid time.");
			const payload: LaunchReceiptPayloadV1 = {
				version: 1, serverInstanceId: input.serverInstanceId, sourceIdentityDigest: input.sourceIdentityDigest,
				activeSessionDigest: input.activeSessionDigest, prospectiveRunId: input.prospectiveRunId,
				requestDigest: input.requestDigest, launchContractDigest: input.launchContractDigest,
				issuedAt, expiresAt: issuedAt + LAUNCH_RECEIPT_TTL_MS,
			};
			if (!validPayload(payload)) throw new Error("Invalid launch receipt payload.");
			return { version: 1, algorithm: "HMAC-SHA256", payload, mac: mac(payload) };
		},
		verify(receipt) {
			if (!secret) return false;
			const cloned = cloneJsonWithinByteLimit(receipt, 16 * 1024);
			if (!cloned.ok || !cloned.value || typeof cloned.value !== "object" || Array.isArray(cloned.value)) return false;
			const candidate = cloned.value as unknown as LaunchReceiptV1;
			if (!exactKeys(candidate as unknown as Record<string, unknown>, ["version", "algorithm", "payload", "mac"])
				|| !candidate.payload || typeof candidate.payload !== "object" || Array.isArray(candidate.payload)
				|| !exactKeys(candidate.payload as unknown as Record<string, unknown>, ["version", "serverInstanceId", "sourceIdentityDigest", "activeSessionDigest", "prospectiveRunId", "requestDigest", "launchContractDigest", "issuedAt", "expiresAt"])
				|| candidate.version !== 1 || candidate.algorithm !== "HMAC-SHA256" || !validPayload(candidate.payload) || !HEX_64.test(candidate.mac)) return false;
			const now = Math.trunc(clock());
			if (!Number.isSafeInteger(now) || now < candidate.payload.issuedAt || now >= candidate.payload.expiresAt) return false;
			const expected = Buffer.from(mac(candidate.payload), "hex");
			const actual = Buffer.from(candidate.mac, "hex");
			return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
		},
		issueCancellation(receipt, tuple) {
			if (!this.verify(receipt) || !validIdentity(tuple.requestId) || !validIdentity(tuple.ownerRunId) || !validIdentity(tuple.nodeId)) throw new Error("Invalid cancellation token input.");
			const payload: LaunchCancellationTokenPayloadV1 = { ...receipt.payload, ...tuple };
			return { version: 1, algorithm: "HMAC-SHA256", payload, mac: cancellationMac(payload) };
		},
		verifyCancellation(token) { return Boolean(secret) && validCancellation(token, true); },
		verifyCancellationAuthenticity(token) { return Boolean(secret) && validCancellation(token, false); },
		dispose() {
			if (!secret) return;
			secret.fill(0);
			secret = undefined;
		},
	};
}
