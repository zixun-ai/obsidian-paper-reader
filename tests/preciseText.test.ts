import { test } from "node:test";
import assert from "node:assert/strict";
import { preciseTextContent } from "../src/pdfview/preciseText";
import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api";

// PDF.js operator IDs are passed in so the geometry helper is testable without a DOM.
const ops = { save: 10, restore: 11, setFont: 37, showText: 44,
	setCharSpacing: 33, setWordSpacing: 34, setGState: 9 };
const glyph = (unicode: string, width: number) => ({ unicode, width, isSpace: unicode === " " });
const title = [glyph("E", 667), glyph("a", 500), glyph("r", 444), glyph("t", 333),
	glyph("h", 556), glyph("L", 667), glyph("D", 722), glyph(":", 333)];
const item: TextItem = { str: "EarthLD:", dir: "ltr", width: 42.22, height: 10,
	transform: [10, 0, 0, 10, 20, 100], fontName: "font1", hasEOL: true };
const content = (i = item): TextContent => ({ items: [i], styles: {
	font1: { fontFamily: "sans-serif", ascent: 0.8, descent: -0.2, vertical: false },
}, lang: "en" });
const list = (glyphs: unknown[] = title) => ({ fnArray: [37, 44], argsArray: [["font1", 10], [glyphs]], lastChunk: true });

test("D ends at its PDF advance, with copied text and EOL preserved", () => {
	const result = preciseTextContent(content(), list(), ops);
	const items = result.content.items as TextItem[];
	assert.equal(items.length, 8);
	assert.equal(items.map(i => i.str).join(""), "EarthLD:");
	assert.ok(Math.abs(items[6].transform[4] + items[6].width - 58.89) < 1e-8);
	assert.equal(items.filter(i => i.hasEOL).length, 1);
	assert.equal(items.at(-1)!.hasEOL, true);
});

test("PDF kerning, synthetic spaces and ligatures retain exact positions", () => {
	const glyphs = [glyph("T", 667), 90, glyph("o", 500), -250, glyph("ﬁ", 556)];
	const result = preciseTextContent(content({ ...item, str: "To fi", width: 18.83 }), list(glyphs), ops);
	const items = result.content.items as TextItem[];
	assert.deepEqual(items.map(i => i.str), ["T", "o", " ", "fi"]);
	assert.ok(Math.abs(items[1].transform[4] - 25.77) < 1e-8);
	assert.ok(Math.abs(items[3].transform[4] - 33.27) < 1e-8);
});

test("uncertain widths, RTL and ambiguous runs keep the original text layer", () => {
	for (const changed of [{ ...item, width: 50 }, { ...item, dir: "rtl" }]) {
		const input = content(changed);
		assert.equal(preciseTextContent(input, list(), ops).content.items[0], changed);
	}
	const ambiguous = list();
	ambiguous.fnArray.push(44);
	ambiguous.argsArray.push([[glyph("E", 600), glyph("a", 567), ...title.slice(2)]]);
	assert.equal(preciseTextContent(content(), ambiguous, ops).content.items[0], item);
});

test("character/word spacing and graphics-state restoration preserve advances", () => {
	const input = content({ ...item, str: "E D", width: 21.89 });
	const operations = { fnArray: [37, 33, 34, 10, 37, 11, 44],
		argsArray: [["font1", 10], [1], [2], [], ["other", 20], [],
			[[glyph("E", 667), glyph(" ", 300), glyph("D", 722)]]] };
	const result = preciseTextContent(input, operations, ops).content.items as TextItem[];
	assert.equal(result.length, 3);
	assert.ok(Math.abs(result[2].transform[4] - 33.67) < 1e-8);
});
