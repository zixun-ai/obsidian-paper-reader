import { test } from "node:test";
import assert from "node:assert/strict";
import { Notice } from "obsidian";
import {
	AnnotationStore,
	annotationFromPayload,
} from "../src/storage/annotationStore";

class MemAdapter {
	files = new Map<string, string>();
	exists = async (p: string) => this.files.has(p);
	read = async (p: string) => {
		if (!this.files.has(p)) throw new Error("ENOENT " + p);
		return this.files.get(p)!;
	};
	write = async (p: string, c: string) => {
		this.files.set(p, c);
	};
	copy = async (s: string, d: string) => {
		this.files.set(d, this.files.get(s)!);
	};
}

function makeStore(adapter: MemAdapter): AnnotationStore {
	const app = { vault: { adapter } };
	return new AnnotationStore(app as never, () => ".annotations.json");
}

const PDF = "papers/sub/foo.pdf";
const ANN = "papers/sub/foo.annotations.json";

function sampleAnnotation() {
	return annotationFromPayload(
		{
			page: 3,
			rects: [{ x: 10, y: 20, width: 100, height: 12 }],
			text: "selected text",
			textOffset: 42,
			contextBefore: "before",
			contextAfter: "after",
		},
		{ type: "highlight", color: "yellow" }
	);
}

test("save/load round-trip preserves annotations", async () => {
	Notice.reset();
	const adapter = new MemAdapter();
	const store = makeStore(adapter);
	const ann = sampleAnnotation();
	const data = { version: 1 as const, file: "foo.pdf", annotations: [ann] };

	assert.equal(await store.save(PDF, data), true);
	const loaded = await store.load(PDF);
	assert.equal(loaded.annotations.length, 1);
	assert.deepEqual(loaded.annotations[0], ann);
	assert.equal(store.isCorrupted(PDF), false);
});

test("corrupt JSON enters read-only protection, never overwrites the original", async () => {
	Notice.reset();
	const adapter = new MemAdapter();
	const original = "{ broken json !!!";
	adapter.files.set(ANN, original);
	const store = makeStore(adapter);

	const loaded = await store.load(PDF);
	assert.equal(loaded.annotations.length, 0);
	assert.equal(store.isCorrupted(PDF), true);
	// original backed up once
	assert.equal(adapter.files.get(ANN + ".bak"), original);

	// save must be blocked and must NOT overwrite the corrupt file
	const saved = await store.save(PDF, {
		version: 1,
		file: "foo.pdf",
		annotations: [sampleAnnotation()],
	});
	assert.equal(saved, false);
	assert.equal(adapter.files.get(ANN), original);
	assert.ok(Notice.messages.some((m) => m.includes("只读保护") || m.includes("阻断")));
});

test("structurally invalid JSON (no annotations array) is also protected", async () => {
	Notice.reset();
	const adapter = new MemAdapter();
	adapter.files.set(ANN, JSON.stringify({ version: 1, file: "foo.pdf" }));
	const store = makeStore(adapter);

	await store.load(PDF);
	assert.equal(store.isCorrupted(PDF), true);
	assert.equal(await store.save(PDF, { version: 1, file: "f", annotations: [] }), false);
});

test("write failure returns false and reports via Notice", async () => {
	Notice.reset();
	const adapter = new MemAdapter();
	adapter.write = async () => {
		throw new Error("simulated iCloud write failure");
	};
	const store = makeStore(adapter);
	const ok = await store.save(PDF, {
		version: 1,
		file: "foo.pdf",
		annotations: [sampleAnnotation()],
	});
	assert.equal(ok, false);
	assert.ok(Notice.messages.some((m) => m.includes("写入失败")));
	assert.equal(adapter.files.has(ANN), false);
});

test("a second reader cannot silently overwrite a newer annotation snapshot", async () => {
	const adapter = new MemAdapter();
	const first = makeStore(adapter), second = makeStore(adapter);
	const a = await first.load(PDF), b = await second.load(PDF);
	a.annotations.push(sampleAnnotation()); b.annotations.push(sampleAnnotation());
	assert.equal(await first.save(PDF, a), true);
	assert.equal(await second.save(PDF, b), false);
	assert.equal(JSON.parse(adapter.files.get(ANN)!).annotations[0].id, a.annotations[0].id);
	assert.equal(b.annotations.length, 1, "conflicted draft stays in memory");
	const fresh = await second.load(PDF);
	fresh.annotations.push(b.annotations[0]);
	assert.equal(await second.save(PDF, fresh), true);
	assert.equal((await first.load(PDF)).annotations.length, 2);
});

test("concurrent saves are serialized and a rejected conflict does not poison the queue", async () => {
	const adapter = new MemAdapter();
	const first = makeStore(adapter), second = makeStore(adapter);
	const a = await first.load(PDF), b = await second.load(PDF);
	a.annotations.push(sampleAnnotation()); b.annotations.push(sampleAnnotation());
	assert.deepEqual(await Promise.all([first.save(PDF, a), second.save(PDF, b)]), [true, false]);
	const latest = await first.load(PDF);
	latest.annotations.push(sampleAnnotation());
	assert.equal(await first.save(PDF, latest), true);
});

test("a failed verification read can be retried without overwriting another writer", async () => {
	const adapter = new MemAdapter(), store = makeStore(adapter);
	const data = await store.load(PDF); data.annotations.push(sampleAnnotation());
	const read = adapter.read;
	let fail = true;
	adapter.read = async path => { if (fail) { fail = false; throw new Error("temporary read failure"); } return read(path); };
	assert.equal(await store.save(PDF, data), false);
	assert.equal(await store.save(PDF, data), true);
});
