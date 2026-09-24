import { GlobalWorkerOptions, getDocument, TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
	PDFDocumentLoadingTask,
	PDFDocumentProxy,
	PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { OutlineNode } from "../outline/OutlineTree";

type PdfOutlineItem = {
	title: string;
	dest: string | unknown[] | null;
	items: PdfOutlineItem[];
};

type PdfRef = { num: number; gen: number };

function isRefProxy(value: unknown): value is PdfRef {
	return typeof value === "object" && value !== null &&
		typeof (value as PdfRef).num === "number" &&
		typeof (value as PdfRef).gen === "number";
}

export interface RenderedPage {
	pageNumber: number;
	/** wrapper element (.pr-page), position: relative */
	wrapper: HTMLElement;
	/** absolutely positioned overlay holding highlight rects */
	highlightLayer: HTMLElement;
	/** transient overlay for the active text selection */
	selectionLayer: HTMLElement;
	/** absolutely positioned SVG holding pen strokes */
	inkLayer: SVGSVGElement;
	/** unscaled page size (viewport at scale 1) */
	widthAtScale1: number;
	heightAtScale1: number;
}

/** Point GlobalWorkerOptions at the worker bundle shipped next to main.js. */
export function configurePdfWorker(workerUrl: string): void {
	GlobalWorkerOptions.workerSrc = workerUrl;
}

export class PdfRenderer {
	private doc: PDFDocumentProxy | null = null;
	private loadingTask: PDFDocumentLoadingTask | null = null;
	/** joined extracted text per page, used for offset + context fingerprint */
	private pageTexts = new Map<number, string>();
	/** cached page proxies shared by main rendering and thumbnails */
	private pageCache = new Map<number, Promise<PDFPageProxy>>();

	get numPages(): number {
		return this.doc?.numPages ?? 0;
	}

	getPageText(pageNumber: number): string | undefined {
		return this.pageTexts.get(pageNumber);
	}

	/** Extract and cache a page's text, even if the page was never rendered. */
	async getPageTextEnsured(pageNumber: number): Promise<string> {
		const cached = this.pageTexts.get(pageNumber);
		if (cached !== undefined) return cached;
		const page = await this.getPage(pageNumber);
		const tc = await page.getTextContent();
		const joined = tc.items.map((i) => ("str" in i ? i.str : "")).join("");
		this.pageTexts.set(pageNumber, joined);
		return joined;
	}

	async load(data: ArrayBuffer): Promise<void> {
		await this.destroy();
		this.loadingTask = getDocument({ data });
		this.doc = await this.loadingTask.promise;
	}

	async destroy(): Promise<void> {
		if (this.loadingTask) {
			await this.loadingTask.destroy();
			this.loadingTask = null;
			this.doc = null;
		}
		this.pageTexts.clear();
		this.pageCache.clear();
	}

	private getPage(pageNumber: number): Promise<PDFPageProxy> {
		if (!this.doc) throw new Error("no document loaded");
		let p = this.pageCache.get(pageNumber);
		if (!p) {
			p = this.doc.getPage(pageNumber);
			this.pageCache.set(pageNumber, p);
		}
		return p;
	}

	/** Unscaled page dimensions (viewport at scale 1) without rendering. */
	async getPageDims(
		pageNumber: number
	): Promise<{ width: number; height: number }> {
		const page = await this.getPage(pageNumber);
		const v = page.getViewport({ scale: 1 });
		return { width: v.width, height: v.height };
	}

	/** PDF outline (bookmarks) resolved to 1-based page numbers; null if none. */
	async getOutline(): Promise<OutlineNode[] | null> {
		if (!this.doc) return null;
		const doc = this.doc;
		const raw = await doc.getOutline() as PdfOutlineItem[] | null;
		if (!raw || raw.length === 0) return null;

		const resolve = async (items: PdfOutlineItem[]): Promise<OutlineNode[]> => {
			const out: OutlineNode[] = [];
			for (const item of items) {
				let page: number | null = null;
				try {
					const dest =
						typeof item.dest === "string"
							? await doc.getDestination(item.dest)
							: item.dest;
					if (Array.isArray(dest) && isRefProxy(dest[0])) {
						page = (await doc.getPageIndex(dest[0])) + 1;
					}
				} catch {
					// unresolvable destination: keep page null
				}
				out.push({
					title: item.title || "(未命名)",
					page,
					children: await resolve(item.items ?? []),
				});
			}
			return out;
		};
		return resolve(raw);
	}

	/** Render a small canvas for the thumbnail sidebar. */
	async renderThumbnail(
		pageNumber: number,
		targetWidth: number
	): Promise<HTMLCanvasElement> {
		const page = await this.getPage(pageNumber);
		const base = page.getViewport({ scale: 1 });
		const viewport = page.getViewport({ scale: targetWidth / base.width });
		const dpr = Math.max(window.devicePixelRatio || 1, 1);
		const canvas = createEl("canvas");
		canvas.width = Math.floor(viewport.width * dpr);
		canvas.height = Math.floor(viewport.height * dpr);
		canvas.style.width = `${Math.floor(viewport.width)}px`;
		canvas.style.height = `${Math.floor(viewport.height)}px`;
		await page.render({
			canvas,
			viewport,
			transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
		}).promise;
		return canvas;
	}

	/**
	 * Render one page into a fresh wrapper element:
	 * canvas (bottom) -> text layer (selection) -> highlight layer (top).
	 */
	async renderPage(pageNumber: number, scale: number): Promise<RenderedPage> {
		if (!this.doc) throw new Error("no document loaded");
		const page = await this.getPage(pageNumber);
		const viewport = page.getViewport({ scale });
		const baseViewport = page.getViewport({ scale: 1 });

		const wrapper = createDiv({ cls: "pr-page" });
		wrapper.dataset.pageNumber = String(pageNumber);
		wrapper.style.width = `${Math.floor(viewport.width)}px`;
		wrapper.style.height = `${Math.floor(viewport.height)}px`;
		// CSS vars expected by pdf.js v6 text layer styles
		wrapper.style.setProperty("--total-scale-factor", String(scale));
		wrapper.setCssProps({ "--scale-round-x": "1px", "--scale-round-y": "1px" });

		const canvas = wrapper.createEl("canvas", { cls: "pr-canvas" });
		const outputScale = Math.max(window.devicePixelRatio || 1, 1);
		canvas.width = Math.floor(viewport.width * outputScale);
		canvas.height = Math.floor(viewport.height * outputScale);
		canvas.style.width = `${Math.floor(viewport.width)}px`;
		canvas.style.height = `${Math.floor(viewport.height)}px`;
		await page.render({
			canvas,
			viewport,
			transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
		}).promise;

		const textLayerEl = wrapper.createDiv({ cls: "textLayer" });
		const textLayer = new TextLayer({
			textContentSource: page.streamTextContent(),
			container: textLayerEl,
			viewport,
		});
		await textLayer.render();

		// cache extracted text for selection fingerprinting
		const textContent = await page.getTextContent();
		const joined = textContent.items
			.map((item) => ("str" in item ? item.str : ""))
			.join("");
		this.pageTexts.set(pageNumber, joined);

		const highlightLayer = wrapper.createDiv({ cls: "pr-highlight-layer" });
		const selectionLayer = wrapper.createDiv({ cls: "pr-selection-layer" });

		const inkLayer = createSvg("svg");
		inkLayer.classList.add("pr-ink-layer");
		wrapper.appendChild(inkLayer);

		return {
			pageNumber,
			wrapper,
			highlightLayer,
			selectionLayer,
			inkLayer,
			widthAtScale1: baseViewport.width,
			heightAtScale1: baseViewport.height,
		};
	}
}
