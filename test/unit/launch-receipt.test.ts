import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLaunchReceiptService, LAUNCH_RECEIPT_TTL_MS } from "../../src/api/launch-receipt.ts";

const INPUT = {
	serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	sourceIdentityDigest: "a".repeat(64), activeSessionDigest: "b".repeat(64),
	prospectiveRunId: "123e4567-e89b-12d3-a456-426614174000",
	requestDigest: "c".repeat(64), launchContractDigest: "d".repeat(64),
};
const EXPECTED_MAC = "8ae582b04e298068abfd0d7c58683b6082b24a2de8ed90e411ecf10ea4b39173";

describe("launch receipt service", () => {
	it("matches an independent fixed HMAC vector and exact TTL boundaries", () => {
		let now = 1000;
		const service = createLaunchReceiptService({ secret: Buffer.alloc(32, 0x2a), clock: () => now });
		const receipt = service.issue(INPUT);
		assert.equal(receipt.mac, EXPECTED_MAC);
		assert.equal(receipt.payload.expiresAt - receipt.payload.issuedAt, LAUNCH_RECEIPT_TTL_MS);
		for (const [time, expected] of [[999, false], [1000, true], [30_999, true], [31_000, false]] as const) {
			now = time; assert.equal(service.verify(receipt), expected);
		}
		assert.deepEqual(Object.keys(receipt), ["version", "algorithm", "payload", "mac"]);
		assert.equal(JSON.stringify(receipt).includes("secret"), false);
	});

	it("rejects every signed field, MAC, algorithm, version and lifetime mutation", () => {
		const service = createLaunchReceiptService({ secret: Buffer.alloc(32, 7), clock: () => 1000 });
		const receipt = service.issue(INPUT);
		for (const field of ["serverInstanceId", "sourceIdentityDigest", "activeSessionDigest", "prospectiveRunId", "requestDigest", "launchContractDigest"] as const) {
			assert.equal(service.verify({ ...receipt, payload: { ...receipt.payload, [field]: `${receipt.payload[field]}x` } }), false);
		}
		assert.equal(service.verify({ ...receipt, mac: `0${receipt.mac.slice(1)}` }), false);
		assert.equal(service.verify({ ...receipt, algorithm: "bad" as never }), false);
		assert.equal(service.verify({ ...receipt, version: 2 as never }), false);
		assert.equal(service.verify({ ...receipt, payload: { ...receipt.payload, expiresAt: 31_001 } }), false);
	});

	it("issues a domain-separated cancellation token whose authority survives admission TTL", () => {
		let now = 1000;
		const service = createLaunchReceiptService({ secret: Buffer.alloc(32, 9), clock: () => now });
		const receipt = service.issue(INPUT); const tuple = { requestId: "r", ownerRunId: "o", nodeId: "n" };
		const token = service.issueCancellation(receipt, tuple);
		assert.equal(service.verifyCancellation(token), true); assert.equal(service.verifyCancellationAuthenticity(token), true); assert.notEqual(token.mac, receipt.mac);
		now = receipt.payload.expiresAt;
		assert.equal(service.verifyCancellation(token), false);
		assert.equal(service.verifyCancellationAuthenticity(token), true);
		for (const field of ["requestId", "ownerRunId", "nodeId"] as const) {
			const mutated = { ...token, payload: { ...token.payload, [field]: `${token.payload[field]}x` } };
			assert.equal(service.verifyCancellation(mutated), false); assert.equal(service.verifyCancellationAuthenticity(mutated), false);
		}
		const mutatedDigest = { ...token, payload: { ...token.payload, requestDigest: "f".repeat(64) } };
		assert.equal(service.verifyCancellation(mutatedDigest), false); assert.equal(service.verifyCancellationAuthenticity(mutatedDigest), false);
	});

	it("uses distinct default secrets for an identical payload", () => {
		const one = createLaunchReceiptService({ clock: () => 50 });
		const two = createLaunchReceiptService({ clock: () => 50 });
		assert.notEqual(one.issue(INPUT).mac, two.issue(INPUT).mac);
	});

	it("requests 32 random bytes and default monotonic time ignores Date.now rollback", () => {
		const sizes: number[] = [];
		const injected = createLaunchReceiptService({ random: (size) => { sizes.push(size); return Buffer.alloc(size, 1); }, clock: () => 50 });
		injected.issue(INPUT);
		assert.deepEqual(sizes, [32]);

		const service = createLaunchReceiptService();
		const first = service.issue(INPUT).payload.issuedAt;
		const original = Date.now;
		try {
			Date.now = () => -9_999_999;
			assert.ok(service.issue(INPUT).payload.issuedAt >= first);
		} finally { Date.now = original; }
	});

	it("zeros caller-independent secret storage and fails closed after dispose", () => {
		const source = Buffer.alloc(32, 3);
		const service = createLaunchReceiptService({ secret: source, clock: () => 1 });
		const receipt = service.issue(INPUT);
		service.dispose(); service.dispose();
		assert.equal(source.every((byte) => byte === 3), true);
		assert.equal(service.verify(receipt), false);
		assert.throws(() => service.issue(INPUT), /disposed/);
	});
});
