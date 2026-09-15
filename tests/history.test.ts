import { test } from "node:test";
import assert from "node:assert/strict";
import {
	AnnotationHistory,
	HistoryOp,
	cloneAnnotation,
} from "../src/history/AnnotationHistory";
import { annotationFromPayload } from "../src/storage/annotationStore";

function makeAnn(id: string, text = "t") {
	const ann = annotationFromPayload(
		{ page: 1, rects: [], text, textOffset: 0, contextBefore: "", contextAfter: "" },
		{ type: "highlight", color: "yellow" }
	);
	ann.id = id;
	return ann;
}

function makeHistory() {
	const log: [HistoryOp, string][] = [];
	const h = new AnnotationHistory(
		async (op, dir) => {
			log.push([op, dir]);
			return true;
		},
		() => {}
	);
	return { h, log };
}

test("add -> undo -> redo round trip", async () => {
	const { h, log } = makeHistory();
	const ann = makeAnn("1");
	h.push({ kind: "add", ann });
	assert.equal(h.canUndo, true);
	assert.equal(h.canRedo, false);

	await h.undo();
	assert.deepEqual(log.map(([, d]) => d), ["undo"]);
	assert.equal(h.canRedo, true);

	await h.redo();
	assert.deepEqual(log.map(([, d]) => d), ["undo", "redo"]);
	assert.equal(h.canUndo, true);
	assert.equal(h.canRedo, false);
});

test("new op clears the redo branch", async () => {
	const { h } = makeHistory();
	h.push({ kind: "add", ann: makeAnn("1") });
	await h.undo();
	assert.equal(h.canRedo, true);
	h.push({ kind: "add", ann: makeAnn("2") });
	assert.equal(h.canRedo, false);
});

test("failed apply keeps stack pointers unchanged", async () => {
	let calls = 0;
	const h = new AnnotationHistory(
		async () => {
			calls++;
			return false; // persistence failed
		},
		() => {}
	);
	h.push({ kind: "add", ann: makeAnn("1") });
	assert.equal(await h.undo(), false);
	assert.equal(h.canUndo, true); // pointer restored
	assert.equal(h.canRedo, false);
	assert.equal(calls, 1);
});

test("update op carries before/after clones", async () => {
	const before = makeAnn("1", "old");
	const after = cloneAnnotation(before);
	after.note = "new";
	const { h, log } = makeHistory();
	h.push({ kind: "update", before, after });
	await h.undo();
	const [op, dir] = log[0];
	assert.equal(dir, "undo");
	if (op.kind === "update") {
		assert.equal(op.before.note ?? "", "");
		assert.equal(op.after.note, "new");
	}
});
