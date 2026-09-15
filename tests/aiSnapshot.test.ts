import { test } from "node:test";
import assert from "node:assert/strict";
import { annotationFromPayload } from "../src/storage/annotationStore";
import { sameSelection } from "../src/pdfview/selection";

const payloadA = {
	page: 3,
	rects: [{ x: 1, y: 2, width: 3, height: 4 }],
	text: "original selected text A",
	textOffset: 10,
	contextBefore: "bA",
	contextAfter: "aA",
	anchorRect: null,
};
const payloadB = { ...payloadA, page: 5, text: "different selection B" };

test("AI result stays bound to the snapshot captured at request time", async () => {
	// simulate: request fired with payloadA; user re-selects B in flight
	let current: typeof payloadA | null = payloadA;
	const snapshot = payloadA;

	const fakeLlm = async () => {
		await new Promise((r) => setTimeout(r, 10));
		current = payloadB; // user changed selection mid-flight
		return "AI answer for A";
	};

	const answer = await fakeLlm();
	// completion path records against the snapshot, never the live selection
	const ann = annotationFromPayload(snapshot, {
		type: "translation",
		color: "",
		aiContent: answer,
	});
	assert.equal(ann.text, "original selected text A");
	assert.equal(ann.page, 3);
	assert.equal(ann.aiContent, "AI answer for A");
	// and the change is detectable for the Notice path
	assert.equal(sameSelection(current as never, snapshot as never), false);
});

test("unchanged selection is not flagged as changed", () => {
	assert.equal(sameSelection(payloadA as never, { ...payloadA } as never), true);
});
