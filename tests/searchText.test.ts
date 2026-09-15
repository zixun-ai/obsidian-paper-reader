import { test } from "node:test";
import assert from "node:assert/strict";
import { findHits, normalizeQuery, normalizeWithMap } from "../src/search/searchText";

test("normalize collapses whitespace and keeps index map", () => {
	const { norm, map } = normalizeWithMap("ab  \n cd");
	assert.equal(norm, "ab cd");
	// norm "ab cd": 'c' at norm idx 3 -> original idx 6
	assert.equal(map[3], 6);
});

test("findHits is case-insensitive and spans whitespace gaps", () => {
	const texts = [
		"Hello   World foo",
		"nothing here",
		"hello world again HELLO",
	];
	const hits = findHits(texts, "hello world");
	assert.equal(hits.length, 2);
	assert.deepEqual(hits[0], { page: 1, index: 0, length: 13 });
	assert.equal(hits[1].page, 3);
});

test("findHits: empty query / no match / missing pages", () => {
	assert.deepEqual(findHits(["abc"], "  "), []);
	assert.deepEqual(findHits(["abc"], "xyz"), []);
	assert.deepEqual(findHits([undefined, "abc"], "abc").length, 1);
	assert.equal(normalizeQuery("  Ab  C "), "ab c");
});
