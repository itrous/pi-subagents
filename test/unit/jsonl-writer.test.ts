import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJsonlWriter, type DrainableSource, type JsonlWriteStream } from "../../src/shared/jsonl-writer.ts";

class MockSource implements DrainableSource {
	paused = 0;
	resumed = 0;
	pause(): void {
		this.paused++;
	}
	resume(): void {
		this.resumed++;
	}
}

class MockStream implements JsonlWriteStream {
	writes: string[] = [];
	ended = false;
	private drainHandler?: () => void;
	private errorHandler?: () => void;
	private readonly writeResults: boolean[];
	constructor(writeResults: boolean[] = []) {
		this.writeResults = writeResults;
	}
	write(chunk: string): boolean {
		this.writes.push(chunk);
		if (this.writeResults.length === 0) return true;
		return this.writeResults.shift() ?? true;
	}
	on(event: "error", listener: () => void): JsonlWriteStream { if (event === "error") this.errorHandler = listener; return this; }
	once(event: "drain", listener: () => void): JsonlWriteStream {
		if (event === "drain") this.drainHandler = listener;
		return this;
	}
	end(callback?: () => void): void {
		this.ended = true;
		callback?.();
	}
	emitDrain(): void {
		this.drainHandler?.();
	}
	emitError(): void { this.errorHandler?.(); }
}

describe("createJsonlWriter", () => {
	it("writes lines with trailing newline", () => {
		const source = new MockSource();
		const stream = new MockStream();
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
		});
		writer.writeLine('{"type":"a"}');
		writer.writeLine('{"type":"b"}');
		assert.deepEqual(stream.writes, ['{"type":"a"}\n', '{"type":"b"}\n']);
	});

	it("pauses on backpressure and resumes on drain", () => {
		const source = new MockSource();
		const stream = new MockStream([false, true]);
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
		});
		writer.writeLine('{"type":"a"}');
		assert.equal(source.paused, 1);
		assert.equal(source.resumed, 0);
		stream.emitDrain();
		assert.equal(source.resumed, 1);
		writer.writeLine('{"type":"b"}');
		assert.deepEqual(stream.writes, ['{"type":"a"}\n', '{"type":"b"}\n']);
	});

	it("turns asynchronous stream errors into silent best-effort closure", async () => {
		const source = new MockSource(); const stream = new MockStream([false]);
		const writer = createJsonlWriter("/tmp/out.jsonl", source, { createWriteStream: () => stream });
		writer.writeLine("first"); assert.equal(source.paused, 1); stream.emitError(); assert.equal(source.resumed, 1);
		writer.writeLine("ignored"); assert.deepEqual(stream.writes, ["first\n"]); await writer.close();
	});

	it("settles close when the stream errors during end", async () => {
		const source = new MockSource(); const stream = new MockStream();
		stream.end = () => stream.emitError();
		const writer = createJsonlWriter("/tmp/out.jsonl", source, { createWriteStream: () => stream });
		await writer.close();
	});

	it("closes stream once", async () => {
		const source = new MockSource();
		const stream = new MockStream();
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
		});
		await writer.close();
		assert.equal(stream.ended, true);
		await writer.close();
		assert.equal(stream.ended, true);
	});

	it("returns no-op writer when file path is undefined", async () => {
		const source = new MockSource();
		const writer = createJsonlWriter(undefined, source);
		writer.writeLine('{"type":"a"}');
		await writer.close();
		assert.equal(source.paused, 0);
		assert.equal(source.resumed, 0);
	});

	it("stops writing when maxBytes exceeded without pausing source", () => {
		const source = new MockSource();
		const stream = new MockStream();
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
			maxBytes: 30,
		});
		writer.writeLine('{"type":"a"}');
		writer.writeLine('{"type":"b"}');
		writer.writeLine('{"type":"c"}');
		assert.equal(stream.writes.length, 2);
		assert.deepEqual(stream.writes, ['{"type":"a"}\n', '{"type":"b"}\n']);
		assert.equal(source.paused, 0);
	});

	it("allows writes up to exactly maxBytes", () => {
		const source = new MockSource();
		const stream = new MockStream();
		const line = '{"x":"a"}';
		const lineBytes = Buffer.byteLength(`${line}\n`, "utf-8");
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
			maxBytes: lineBytes * 2,
		});
		writer.writeLine(line);
		writer.writeLine(line);
		writer.writeLine(line);
		assert.equal(stream.writes.length, 2);
	});
});
