// Browser harness bundling the plugin's real modules for Playwright acceptance.
// Obsidian DOM helper polyfills are installed before any plugin code runs.

function svgElement(tag: string, o?: { attr?: Record<string, string | number> }): SVGElement {
	const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
	for (const [key, value] of Object.entries(o?.attr ?? {})) el.setAttribute(key, String(value));
	return el;
}
function decorate(): void {
	Element.prototype.createSvg = function (tag: string, o?: { attr?: Record<string, string | number> }) {
		return this.appendChild(svgElement(tag, o));
	} as typeof Element.prototype.createSvg;
	(globalThis as Record<string, unknown>).createSvg = svgElement;
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.setCssStyles = function (styles: Partial<CSSStyleDeclaration>) { Object.assign(this.style, styles); };
	proto.setCssProps = function (props: Record<string, string>) {
		for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
	};
	proto.createDiv = function (o?: { cls?: string }) {
		const d = document.createElement("div");
		if (o?.cls) d.className = o.cls;
		this.appendChild(d);
		return d;
	};
	proto.createEl = function (tag: string, o?: { cls?: string; attr?: Record<string, string> }) {
		const d = document.createElement(tag);
		if (o?.cls) d.className = o.cls;
		if (o?.attr) for (const [k, v] of Object.entries(o.attr)) d.setAttribute(k, v);
		this.appendChild(d);
		return d;
	};
	proto.createSpan = function (o?: { cls?: string }) {
		const d = document.createElement("span");
		if (o?.cls) d.className = o.cls;
		this.appendChild(d);
		return d;
	};
	proto.addClass = function (cls: string) {
		this.classList.add(cls);
	};
	proto.removeClass = function (cls: string) {
		this.classList.remove(cls);
	};
	proto.toggleClass = function (cls: string, force?: boolean) {
		this.classList.toggle(cls, force);
	};
	proto.hasClass = function (cls: string) {
		return this.classList.contains(cls);
	};
	proto.setAttr = function (k: string, v: string) {
		this.setAttribute(k, v);
	};
	proto.setText = function (t: string) {
		this.textContent = t;
	};
	proto.empty = function () {
		this.replaceChildren();
	};
}
decorate();
// Obsidian's global DOM factory helpers
(globalThis as Record<string, unknown>).createDiv = (o?: { cls?: string }) => {
	const d = document.createElement("div");
	if (o?.cls) d.className = o.cls;
	return d;
};
(globalThis as Record<string, unknown>).createSpan = (o?: { cls?: string }) => {
	const d = document.createElement("span");
	if (o?.cls) d.className = o.cls;
	return d;
};
(globalThis as Record<string, unknown>).createEl = (
	tag: string,
	o?: { cls?: string }
) => {
	const d = document.createElement(tag);
	if (o?.cls) d.className = o.cls;
	return d;
};
configureBundledPdfWorker();

import { configureBundledPdfWorker } from "../../src/pdfview/worker";
import { PdfRenderer, configurePdfWorker } from "../../src/pdfview/PdfRenderer";
import { selectionToPayload, SelectionPayload } from "../../src/pdfview/selection";
import { renderHighlightRects } from "../../src/pdfview/HighlightLayer";
import {
	Annotation,
	AnnotationFile,
	AnnotationStore,
	annotationFromPayload,
} from "../../src/storage/annotationStore";
import { appendToNotes } from "../../src/storage/notesWriter";
import { LlmClient } from "../../src/llm/client";
import { buildTranslateMessages } from "../../src/llm/prompts";
import {
	LiveStroke,
	beginInkStroke,
	inkBoundingRect,
	renderInkStrokes,
} from "../../src/pdfview/InkLayer";
import { AnnotationHistory } from "../../src/history/AnnotationHistory";
import { AnnotationList, inkPreviewSvg } from "../../src/pdfview/AnnotationList";
import { findHits } from "../../src/search/searchText";

class MemAdapter {
	files = new Map<string, string>();
	exists = async (p: string) => this.files.has(p);
	read = async (p: string) => {
		if (!this.files.has(p)) throw new Error("ENOENT " + p);
		return this.files.get(p)!;
	};
	write = async (p: string, c: string) => {
		this.files.set(p, c);
	};
	copy = async (s: string, d: string) => {
		this.files.set(d, this.files.get(s)!);
	};
}

const SCALE = 1.5;
const PDF_PATH = "05-论文/paper.pdf";

class Harness {
	useWorker(url: string): void { configurePdfWorker(url); }
	adapter = new MemAdapter();
	app = { vault: { adapter: this.adapter } };
	renderer = new PdfRenderer();
	store = new AnnotationStore(this.app as never, () => ".annotations.json");
	data: AnnotationFile = { version: 1, file: "paper.pdf", annotations: [] };
	highlightLayer: HTMLElement | null = null;
	pageEl: HTMLElement | null = null;
	private clickedHighlightId: string | null = null;

