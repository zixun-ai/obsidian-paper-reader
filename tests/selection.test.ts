import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildSingleLineRect,
	filterMultiLineRects,
	separateSelectionLines,
	sameSelection,
	RectLike,
	mergeTextRects,
} from "../src/pdfview/selection";

test("glyph cells merge across word spaces but not across columns or lines", () => {
	assert.deepEqual(mergeTextRects([
		{ left: 0, top: 0, width: 5, height: 20 },
		{ left: 5, top: 0, width: 2, height: 20 },
		{ left: 12, top: 0, width: 8, height: 20 },
		{ left: 80, top: 0, width: 10, height: 20 },
		{ left: 0, top: 24, width: 10, height: 20 },
	]), [
		{ left: 0, top: 0, width: 20, height: 20 },
		{ left: 80, top: 0, width: 10, height: 20 },
		{ left: 0, top: 24, width: 10, height: 20 },
	]);
});

test("single-line rect from caret positions", () => {
	const r = buildSingleLineRect(
		{ left: 100, top: 200, width: 0, height: 30 },
		{ left: 260, top: 201, width: 0, height: 30 }
	);
	assert.deepEqual(r, { left: 100, top: 200, width: 160, height: 30 });
});

test("single-line rect rejects cross-line carets and zero width", () => {
	assert.equal(buildSingleLineRect(
		{ left: 100, top: 200, width: 0, height: 12 },
		{ left: 101.5, top: 200, width: 0, height: 12 }
	)?.width, 1.5, "narrow letters remain selectable when zoomed out");
	assert.equal(
		buildSingleLineRect(
			{ left: 100, top: 200, width: 0, height: 30 },
			{ left: 100, top: 240, width: 0, height: 30 }
		),
		null
	);
	assert.equal(
		buildSingleLineRect(
			{ left: 100, top: 200, width: 0, height: 30 },
			{ left: 100, top: 200, width: 0, height: 30 }
		),
		null
	);
});

test("multi-line filter: drops slivers, out-of-band, giant boxes, duplicates", () => {
	const raw: RectLike[] = [
		{ left: 179, top: 199, width: 514, height: 30 }, // line 1 keep
		{ left: 8, top: -1, width: 0.5, height: 18 }, // sliver drop
		{ left: 241, top: 236, width: 387, height: 26 }, // line 2 span-box keep
		{ left: 241, top: 233, width: 387, height: 30 }, // near-duplicate drop
		{ left: 30, top: 178, width: 36, height: 646 }, // transformed giant drop
		{ left: 100, top: 900, width: 100, height: 30 }, // out of band drop
	];
	const kept = filterMultiLineRects(raw, 197, 272, 30);
	assert.equal(kept.length, 2);
	assert.deepEqual(
		kept.map((r) => [r.left, r.top]),
		[
			[179, 199],
			[241, 236],
		]
	);
});

test("active selection bands cannot overlap across adjacent lines", () => {
	const rects = separateSelectionLines([
		{ x: 0, y: 0, width: 100, height: 30 },
		{ x: 10, y: 24, width: 80, height: 30 },
	]);
	assert.equal(rects.length, 2);
	assert.ok(rects[0].y + rects[0].height <= rects[1].y);
	assert.equal(rects[0].width, 100);
	assert.equal(rects[1].width, 80);
});

test("sameSelection compares page + text identity", () => {
	const base = {
		page: 3,
		rects: [],
		text: "abc",
		textOffset: 0,
		contextBefore: "",
		contextAfter: "",
		anchorRect: null,
	};
	assert.equal(sameSelection(base as never, { ...base } as never), true);
	assert.equal(sameSelection(base as never, { ...base, text: "xyz" } as never), false);
	assert.equal(sameSelection(base as never, { ...base, page: 4 } as never), false);
	assert.equal(sameSelection(null, base as never), false);
});
