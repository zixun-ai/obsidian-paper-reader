import { test } from "node:test";
import assert from "node:assert/strict";
import {
	PopupStateCache,
	popupCacheKey,
} from "../src/pdfview/popupCache";

function payload(page: number, text: string) {
	return { page, text } as never;
}

test("same selection restores cached state; different selection starts fresh", () => {
	const cache = new PopupStateCache();
	const keyA = popupCacheKey(payload(1, "hello world"));
	cache.merge(keyA, { translation: "你好世界", noteDraft: "草稿" });

	// reopen same selection -> restored
	assert.deepEqual(cache.get(keyA), { translation: "你好世界", noteDraft: "草稿" });
	// same text on another page -> fresh
	assert.equal(cache.get(popupCacheKey(payload(2, "hello world"))), undefined);
	// different text same page -> fresh
	assert.equal(cache.get(popupCacheKey(payload(1, "other text"))), undefined);
});

test("merge accumulates fields; draft can be cleared after submit", () => {
	const cache = new PopupStateCache();
	const key = popupCacheKey(payload(1, "abc"));
	cache.merge(key, { noteDraft: "partial" });
	cache.merge(key, { translation: "译文" });
	assert.deepEqual(cache.get(key), { noteDraft: "partial", translation: "译文" });
	cache.merge(key, { noteDraft: "" });
	assert.deepEqual(cache.get(key), { noteDraft: "", translation: "译文" });
});

test("clear wipes all cached state (new document opened)", () => {
	const cache = new PopupStateCache();
	cache.merge(popupCacheKey(payload(1, "abc")), { translation: "x" });
	cache.clear();
	assert.equal(cache.get(popupCacheKey(payload(1, "abc"))), undefined);
});