	async loadPdf(): Promise<number> {
		const res = await fetch("/paper.pdf");
		const buf = await res.arrayBuffer();
		await this.renderer.load(buf);
		await this.renderPage(1);
		this.data = await this.store.load(PDF_PATH);
		return this.renderer.numPages;
	}

	private async renderPage(n: number): Promise<void> {
		const rendered = await this.renderer.renderPage(n, SCALE);
		document.body.appendChild(rendered.wrapper);
		this.pageEl = rendered.wrapper;
		this.highlightLayer = rendered.highlightLayer;
	}

	selectText(needle: string, from = 0, to = 10): SelectionPayload {
		const spans = Array.from(
			this.pageEl!.querySelectorAll(".textLayer span")
		) as HTMLElement[];
		const span = spans.find((s) => (s.textContent || "").includes(needle));
		if (!span || !span.firstChild) throw new Error("span not found: " + needle);
		const tn = span.firstChild;
		const range = document.createRange();
		range.setStart(tn, from);
		range.setEnd(tn, Math.min(to, tn.textContent!.length));
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		sel.addRange(range);
		const payload = selectionToPayload(sel, SCALE, (p) => this.renderer.getPageText(p));
		if (!payload) throw new Error("selectionToPayload returned null");
		return payload;
	}

	async underlineTitle(scale: number, reverse: boolean): Promise<number> {
		this.pageEl?.remove();
		const page = await this.renderer.renderPage(1, scale);
		document.body.appendChild(page.wrapper);
		this.pageEl = page.wrapper;
		this.highlightLayer = page.highlightLayer;
		const spans = Array.from(page.wrapper.querySelectorAll(".textLayer span"));
		const first = spans.find(s => s.textContent?.startsWith("LandslideAgent"))!.firstChild!;
		const last = spans.find(s => s.textContent?.startsWith("Autonomous Landslide"))!.firstChild!;
		const selection = window.getSelection()!;
		if (reverse) selection.setBaseAndExtent(last, last.textContent!.length, first, 0);
		else selection.setBaseAndExtent(first, 0, last, last.textContent!.length);
		const payload = selectionToPayload(selection, scale, p => this.renderer.getPageText(p))!;
		const annotation = annotationFromPayload(payload, { type: "highlight", color: "red", style: "underline" });
		this.clickedHighlightId = null;
		renderHighlightRects(page.highlightLayer, [annotation], scale, { red: "#F26D6D" }, (ann) => {
			this.clickedHighlightId = ann.id;
		});
		return page.highlightLayer.querySelectorAll(".pr-line-rect").length;
	}

	lastHighlightClick(): string | null {
		return this.clickedHighlightId;
	}

	private redraw(): void {
		renderHighlightRects(
			this.highlightLayer!,
			this.data.annotations,
			SCALE,
			{ yellow: "#F5C542" },
			() => {}
		);
	}

	async addNote(payload: SelectionPayload, noteText: string): Promise<string> {
		const ann = annotationFromPayload(payload, {
			type: "note",
			color: "yellow",
			style: "highlight",
			note: noteText,
		});
		this.data.annotations.push(ann);
		await this.store.save(PDF_PATH, this.data);
		this.redraw();
		return ann.id;
	}

	async editNote(id: string, newText: string): Promise<void> {
		const ann = this.data.annotations.find((a) => a.id === id);
		if (!ann) throw new Error("annotation not found");
		ann.note = newText;
		await this.store.save(PDF_PATH, this.data);
		this.redraw();
	}

	renderedNoteInfo(): { rects: number; icons: number } {
		return {
			rects: document.querySelectorAll(".pr-note-rect").length,
			icons: document.querySelectorAll(".pr-note-icon").length,
		};
	}

	/** simulate close + reopen: fresh store loads from the same adapter */
	async reloadFromDisk(): Promise<{ annotations: number; note?: string }> {
		const fresh = new AnnotationStore(this.app as never, () => ".annotations.json");
		this.data = await fresh.load(PDF_PATH);
		this.redraw();
		const note = this.data.annotations.find((a) => a.type === "note");
		return { annotations: this.data.annotations.length, note: note?.note };
	}

