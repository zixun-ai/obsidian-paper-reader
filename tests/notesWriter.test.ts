import { test } from "node:test";
import assert from "node:assert/strict";
import { Notice } from "obsidian";
import { appendToNotes, backlinkFor } from "../src/storage/notesWriter";
import { inkBoundingRect } from "../src/pdfview/InkLayer";

class MemAdapter {
	files = new Map<string, string>();
	exists = async (p: string) => this.files.has(p);
	read = async (p: string) => {
		if (!this.files.has(p)) throw new Error("ENOENT");
		return this.files.get(p)!;
	};
	write = async (p: string, c: string) => {
		this.files.set(p, c);
	};
	copy = async (s: string, d: string) => {
		this.files.set(d, this.files.get(s)!);
	};
}

const PDF = "papers/foo.pdf";
const appOf = (a: MemAdapter) => ({ vault: { adapter: a } }) as never;

test("appendToNotes creates file with backlink and dedupes by annId", async () => {
	Notice.reset();
	const adapter = new MemAdapter();
	const entry = {
		title: "高亮",
		page: 3,
		quote: "hello",
		content: "content",
		annId: "ann-1",
	};
	assert.equal(await appendToNotes(appOf(adapter), PDF, ".notes.md", entry), true);
	const first = adapter.files.get("papers/foo.notes.md")!;
	assert.ok(first.includes("obsidian://paper-reader?file="));
	assert.ok(first.includes("page=3"));
	assert.ok(first.includes("<!-- pr:ann:ann-1 -->"));

	// duplicate export of the same annotation is skipped, file untouched
	assert.equal(await appendToNotes(appOf(adapter), PDF, ".notes.md", entry), false);
	assert.equal(adapter.files.get("papers/foo.notes.md"), first);
	// different annotation appends without touching earlier content
	const second = { ...entry, annId: "ann-2", content: "more" };
	assert.equal(await appendToNotes(appOf(adapter), PDF, ".notes.md", second), true);
	const merged = adapter.files.get("papers/foo.notes.md")!;
	assert.ok(merged.includes(first));
	assert.ok(merged.includes("more"));
});

test("entries without annId dedupe by content hash", async () => {
	Notice.reset();
	const adapter = new MemAdapter();
	const entry = { title: "翻译", page: 1, quote: "q", content: "c" };
	assert.equal(await appendToNotes(appOf(adapter), PDF, ".notes.md", entry), true);
	assert.equal(await appendToNotes(appOf(adapter), PDF, ".notes.md", entry), false);
});

test("backlinkFor encodes full path; inkBoundingRect works", () => {
	const link = backlinkFor("dir/sub/foo bar.pdf", 7);
	assert.ok(link.startsWith("obsidian://paper-reader?file="));
	assert.ok(link.includes(encodeURIComponent("dir/sub/foo bar.pdf")));
	assert.ok(link.endsWith("page=7"));
	assert.deepEqual(inkBoundingRect([10, 20, 30, 5, 15, 40]), {
		x: 10,
		y: 5,
		width: 20,
		height: 35,
	});
});
