import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs, notices } from "./vmLoad";

// ---- helpers ----

class FakeTFile {
	constructor(readonly path: string) {}
	get extension(): string {
		return "pdf";
	}
}

let protocolHandler: ((params: Record<string, string>) => void) | null = null;

class PluginStub {
	app: unknown;
	manifest: unknown;
	settings: Record<string, unknown> = {};
	constructor(app: unknown, manifest: unknown) {
		this.app = app;
		this.manifest = manifest;
	}
	registerView() {}
	register() {}
	registerExtensions() {}
	registerEvent() {}
	addRibbonIcon() {}
	addCommand() {}
	addSettingTab() {}
	registerObsidianProtocolHandler(action: string, handler: never) {
		protocolHandler = handler;
	}
	loadData() {
		return Promise.resolve(null);
	}
	saveData() {
		return Promise.resolve();
	}
}

function makePlugin(files: FakeTFile[]) {
	const { default: PluginClass } = loadTs("src/main.ts", {
		"./pdfview/worker": { configureBundledPdfWorker: () => () => {} },
		"./pdfview/PdfRenderer": { configurePdfWorker: () => {} },
		"./pdfview/PaperReaderView": {
			PaperReaderView: class {},
			VIEW_TYPE_PAPER_READER: "paper-reader-view",
		},
		"./settings": {
			DEFAULT_SETTINGS: {
				highlightColors: {},
				readingPositions: {},
				useAsDefaultPdfViewer: false,
			},
			PaperReaderSettingTab: class {},
		},
		obsidian: {
			Plugin: PluginStub,
			Notice: class {
				constructor(m: string) {
					notices.push(m);
				}
			},
			TFile: FakeTFile,
			Menu: class {},
			normalizePath: (p: string) => p,
		},
	});
	const app = {
		vault: {
			adapter: { getResourcePath: (p: string) => p },
			getAbstractFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
			on: () => ({}),
		},
		workspace: {
			on: () => ({}),
			getActiveFile: () => null,
			getLeaf: () => ({ setViewState: () => Promise.resolve() }),
			revealLeaf: () => {},
			requestSaveLayout: () => {},
		},
	};
	const plugin = new PluginClass(app, { id: "paper-reader", dir: "." });
	return plugin;
}

// ---- 缺陷 1: real protocol dispatch ----

test("obsidian://paper-reader dispatch opens the right file and page", async () => {
	notices.length = 0;
	protocolHandler = null;
	const f1 = new FakeTFile("dir1/paper.pdf");
	const f2 = new FakeTFile("dir2/paper.pdf");
	const plugin = makePlugin([f1, f2]);
	const opened: [unknown, unknown][] = [];
	plugin.openPdf = (file: unknown, page?: number) => {
		opened.push([file, page]);
		return Promise.resolve();
	};
	await plugin.onload();
	assert.ok(protocolHandler, "protocol handler must be registered");

	// same-named PDFs in two folders: full path decides
	protocolHandler!({ file: "dir2/paper.pdf", page: "7" });
	assert.equal(opened.length, 1);
	assert.equal(opened[0][0], f2);
	assert.equal(opened[0][1], 7);

	// missing file -> friendly Notice, no open
	protocolHandler!({ file: "dir9/none.pdf", page: "1" });
	assert.equal(opened.length, 1);
	assert.ok(notices.some((m) => m.includes("找不到来源文件")));
});

test("rename migrates the reading position record", async () => {
	const plugin = makePlugin([]);
	plugin.settings = {
		readingPositions: { "old/a.pdf": { page: 9, pageFraction: 0.5 } },
	};
	let saved = false;
	plugin.saveSettings = async () => {
		saved = true;
	};
	await plugin.migrateReadingPosition("old/a.pdf", "new/a.pdf");
	assert.deepEqual(plugin.settings.readingPositions, {
		"new/a.pdf": { page: 9, pageFraction: 0.5 },
	});
	assert.equal(saved, true);
	// unknown old path: no-op
	await plugin.migrateReadingPosition("nope.pdf", "x.pdf");
	assert.deepEqual(Object.keys(plugin.settings.readingPositions), ["new/a.pdf"]);
});

// ---- 缺陷 2: single-page restore ----

function viewStub() {
	const { PaperReaderView } = loadTs("src/pdfview/PaperReaderView.ts", {
		"../history/AnnotationHistory": {
			AnnotationHistory: class {},
			cloneAnnotation: (a: unknown) => structuredClone(a),
		},
	});
	return Object.create(PaperReaderView.prototype);
}

test("prepareSavedLayout applies saved page in all layout modes, clamped", () => {
	for (const mode of ["continuous", "single", "double-odd"]) {
		const view = viewStub();
		Object.assign(view, {
			renderer: { numPages: 27 },
			layoutMode: "continuous",
			zoomMode: "fit-width",
			scale: 1,
			currentPage: 1,
		});
		view.prepareSavedLayout({
			page: 15,
			pageFraction: 0.4,
			zoomMode: "fit-width",
			scale: 1,
			layoutMode: mode,
			updatedAt: 0,
		});
		assert.equal(view.layoutMode, mode);
		assert.equal(view.currentPage, 15, `${mode} must pre-seed the saved page`);
	}
	// out-of-range page clamps to numPages
	const view = viewStub();
	Object.assign(view, { renderer: { numPages: 27 }, layoutMode: "", zoomMode: "", scale: 1, currentPage: 1 });
	view.prepareSavedLayout({ page: 99, pageFraction: 0, zoomMode: "fit-width", scale: 1, layoutMode: "single", updatedAt: 0 });
	assert.equal(view.currentPage, 27);
});

test("restorePosition scrolls to saved page fraction and reports the page", async () => {
	const view = viewStub();
	const calls: number[] = [];
	Object.assign(view, {
		renderer: { numPages: 27 },
		pages: [{ pageNumber: 15, wrapper: { offsetTop: 100, offsetHeight: 800 } }],
		scrollEl: { scrollTop: 0, clientHeight: 600 },
		restoringPosition: false,
		updateCurrentPage: (p: number) => calls.push(p),
	});
	await view.restorePosition({
		page: 15,
		pageFraction: 0.5,
		zoomMode: "fit-width",
		scale: 1,
		layoutMode: "single",
		updatedAt: 0,
	});
	assert.equal(view.scrollEl.scrollTop, 100 + 400 - 300);
	assert.deepEqual(calls, [15]);
	// missing rendered page: safe no-op
	await view.restorePosition({ page: 99, pageFraction: 0, zoomMode: "", scale: 1, layoutMode: "single", updatedAt: 0 });
	assert.equal(view.scrollEl.scrollTop, 100 + 400 - 300);
});

// ---- 缺陷 3: same-name isolation ----

test("savedPositionFor: same-named PDFs stay isolated, no basename fallback", () => {
	const view = viewStub();
	Object.assign(view, {
		plugin: {
			settings: {
				readingPositions: {
					"dir1/paper.pdf": { page: 3, pageFraction: 0.1 },
					"dir2/paper.pdf": { page: 20, pageFraction: 0.9 },
				},
			},
		},
	});
	assert.equal(view.savedPositionFor("dir1/paper.pdf").page, 3);
	assert.equal(view.savedPositionFor("dir2/paper.pdf").page, 20);
	// unrecorded same-basename path must NOT inherit another file's position
	assert.equal(view.savedPositionFor("dir3/paper.pdf"), undefined);
});