	async translate(payload: SelectionPayload): Promise<string> {
		// mock LLM via SSE fetch interception
		const sse = [
			'data: {"choices":[{"delta":{"content":"滑坡"}}]}',
			'data: {"choices":[{"delta":{"content":"智能体"}}]}',
			"data: [DONE]",
		].join("\n\n");
		window.fetch = async () =>
			new Response(sse, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		const client = new LlmClient(() => ({
			baseUrl: "https://mock.local/v1/",
			apiKey: "sk-test",
			model: "mock-model",
		}));
		let out = "";
		for await (const chunk of client.streamChat(
			buildTranslateMessages(payload.text, "中文")
		)) {
			out += chunk;
		}
		// record annotation from the payload snapshot (mirrors the view flow)
		this.data.annotations.push(
			annotationFromPayload(payload, {
				type: "translation",
				color: "",
				aiContent: out,
			})
		);
		await this.store.save(PDF_PATH, this.data);
		return out;
	}

	/** draw a stroke on page 1 via the real InkLayer, persist, render */
	async drawStroke(): Promise<{ id: string; paths: number }> {
		const inkLayer = this.pageEl!.querySelector("svg.pr-ink-layer") as SVGSVGElement;
		const live: LiveStroke = beginInkStroke(inkLayer, "#F5C542", 4, SCALE, 100, 100);
		for (let i = 1; i <= 10; i++) live.addPoint(100 + i * 8, 100 + Math.sin(i) * 10);
		const ink = live.finish();
		if (!ink) throw new Error("stroke.finish returned null");
		const ann: Annotation = {
			id: crypto.randomUUID(),
			type: "ink",
			page: 1,
			rects: [inkBoundingRect(ink.points)],
			text: "",
			color: "yellow",
			ink,
			createdAt: new Date().toISOString(),
			textOffset: -1,
			contextBefore: "",
			contextAfter: "",
		};
		this.data.annotations.push(ann);
		this.history.push({ kind: "add", ann });
		await this.store.save(PDF_PATH, this.data);
		this.redrawInkAll();
		return { id: ann.id, paths: this.pageEl!.querySelectorAll(".pr-ink-path").length };
	}

	private redrawInkAll(): void {
		const inkLayer = this.pageEl!.querySelector("svg.pr-ink-layer") as SVGSVGElement;
		renderInkStrokes(
			inkLayer,
			this.data.annotations.filter((a) => a.type === "ink" && a.page === 1),
			SCALE,
			{ yellow: "#F5C542" },
			() => {},
			null
		);
	}

	/** AnnotationHistory wired exactly like the view's applyHistoryOp */
	history = new AnnotationHistory(async (op, dir) => {
		const anns = this.data.annotations;
		if (op.kind === "add") {
			this.data.annotations =
				dir === "undo" ? anns.filter((a) => a.id !== op.ann.id) : [...anns, op.ann];
		} else if (op.kind === "remove") {
			if (dir === "undo") {
				const list = [...anns];
				op.anns.forEach((a, i) => list.splice(Math.min(op.indexes[i], list.length), 0, a));
				this.data.annotations = list;
			} else {
				const ids = new Set(op.anns.map((a) => a.id));
				this.data.annotations = anns.filter((a) => !ids.has(a.id));
			}
		} else {
			const t = dir === "undo" ? op.before : op.after;
			this.data.annotations = anns.map((a) => (a.id === t.id ? t : a));
		}
		const ok = await this.store.save(PDF_PATH, this.data);
		this.redraw();
		this.redrawInkAll();
		return ok;
	}, () => {});

	async deleteAnnotation(id: string): Promise<void> {
		const idx = this.data.annotations.findIndex((a) => a.id === id);
		if (idx < 0) throw new Error("not found");
		const removed = this.data.annotations[idx];
		this.data.annotations = this.data.annotations.filter((a) => a.id !== id);
		this.history.push({ kind: "remove", anns: [removed], indexes: [idx] });
		await this.store.save(PDF_PATH, this.data);
		this.redraw();
		this.redrawInkAll();
	}

	inkInfo(): { paths: number; anns: number } {
		return {
			paths: document.querySelectorAll(".pr-ink-path").length,
			anns: this.data.annotations.filter((a) => a.type === "ink").length,
		};
	}

	async searchAll(query: string): Promise<{ total: number; firstPage: number }> {
		const texts: (string | undefined)[] = [];
		for (let p = 1; p <= this.renderer.numPages; p++) {
			texts.push(await this.renderer.getPageTextEnsured(p));
		}
		const hits = findHits(texts, query);
		return { total: hits.length, firstPage: hits[0]?.page ?? 0 };
	}

	buildAnnotationList(): { items: number } {
		const host = document.createElement("div");
		document.body.appendChild(host);
		let selected: string | null = null;
		const list = new AnnotationList(
			{ onSelect: (a) => { selected = a.id; }, onExport: () => {}, onExportAll: () => {} },
			() => ({ yellow: "#F5C542" })
		);
		host.appendChild(list.el);
		list.build(this.data.annotations);
		const first = list.el.querySelector(".pr-ann-item") as HTMLElement | null;
		first?.click();
		return { items: list.el.querySelectorAll(".pr-ann-item").length };
	}

	async insertNotes(payload: SelectionPayload, translation: string): Promise<string> {
		await appendToNotes(this.app as never, PDF_PATH, ".notes.md", {
			title: "翻译",
			page: payload.page,
			quote: payload.text,
			content: translation,
		});
		return this.adapter.files.get("05-论文/paper.notes.md") ?? "";
	}
}

(window as unknown as Record<string, unknown>).__h = new Harness();
(window as unknown as Record<string, unknown>).__inkPreview = inkPreviewSvg;
