import type { PdfRenderer } from "./PdfRenderer";
import { OutlineNode, OutlineTree } from "../outline/OutlineTree";
import { AnnotationList, AnnotationListCallbacks } from "./AnnotationList";
import type { Annotation } from "../storage/annotationStore";

const THUMB_WIDTH = 140;
const MAX_CONCURRENT = 2;
// render thumbs a bit before they scroll into view
const OBSERVER_MARGIN = "240px";
// placeholder aspect ratio (A4 portrait) until the real canvas arrives
const PLACEHOLDER_RATIO = 1.414;

export type SidebarMode = "thumbs" | "outline" | "annotations";

export interface ThumbnailSidebarOptions {
	onSelect: (page: number) => void;
	annotationList?: AnnotationListCallbacks;
	getColors?: () => Record<string, string>;
}

/**
 * Left sidebar with two modes: page thumbnails (lazy-rendered via
 * IntersectionObserver + bounded queue) and a collapsible outline tree.
 * Both modes reuse the shared PdfRenderer document instance.
 */
export class ThumbnailSidebar {
	readonly el: HTMLElement;
	private listEl: HTMLElement;
	private mode: SidebarMode = "thumbs";
	private followOutline = false;

	private items = new Map<number, HTMLElement>();
	private observer: IntersectionObserver | null = null;
	private outlineTree: OutlineTree | null = null;
	private annList: AnnotationList | null = null;

	private queue: number[] = [];
	private queued = new Set<number>();
	private rendered = new Set<number>();
	private inflight = 0;
	private generation = 0;
	private currentPage = 0;

	constructor(
		private renderer: PdfRenderer,
		private options: ThumbnailSidebarOptions
	) {
		this.el = createDiv({ cls: "pr-sidebar" });
		this.listEl = this.el.createDiv({ cls: "pr-thumb-list" });
	}

	getMode(): SidebarMode {
		return this.mode;
	}

	showThumbs(numPages: number): void {
		this.mode = "thumbs";
		this.listEl.removeClass("pr-mode-outline");
		this.reset();
		const gen = this.generation;
		for (let p = 1; p <= numPages; p++) {
			const item = this.listEl.createDiv({ cls: "pr-thumb" });
			item.dataset.pageNumber = String(p);
			// reserve space with an approximate aspect ratio, corrected on render
			item.style.height = `${Math.round(THUMB_WIDTH * PLACEHOLDER_RATIO)}px`;
			const badge = item.createDiv({ cls: "pr-thumb-badge" });
			badge.setText(String(p));
			item.addEventListener("click", () => this.options.onSelect(p));
			this.items.set(p, item);
		}
		this.observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const p = Number((entry.target as HTMLElement).dataset.pageNumber);
					if (Number.isFinite(p)) this.enqueue(p, gen);
				}
			},
			{ root: this.listEl, rootMargin: OBSERVER_MARGIN }
		);
		for (const item of this.items.values()) this.observer.observe(item);
		if (this.currentPage > 0) this.setCurrentPage(this.currentPage);
	}

	showOutline(nodes: OutlineNode[]): void {
		this.mode = "outline";
		this.listEl.addClass("pr-mode-outline");
		this.reset();
		this.outlineTree = new OutlineTree((page) => this.options.onSelect(page));
		this.listEl.appendChild(this.outlineTree.el);
		this.outlineTree.build(nodes);
		if (this.currentPage > 0 && this.followOutline) {
			this.outlineTree.setCurrentPage(this.currentPage);
		}
	}

	showAnnotations(annotations: Annotation[]): void {
		this.mode = "annotations";
		this.reset();
		if (!this.options.annotationList) return;
		this.annList = new AnnotationList(
			this.options.annotationList,
			this.options.getColors ?? (() => ({}))
		);
		this.listEl.appendChild(this.annList.el);
		this.annList.build(annotations);
	}

	setFollowOutline(follow: boolean): void {
		this.followOutline = follow;
		if (follow && this.mode === "outline" && this.currentPage > 0) {
			this.outlineTree?.setCurrentPage(this.currentPage);
		}
	}

	setCollapsed(collapsed: boolean): void {
		this.el.toggleClass("pr-hidden", collapsed);
	}

	setCurrentPage(page: number): void {
		this.currentPage = page;
		if (this.mode === "thumbs") {
			for (const [p, item] of this.items) {
				item.toggleClass("pr-thumb-active", p === page);
			}
		} else if (this.followOutline) {
			this.outlineTree?.setCurrentPage(page);
		}
	}

	private enqueue(page: number, gen: number): void {
		if (this.rendered.has(page) || this.queued.has(page)) return;
		this.queued.add(page);
		this.queue.push(page);
		void this.pump(gen);
	}

	private async pump(gen: number): Promise<void> {
		while (this.inflight < MAX_CONCURRENT && this.queue.length > 0) {
			if (gen !== this.generation) return;
			const page = this.queue.shift()!;
			this.queued.delete(page);
			this.inflight++;
			try {
				await this.renderThumb(page, gen);
			} finally {
				this.inflight--;
			}
		}
	}

	private async renderThumb(page: number, gen: number): Promise<void> {
		const item = this.items.get(page);
		if (!item || gen !== this.generation) return;
		try {
			const canvas = await this.renderer.renderThumbnail(page, THUMB_WIDTH);
			if (gen !== this.generation || !item.isConnected) return;
			item.setCssStyles({ height: "" });
			item.empty();
			item.appendChild(canvas);
			const badge = item.createDiv({ cls: "pr-thumb-badge" });
			badge.setText(String(page));
			this.rendered.add(page);
		} catch (e) {
			console.warn(`[paper-reader] thumbnail render failed for page ${page}`, e);
		}
	}

	private reset(): void {
		this.generation++;
		this.observer?.disconnect();
		this.observer = null;
		this.outlineTree = null;
		this.annList = null;
		this.queue = [];
		this.queued.clear();
		this.rendered.clear();
		this.items.clear();
		this.listEl.empty();
	}

	destroy(): void {
		this.reset();
	}
}
