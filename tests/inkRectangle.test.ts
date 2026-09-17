import test from "node:test";
import assert from "node:assert/strict";
import { rectanglePoints, transformRectangle } from "../src/pdfview/InkLayer";

test("rectangle geometry supports move, resize and minimum size", () => {
	const original = { x: 20, y: 30, width: 100, height: 60 };
	assert.deepEqual(transformRectangle(original, "move", -50, 200, 300, 200),
		{ x: 0, y: 140, width: 100, height: 60 });
	assert.deepEqual(transformRectangle(original, "nw", 10, 15, 300, 200),
		{ x: 30, y: 45, width: 90, height: 45 });
	assert.deepEqual(transformRectangle(original, "se", -200, -200, 300, 200, 8),
		{ x: 20, y: 30, width: 8, height: 8 });
	assert.deepEqual(rectanglePoints(1, 2, 3, 4), [1, 2, 4, 2, 4, 6, 1, 6, 1, 2]);
});
