import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs, elementStub, obsidianStub } from "./vmLoad";

test("closing search cancels pending debounce before it can restart the scan", async () => {
	const { PaperReaderView } = loadTs("src/pdfview/PaperReaderView.ts");
	const view = Object.create(PaperReaderView.prototype);
	let searches = 0;
	Object.assign(view, { pages: [], searchToken: 0, searchDebounce: setTimeout(() => searches++, 5) });
	view.closeSearch();
	await new Promise(r => setTimeout(r, 15));
	assert.equal(searches, 0); assert.equal(view.searchDebounce, null);
});

test("old thumbnail completion wakes the new generation without exceeding capacity", async () => {
	const { ThumbnailSidebar } = loadTs("src/pdfview/ThumbnailSidebar.ts");
	const sidebar = Object.create(ThumbnailSidebar.prototype);
	let active = 0, peak = 0;
	const releases: (() => void)[] = [];
	Object.assign(sidebar, { generation: 1, inflight: 0, queue: [], queued: new Set(), rendered: new Set(),
		renderThumb: async () => { peak = Math.max(peak, ++active); await new Promise<void>(r => releases.push(r)); active--; } });
	sidebar.enqueue(1, 1); sidebar.enqueue(2, 1);
	sidebar.generation = 2; sidebar.queue = []; sidebar.queued.clear();
	sidebar.enqueue(3, 2); sidebar.enqueue(4, 2);
	releases[0](); releases[1]();
	for (let i = 0; i < 8; i++) await Promise.resolve();
	assert.equal(releases.length, 4, "queued new pages start without another observer event");
	assert.equal(peak, 2);
	releases[2](); releases[3]();
});

test("cleared and closed answers release their Markdown children", async () => {
	const { AnswerPanel } = loadTs("src/panel/AnswerPanel.ts", {
		obsidian: { ...obsidianStub, Component: class {} },
	});
	const panel = Object.create(AnswerPanel.prototype), children = new Set();
	const body = { ...elementStub(), querySelectorAll: () => [] };
	Object.assign(panel, { generation: 0, streaming: false, history: [], payload: {}, mode: "explain", bodyEl: body, el: elementStub(),
		component: { addChild: (c: unknown) => { children.add(c); return c; }, removeChild: (c: unknown) => children.delete(c) },
		getSourcePath: () => "test.pdf", llm: { async *streamChat() { yield "answer"; } }, callbacks: { onAnswered() {} } });
	for (let i = 0; i < 20; i++) { await panel.run([]); panel.clearConversation(); }
	assert.equal(children.size, 0);
	await panel.run([]); panel.close(); assert.equal(children.size, 0);
});
