import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs, notices } from "./vmLoad";
import * as readingPositions from "../src/pdfview/readingPositions";
import { llmConfig } from "../src/settings";

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
		"./pdfview/readingPositions": readingPositions,
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
	const secrets = new Map<string, string>();
	const app = {
		secretStorage: {
			getSecret: (id: string) => secrets.get(id) ?? null,
			setSecret: (id: string, secret: string) => { secrets.set(id, secret); },
		},
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

test("settings load copies positions and save retains the newest 200", async () => {
	const plugin = makePlugin([]);
	const persisted = { "saved.pdf": { page: 2, pageFraction: 0.5, updatedAt: 1 } };
	plugin.loadData = async () => ({ readingPositions: persisted });
	await plugin.loadSettings();
	plugin.settings.readingPositions["saved.pdf"].page = 8;
	assert.equal(persisted["saved.pdf"].page, 2);
	for (let i = 0; i < 220; i++) {
		plugin.settings.readingPositions[`${i}.pdf`] = { page: 1, pageFraction: 0, updatedAt: i + 2 };
	}
	let saved: any;
	plugin.saveData = async (settings: any) => { saved = settings; };
	await plugin.saveSettings();
	assert.equal(Object.keys(saved.readingPositions).length, 200);
	assert.equal(saved.readingPositions["19.pdf"], undefined);
	assert.equal(saved.readingPositions["219.pdf"].updatedAt, 221);
});

test("legacy LLM API key migrates to Obsidian secret storage without persisting plaintext", async () => {
	const plugin = makePlugin([]);
	plugin.loadData = async () => ({ llmApiKey: "  sk-legacy  ", llmBaseUrl: "https://example.com/v1", llmModel: "test" });
	let saved: any;
	plugin.saveData = async (settings: any) => { saved = JSON.parse(JSON.stringify(settings)); };
	await plugin.loadSettings();
	const id = plugin.settings.llmApiKeyId;
	assert.equal(id, "paper-reader-llm-api-key");
	assert.equal(plugin.app.secretStorage.getSecret(id), "sk-legacy");
	assert.equal(saved.llmApiKeyId, id);
	assert.equal(saved.llmApiKey, undefined);
	assert.equal(JSON.stringify(saved).includes("sk-legacy"), false);
	assert.equal(llmConfig(plugin.app, plugin.settings).apiKey, "sk-legacy");
	plugin.app.secretStorage.setSecret(id, "sk-rotated");
	assert.equal(llmConfig(plugin.app, plugin.settings).apiKey, "sk-rotated");
});

test("existing secret reference takes precedence over a stale legacy key", async () => {
	const plugin = makePlugin([]);
	plugin.app.secretStorage.setSecret("user-key", "sk-current");
	plugin.loadData = async () => ({ llmApiKey: "sk-old", llmApiKeyId: "user-key" });
	let saved: any;
	plugin.saveData = async (settings: any) => { saved = settings; };
	await plugin.loadSettings();
	assert.equal(plugin.settings.llmApiKeyId, "user-key");
	assert.equal(llmConfig(plugin.app, plugin.settings).apiKey, "sk-current");
	assert.equal(saved.llmApiKey, undefined);
	plugin.settings.llmApiKeyId = "missing";
	assert.equal(llmConfig(plugin.app, plugin.settings).apiKey, "");
});

test("vault deletion clears file and folder records and persists only when changed", async () => {
	const plugin = makePlugin([]);
	let deleteHandler: ((file: { path: string }) => void) | undefined;
	plugin.app.vault.on = (event: string, handler: typeof deleteHandler) => {
		if (event === "delete") deleteHandler = handler;
		return {};
	};
	await plugin.onload();
	plugin.settings.readingPositions = {
		"papers/a.pdf": { page: 1 }, "papers/sub/b.pdf": { page: 2 }, "papers2/c.pdf": { page: 3 },
	};
	let saves = 0;
	plugin.saveSettings = async () => { saves++; };
	deleteHandler!({ path: "papers" });
	assert.deepEqual(Object.keys(plugin.settings.readingPositions), ["papers2/c.pdf"]);
	assert.equal(saves, 1);
	deleteHandler!({ path: "missing.pdf" });
	assert.equal(saves, 1);
	deleteHandler!({ path: "papers2/c.pdf" });
	assert.equal(saves, 2);
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
		refreshPageWindow: async () => {},
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
