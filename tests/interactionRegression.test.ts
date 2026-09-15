import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

// Load actual class methods with DOM/Obsidian boundaries stubbed, no live API calls.
const ts = createRequire(process.cwd() + "/package.json")("typescript");
const notices: string[] = [];
const obsidian = {
	Notice: class { constructor(message: string) { notices.push(message); } },
	ItemView: class {}, setIcon() {},
	MarkdownRenderer: { render: async () => {} },
};
function load(path: string, imports: Record<string, unknown> = {}): any {
	const exports = {};
	const source = ts.transpileModule(readFileSync(path, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	}).outputText;
	runInNewContext(source, {
		exports, require: (name: string) => imports[name] ?? obsidian,
		document: { body: element() }, window: { innerWidth: 1000, innerHeight: 1000 },
		DOMRect: class {}, crypto,
	});
	return exports;
}
function element(): any {
	return {
		style: {}, value: "", createDiv: element, createEl: element, createSpan: element,
		addEventListener() {}, setAttr() {}, addClass() {}, removeClass() {},
		setText(text: string) { this.text = text; }, empty() {}, focus() {},
		appendChild() {}, remove() {}, getBoundingClientRect: () => ({ width: 200, height: 100 }),
	};
}
function deferred() {
	let resolve!: (value: string) => void;
	const promise = new Promise<string>(r => { resolve = r; });
	return { promise, resolve };
}
const A = { page: 1, text: "A", rects: [], anchorRect: { left: 0, top: 0, bottom: 10 } };
const B = { ...A, page: 2, text: "B" };

test("real popup: old completion cannot overwrite new translation or cache", async () => {
	const { SelectionPopup } = load("src/toolbar/SelectionPopup.ts", {
		"../settings": { COLOR_KEYS: ["yellow"] },
		"../pdfview/popupCache": { popupCacheKey: (p: typeof A) => p.text },
	});
	const a = deferred(), b = deferred(), cache = new Map();
	const popup = new SelectionPopup({
		getColors: () => ({}), getStyle: () => "highlight", getCached: (k: string) => cache.get(k),
		setCached: (k: string, v: unknown) => cache.set(k, v),
		translate: (p: typeof A) => p.text === "A" ? a.promise : b.promise,
	});
	popup.show(A);
	assert.equal(popup.payloadSnapshot, A);
	const first = popup.runTranslate();
	popup.show(B);
	const second = popup.runTranslate();
	a.resolve("translation A"); await first;
	assert.equal(popup.translating, true);
	assert.equal(cache.has("B"), false);
	b.resolve("translation B"); await second;
	assert.equal(popup.lastTranslation, "translation B");
	assert.equal(cache.get("B").translation, "translation B");
});

test("real panel: switching selection or closing invalidates the pending answer", async () => {
	const { AnswerPanel } = load("src/panel/AnswerPanel.ts");
	const a = deferred(), b = deferred();
	const recorded: unknown[] = [];
	const panel = Object.create(AnswerPanel.prototype);
	Object.assign(panel, {
		generation: 0, streaming: false, history: [], bodyEl: element(), titleEl: element(), el: element(),
		mode: "translate", payload: A, getSourcePath: () => "",
		callbacks: { onAnswered: (...args: unknown[]) => recorded.push(args) },
		llm: { async *streamChat(messages: string[]) { yield await (messages[0] === "A" ? a.promise : b.promise); } },
	});
	const first = panel.run(["A"]);
	panel.start("translate", B, "");
	const second = panel.run(["B"]);
	a.resolve("answer A"); await first;
	assert.equal(panel.streaming, true);
	assert.equal(recorded.length, 0);
	b.resolve("answer B"); await second;
	assert.deepEqual(recorded[0], ["translate", B, "answer B"]);
	const pending = panel.run(["B"]);
	panel.close(); await pending;
	assert.equal(recorded.length, 1);
	assert.equal(panel.lastAnswer, "");
});

test("real submitNote: failed add/edit keeps draft, emits no success, retry saves once", async () => {
	const { PaperReaderView } = load("src/pdfview/PaperReaderView.ts", {
		"../storage/annotationStore": { annotationFromPayload: (p: unknown, f: unknown) => ({ ...p as object, ...f as object, id: "draft" }) },
		"../history/AnnotationHistory": {
			AnnotationHistory: class { push() {} clear() {} },
			cloneAnnotation: (a: unknown) => structuredClone(a),
		},
	});
	let saved = false, hidden = false;
	const view = Object.create(PaperReaderView.prototype);
	Object.assign(view, {
		editingNoteId: null, file: { path: "paper.pdf" }, data: { annotations: [] }, pages: [],
		popup: { payloadSnapshot: A, hide: () => { hidden = true; } },
		history: { push() {} },
		store: { save: async () => saved }, redrawAllHighlights() {}, clearSelection() {},
	});
	notices.length = 0;
	assert.equal(await view.submitNote("draft"), false);
	assert.equal(await view.submitNote("edited draft"), false);
	assert.equal(view.data.annotations.length, 1);
	assert.equal(view.data.annotations[0].note, "edited draft");
	assert.equal(hidden, false);
	assert.equal(notices.length, 0);
	saved = true;
	assert.equal(await view.submitNote("edited draft"), true);
	assert.equal(view.data.annotations.length, 1);
	assert.equal(hidden, true);
	assert.deepEqual(notices, ["批注已更新"]);
});
