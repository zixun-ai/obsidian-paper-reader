import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type { ViewStateResult } from "obsidian";
import type PaperReaderPlugin from "../main";
import { PdfRenderer, RenderedPage } from "./PdfRenderer";
import { SelectionPayload, mergeTextRects, textRangeRects, rectsOverlap, renderSelectionPreview, sameSelection, selectionToPayload } from "./selection";
import { PopupStateCache } from "./popupCache";
import {
	LiveStroke,
	beginInkRectangle,
	beginInkStroke,
	inkBoundingRect,
	rectanglePoints,
	renderInkStrokes,
	transformRectangle,
	type RectangleBounds,
	type RectangleHandle,
} from "./InkLayer";
import {
	AnnotationHistory,
	HistoryDirection,
	HistoryOp,
	cloneAnnotation,
} from "../history/AnnotationHistory";
import { renderHighlightRects } from "./HighlightLayer";
import { SidebarMode, ThumbnailSidebar } from "./ThumbnailSidebar";
import { SelectionPopup } from "../toolbar/SelectionPopup";
import { HighlightMenu } from "../toolbar/HighlightMenu";
import { SelectionActions } from "../toolbar/SelectionActions";
import { AnswerPanel, PanelMode } from "../panel/AnswerPanel";
import { LlmClient, LlmError } from "../llm/client";
import { buildTranslateMessages } from "../llm/prompts";
import { OutlineNode } from "../outline/OutlineTree";
import { appendManyToNotes, appendToNotes, NotesEntry } from "../storage/notesWriter";
import { ReadingPosition } from "../settings";
import { SearchHit, findHits } from "../search/searchText";
import { inkPreviewSvg } from "./AnnotationList";
import {
	Annotation,
	AnnotationFile,
	AnnotationStore,
	AnnotationStyle,
	annotationFromPayload,
} from "../storage/annotationStore";

export const VIEW_TYPE_PAPER_READER = "paper-reader-view";

type LayoutMode = "continuous" | "single" | "double-odd" | "double-even";
type ZoomMode = "fit-width" | "fit-height" | "manual";
type DrawingTool = "pen" | "rectangle" | null;
type RectangleEdit = {
	id: string; page: number; pointerId: number; handle: RectangleHandle;
	startX: number; startY: number; bounds: RectangleBounds; before: Annotation;
};

const MIN_SCALE = 0.3;
const MAX_SCALE = 5;
const PAGE_GAP = 16;
const FULL_TEXT_LIMIT = 12_000;

export class PaperReaderView extends ItemView {
	private plugin: PaperReaderPlugin;
	private renderer = new PdfRenderer();
	private store: AnnotationStore;
	private llm: LlmClient;
	private data: AnnotationFile = { version: 1, file: "", annotations: [] };
	private file: TFile | null = null;

	private headerEl!: HTMLElement;
	private pageInputEl: HTMLInputElement | null = null;
	private pageTotalEl: HTMLElement | null = null;
	private bodyEl!: HTMLElement;
	private scrollEl!: HTMLElement;
	private pagesEl!: HTMLElement;
	private sidebar: ThumbnailSidebar;
	private sidebarCollapsed = false;
	private sidebarMode: SidebarMode = "thumbs";
	private followOutline = false;
	private outline: OutlineNode[] | null = null;
	private panel!: AnswerPanel;

	private pages: RenderedPage[] = [];
	private scale = 1;
	private zoomMode: ZoomMode = "fit-width";
	private layoutMode: LayoutMode = "continuous";
	private currentPage = 1;
	private baseDims: { width: number; height: number } | null = null;
	private renderToken = 0;
	private documentToken = 0;
	private aiPanelToken = 0;
	private closed = false;
	private mountedPages = new Set<number>();
	private wantedPages = new Set<number>();
	private failedPages = new Set<number>();
	private pageWindowTask: Promise<void> | null = null;
	private pageRender: { page: number; abort: AbortController } | null = null;
	private pageWindowTimer: number | null = null;
	private selectionTimer: number | null = null;

	private popup: SelectionPopup;
	private popupCache = new PopupStateCache();
	private hlMenu: HighlightMenu;
	private selectionActions: SelectionActions | null = null;
	private currentPayload: SelectionPayload | null = null;
	/** session-scoped annotation style/color chosen in the popup */
	private popupStyle: AnnotationStyle = "highlight";
	private popupColor = "yellow";
	private editingNoteId: string | null = null;

	// drawing tool state
	private drawingTool: DrawingTool = null;
	private penWidthIndex = 1; // 0 thin / 1 medium / 2 thick
	private liveStroke: LiveStroke | null = null;
	private liveStrokePage = 0;
	private selectedInkId: string | null = null;
	private rectangleEdit: RectangleEdit | null = null;

	// undo/redo (session only, per document)
	private history: AnnotationHistory;
	private undoBtn: HTMLButtonElement | null = null;
	private redoBtn: HTMLButtonElement | null = null;

	// reading position persistence
	private positionTimer: number | null = null;
	private restoringPosition = false;

	// in-document search
	private searchBarEl: HTMLElement | null = null;
	private searchInputEl: HTMLInputElement | null = null;
	private searchCountEl: HTMLElement | null = null;
	private searchHits: SearchHit[] = [];
	private currentHit = -1;
	private searchToken = 0;
	private searchDebounce: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: PaperReaderPlugin) {
		super(leaf);
		this.plugin = plugin;
		// plugin.app is guaranteed set; this.app on the view may not be
		// injected yet when the constructor runs during workspace restore
		this.store = new AnnotationStore(plugin.app, () => this.plugin.settings.annotationSuffix);
		this.llm = new LlmClient(plugin.app, () => ({
			baseUrl: this.plugin.settings.llmBaseUrl,
			apiKey: this.plugin.settings.llmApiKey,
			model: this.plugin.settings.llmModel,
		}));

		this.popup = new SelectionPopup({
			getColors: () => this.plugin.settings.highlightColors,
			getStyle: () => this.popupStyle,
			setStyle: (style) => void this.setPopupStyle(style),
			setInkWidth: (width) => void this.setPopupInkWidth(width),
			applyAnnotation: (color) => void this.applyPopupAnnotation(color),
			copySelection: () => void this.copySelection(),
			submitNote: (text) => this.submitNote(text),
			deleteAnnotation: (id) => this.deleteHighlight(id),
			translate: (payload, onChunk) => this.translateForPopup(payload, onChunk),
			insertTranslation: (t) => this.insertPopupTranslation(t),
			getCached: (key) => this.popupCache.get(key),
			setCached: (key, state) => this.popupCache.merge(key, state),
		});
		this.hlMenu = new HighlightMenu(
			{
				onRecolor: (color) => void this.recolorHighlight(color),
				onDelete: () => void this.deleteHighlight(),
			},
			() => this.plugin.settings.highlightColors
		);
		this.sidebar = new ThumbnailSidebar(this.renderer, {
			onSelect: (page) => void this.scrollToPage(page),
			annotationList: {
				onSelect: (ann) => void this.jumpToAnnotation(ann),
				onExport: (ann) => void this.exportAnnotation(ann),
				onExportAll: () => void this.exportAllAnnotations(),
			},
			getColors: () => this.plugin.settings.highlightColors,
		});
		this.history = new AnnotationHistory(
			(op, dir) => this.applyHistoryOp(op, dir),
			() => this.updateHistoryButtons()
		);
	}

	getViewType(): string {
		return VIEW_TYPE_PAPER_READER;
	}

	getDisplayText(): string {
		return this.file ? this.file.basename : "Paper Reader";
	}

	getIcon(): string {
		return "file-text";
	}

	async onOpen(): Promise<void> {
		this.closed = false;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("paper-reader-view");

		this.headerEl = contentEl.createDiv({ cls: "pr-header" });
		this.buildSearchBar(contentEl);
		this.bodyEl = contentEl.createDiv({ cls: "pr-body" });
		this.bodyEl.appendChild(this.sidebar.el);
		this.sidebar.setCollapsed(this.sidebarCollapsed);
		this.scrollEl = this.bodyEl.createDiv({ cls: "pr-scroll" });
		this.pagesEl = this.scrollEl.createDiv({ cls: "pr-pages" });

		this.panel = new AnswerPanel(
			this.app,
			this,
			this.llm,
			() => this.plugin.settings.translateTargetLang,
			() => this.file?.path ?? "",
			{
				onAnswered: (mode, payload, answer) =>
					void this.recordAiAnnotation(mode, payload, answer),
				onInsertNotes: async (entry) => {
					if (!this.file) return;
					await appendToNotes(
						this.app,
						this.file.path,
						this.plugin.settings.notesSuffix,
						entry
					);
				},
			}
		);
		this.bodyEl.appendChild(this.panel.el);

		this.registerDomEvent(this.scrollEl, "scroll", () => {
			this.popup.hide();
			this.hlMenu.hide();
			this.updateCurrentPageFromScroll();
			this.schedulePositionSave();
			if (this.pageWindowTimer === null) this.pageWindowTimer = window.setTimeout(() => {
				this.pageWindowTimer = null;
				void this.refreshPageWindow();
			}, 30);
		});
		this.registerDomEvent(this.scrollEl, "mouseup", () => this.onMouseUp());
		// pen drawing (delegated; only active in pen mode)
		this.registerDomEvent(this.scrollEl, "pointerdown", (e: PointerEvent) =>
			this.onPenPointerDown(e)
		);
		this.registerDomEvent(this.scrollEl, "pointermove", (e: PointerEvent) =>
			this.onPenPointerMove(e)
		);
		this.registerDomEvent(this.scrollEl, "pointerup", (e: PointerEvent) =>
			this.onPenPointerEnd(e, true)
		);
		this.registerDomEvent(this.scrollEl, "pointercancel", (e: PointerEvent) =>
			this.onPenPointerEnd(e, false)
		);
		// track selection lifecycle to enable/disable the header action group
		this.registerDomEvent(document, "selectionchange", () => {
			if (this.closed) return;
			if (this.selectionTimer !== null) window.clearTimeout(this.selectionTimer);
			this.selectionTimer = window.setTimeout(() => this.refreshSelectionState(), 100);
		});
		this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (this.rectangleEdit) {
					this.cancelRectangleEdit();
					return;
				}
				if (this.liveStroke) {
					// discard the in-progress stroke, stay in pen mode
					this.liveStroke.discard();
					this.liveStroke = null;
					return;
				}
				if (this.drawingTool) {
					this.setDrawingTool(null);
					return;
				}
				this.popup.hide();
				this.hlMenu.hide();
				return;
			}
			// undo/redo: only when this view is active and not typing
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.altKey) {
				if (this.app.workspace.getActiveViewOfType(PaperReaderView) === this && !this.isEditableTarget(e.target)) {
					e.preventDefault();
					if (e.shiftKey) void this.history.redo();
					else void this.history.undo();
				}
				return;
			}
			// in-document search
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && !e.altKey) {
				if (this.app.workspace.getActiveViewOfType(PaperReaderView) === this) {
					e.preventDefault();
					this.openSearch();
				}
				return;
			}
			this.onPageNavKey(e);
		});
		this.registerDomEvent(document, "mousedown", (e: MouseEvent) => {
			const t = e.target as Node;
			if (this.popup.isVisible && !this.popup.contains(t)) this.popup.hide();
			if (this.hlMenu.isVisible && !this.hlMenu.contains(t)) this.hlMenu.hide();
			const el = e.target as Element;
			if (this.selectedInkId && !el.closest?.(".pr-ink-path, .pr-ink-selection, .pr-ink-handle, .pr-popup")) {
				this.selectedInkId = null;
				this.editingNoteId = null;
				this.redrawAllInk();
			}
		});
	}

	async onClose(): Promise<void> {
		this.closed = true;
		this.panel?.close();
		this.documentToken++;
		this.renderToken++;
		this.pageRender?.abort.abort();
		this.wantedPages.clear();
		this.closeSearch();
		for (const timer of [this.positionTimer, this.pageWindowTimer, this.selectionTimer]) {
			if (timer !== null) window.clearTimeout(timer);
		}
		this.positionTimer = this.pageWindowTimer = this.selectionTimer = null;
		await this.savePositionNow().catch(error => console.error("[paper-reader] position save failed", error));
		if (this.liveStroke) {
			this.liveStroke.discard();
			this.liveStroke = null;
		}
		this.cancelRectangleEdit();
		this.file = null;
		this.popup.hide();
		this.hlMenu.hide();
		this.sidebar.destroy();
		for (const page of this.pages) this.renderer.releasePage(page);
		this.pages = [];
		this.mountedPages.clear();
		await this.renderer.destroy();
	}

	getState(): Record<string, unknown> {
		return {
			file: this.file?.path,
			sidebarCollapsed: this.sidebarCollapsed,
			sidebarMode: this.sidebarMode,
			followOutline: this.followOutline,
		};
	}

	async setState(
		state: {
			file?: string;
			page?: number;
			sidebarCollapsed?: boolean;
			sidebarMode?: SidebarMode;
			followOutline?: boolean;
		},
		result: ViewStateResult
	): Promise<void> {
		if (typeof state.sidebarCollapsed === "boolean") {
			this.sidebarCollapsed = state.sidebarCollapsed;
			this.sidebar.setCollapsed(this.sidebarCollapsed);
		}
		if (
			state.sidebarMode === "thumbs" ||
			state.sidebarMode === "outline" ||
			state.sidebarMode === "annotations"
		) {
			this.sidebarMode = state.sidebarMode;
		}
		if (typeof state.followOutline === "boolean") {
			this.followOutline = state.followOutline;
			this.sidebar.setFollowOutline(this.followOutline);
		}
		if (state.file) {
			const file = this.app.vault.getAbstractFileByPath(state.file);
			if (file instanceof TFile && file.extension === "pdf") {
				await this.openFile(file, { page: state.page });
			} else {
				this.showEmpty(`文件不存在或不是 PDF: ${state.file}`);
			}
		}
		await super.setState(state, result);
	}

	async openFile(file: TFile, opts?: { page?: number }): Promise<void> {
		const token = ++this.documentToken;
		this.panel?.close();
		this.file = file;
		this.currentPayload = null;
		this.editingNoteId = null;
		this.popupCache.clear();
		this.selectedInkId = null;
		this.setDrawingTool(null);
		this.history.clear();
		this.closeSearch();
		this.currentPage = 1;
		this.popup.hide();
		this.hlMenu.hide();
		this.showEmpty("加载中…");
		try {
			const buf = await this.app.vault.readBinary(file);
			if (token !== this.documentToken || this.closed) return;
			await this.renderer.load(buf);
			if (token !== this.documentToken || this.closed) return;
			const store = new AnnotationStore(this.app, () => this.plugin.settings.annotationSuffix);
			const data = await store.load(file.path);
			if (token !== this.documentToken || this.closed) return;
			this.store = store; this.data = data;
			const dims = await this.renderer.getPageDims(1);
			const outline = await this.renderer.getOutline().catch(() => null);
			if (token !== this.documentToken || this.closed) return;
			this.baseDims = dims; this.outline = outline;
		} catch (e) {
			if (token !== this.documentToken || this.closed) return;
			console.error("[paper-reader] failed to load pdf", e);
			this.showEmpty(`PDF 加载失败: ${file.path}`);
			return;
		}
		if (token !== this.documentToken || this.closed) return;
		this.zoomMode = "fit-width";
		// restore last reading position unless an explicit page was requested
		const explicitPage = opts?.page;
		const saved = explicitPage ? undefined : this.savedPositionFor(file.path);
		if (saved) this.prepareSavedLayout(saved);
		if (explicitPage) this.currentPage = Math.min(Math.max(1, explicitPage), this.renderer.numPages);
		this.buildSidebarContent();
		this.buildHeader();
		await this.renderAll();
		if (token !== this.documentToken || this.closed) return;
		this.buildHeader();
		this.applyInvertColors();
		if (explicitPage) {
			await this.scrollToPage(explicitPage);
		} else if (saved) {
			await this.restorePosition(saved);
		}
		// refresh leaf tab title
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
	}

	// ---- reading position persistence ----

	/**
	 * Apply a saved position's layout/zoom/page BEFORE rendering, so the
	 * saved page exists in all layout modes (single-page renders currentPage
	 * only). Page is clamped for PDFs that lost pages.
	 */
	private prepareSavedLayout(saved: ReadingPosition): void {
		this.layoutMode = (saved.layoutMode as LayoutMode) ?? "continuous";
		this.zoomMode = (saved.zoomMode as ZoomMode) ?? "fit-width";
		if (this.zoomMode === "manual" && saved.scale > 0) this.scale = saved.scale;
		this.currentPage = Math.min(
			Math.max(1, Math.round(saved.page)),
			Math.max(this.renderer.numPages, 1)
		);
	}

	private savedPositionFor(path: string): ReadingPosition | undefined {
		// exact path only: same-named PDFs in different folders stay isolated.
		// renames are handled by the vault "rename" event in main.ts.
		return this.plugin.settings.readingPositions[path];
	}

	private currentPosition(): ReadingPosition | null {
		if (!this.file || this.pages.length === 0) return null;
		const mid = this.scrollEl.scrollTop + this.scrollEl.clientHeight / 2;
		let page = this.pages[0];
		for (const p of this.pages) {
			if (p.wrapper.offsetTop <= mid) page = p;
			else break;
		}
		const h = page.wrapper.offsetHeight || 1;
		const fraction = Math.min(Math.max((mid - page.wrapper.offsetTop) / h, 0), 1);
		return {
			page: page.pageNumber,
			pageFraction: fraction,
			zoomMode: this.zoomMode,
			scale: this.scale,
			layoutMode: this.layoutMode,
			updatedAt: Date.now(),
		};
	}

	private schedulePositionSave(): void {
		if (!this.file || this.restoringPosition) return;
		if (this.positionTimer !== null) window.clearTimeout(this.positionTimer);
		this.positionTimer = window.setTimeout(() => {
			this.positionTimer = null;
			void this.savePositionNow();
		}, 800);
	}

	private async savePositionNow(): Promise<void> {
		const pos = this.currentPosition();
		if (!pos || !this.file) return;
		this.plugin.settings.readingPositions[this.file.path] = pos;
		await this.plugin.saveSettings();
	}

	private async restorePosition(saved: ReadingPosition): Promise<void> {
		this.restoringPosition = true;
		try {
			const n = this.renderer.numPages;
			const page = Math.min(Math.max(1, Math.round(saved.page)), Math.max(n, 1));
			const rendered = this.pages.find((p) => p.pageNumber === page);
			if (!rendered) return;
			const target =
				rendered.wrapper.offsetTop +
				saved.pageFraction * rendered.wrapper.offsetHeight -
				this.scrollEl.clientHeight / 2;
			this.scrollEl.scrollTop = Math.max(0, target);
			this.updateCurrentPage(page);
			await this.refreshPageWindow();
		} finally {
			this.restoringPosition = false;
		}
	}

	// ---- in-document search ----

	private buildSearchBar(parent: HTMLElement): void {
		const bar = parent.createDiv({ cls: "pr-searchbar pr-hidden" });
		this.searchBarEl = bar;
		this.searchInputEl = bar.createEl("input", {
			cls: "pr-search-input",
			attr: { type: "text", placeholder: "在本文档中搜索…" },
		});
		this.searchCountEl = bar.createSpan({ cls: "pr-search-count" });
		const mkBtn = (icon: string, tooltip: string, onClick: () => void) => {
			const btn = bar.createEl("button", { cls: "pr-header-btn clickable-icon" });
			setIcon(btn, icon);
			btn.setAttr("aria-label", tooltip);
			btn.addEventListener("mousedown", (e) => e.preventDefault());
			btn.addEventListener("click", onClick);
		};
		mkBtn("chevron-up", "上一个 (Shift+Enter)", () => void this.gotoHit(-1));
		mkBtn("chevron-down", "下一个 (Enter)", () => void this.gotoHit(1));
		mkBtn("x", "关闭 (Esc)", () => this.closeSearch());
		this.searchInputEl.addEventListener("input", () => {
			if (this.searchDebounce !== null) window.clearTimeout(this.searchDebounce);
			this.searchDebounce = window.setTimeout(() => void this.runSearch(), 250);
		});
		this.searchInputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				void this.gotoHit(e.shiftKey ? -1 : 1);
			} else if (e.key === "Escape") {
				this.closeSearch();
			}
		});
	}

	private openSearch(): void {
		if (!this.searchBarEl || !this.file) return;
		this.searchBarEl.removeClass("pr-hidden");
		this.searchInputEl?.focus();
		this.searchInputEl?.select();
		if (this.searchHits.length > 0 && this.currentHit >= 0) {
			void this.gotoHit(0);
		}
	}

	private closeSearch(): void {
		if (this.searchDebounce !== null) window.clearTimeout(this.searchDebounce);
		this.searchDebounce = null;
		this.searchBarEl?.addClass("pr-hidden");
		this.searchHits = [];
		this.currentHit = -1;
		this.searchToken++;
		this.clearSearchHighlights();
		if (this.searchCountEl) this.searchCountEl.setText("");
	}

	private clearSearchHighlights(): void {
		for (const page of this.pages) {
			page.highlightLayer
				.querySelectorAll(".pr-search-hit")
				.forEach((el) => el.remove());
		}
	}

	private async runSearch(): Promise<void> {
		const token = ++this.searchToken;
		this.clearSearchHighlights();
		this.searchHits = [];
		this.currentHit = -1;
		const query = this.searchInputEl?.value ?? "";
		const countEl = this.searchCountEl;
		if (!this.file || !query.trim()) {
			if (countEl) countEl.setText("");
			return;
		}
		if (countEl) countEl.setText("搜索中…");
		const n = this.renderer.numPages;
		const texts: (string | undefined)[] = [];
		for (let p = 1; p <= n; p++) {
			if (token !== this.searchToken) return; // superseded
			try {
				texts.push(await this.renderer.getPageTextEnsured(p));
			} catch {
				texts.push(undefined);
			}
		}
		if (token !== this.searchToken) return;
		if (texts.every((t) => !t || !t.trim())) {
			if (countEl) countEl.setText("无法提取文本（可能是扫描件）");
			return;
		}
		this.searchHits = findHits(texts, query);
		if (this.searchHits.length === 0) {
			if (countEl) countEl.setText("无结果");
			return;
		}
		await this.gotoHit(1, true);
	}

	private async gotoHit(dir: number, absolute = false): Promise<void> {
		const total = this.searchHits.length;
		if (total === 0) return;
		this.currentHit = absolute
			? 0
			: (((this.currentHit + dir) % total) + total) % total;
		const hit = this.searchHits[this.currentHit];
		if (this.searchCountEl) {
			this.searchCountEl.setText(`${this.currentHit + 1} / ${total}`);
		}
		await this.scrollToPage(hit.page);
		this.applySearchHighlights(hit);
	}

	/** map hit char offsets to DOM ranges and draw temporary highlight rects */
	private applySearchHighlights(current: SearchHit): void {
		this.clearSearchHighlights();
		const page = this.pages.find((p) => p.pageNumber === current.page);
		if (!page) return;
		const layer = page.highlightLayer;
		const hitsOnPage = this.searchHits.filter((h) => h.page === current.page);
		for (const hit of hitsOnPage) {
			const range = this.domRangeForText(page.wrapper, hit.index, hit.length);
			if (!range) continue;
			const pageRect = page.wrapper.getBoundingClientRect();
			for (const r of mergeTextRects(textRangeRects(range, page.wrapper))) {
				if (r.width < 2 || r.height < 2) continue;
				const el = layer.createDiv({
					cls: hit === current ? "pr-search-hit pr-search-current" : "pr-search-hit",
				});
				el.style.left = `${r.left - pageRect.left}px`;
				el.style.top = `${r.top - pageRect.top}px`;
				el.style.width = `${r.width}px`;
				el.style.height = `${r.height}px`;
			}
		}
	}

	/** locate [start, start+length) of the page's extracted text inside the text layer DOM */
	private domRangeForText(
		pageWrapper: HTMLElement,
		start: number,
		length: number
	): Range | null {
		const textLayer = pageWrapper.querySelector(".textLayer");
		if (!textLayer) return null;
		const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
		const range = document.createRange();
		let acc = 0;
		let started = false;
		let node = walker.nextNode();
		while (node) {
			const len = node.textContent?.length ?? 0;
			if (!started && acc + len > start) {
				range.setStart(node, Math.min(start - acc, len));
				started = true;
			}
			if (started && acc + len >= start + length) {
				range.setEnd(node, Math.min(start + length - acc, len));
				return range;
			}
			acc += len;
			node = walker.nextNode();
		}
		return started ? range : null;
	}

	private showEmpty(message: string): void {
		this.renderToken++;
		this.pageRender?.abort.abort();
		this.wantedPages.clear(); this.mountedPages.clear();
		for (const page of this.pages) this.renderer.releasePage(page);
		this.headerEl.empty();
		this.pagesEl.empty();
		this.pages = [];
		this.sidebar.destroy();
		this.pagesEl.createDiv({ cls: "pr-empty", text: message });
	}

	// ---- header ----

	private buildHeader(): void {
		this.headerEl.empty();
		const mkBtn = (
			icon: string,
			tooltip: string,
			onClick: (e: MouseEvent) => void
		): HTMLButtonElement => {
			const btn = this.headerEl.createEl("button", { cls: "pr-header-btn clickable-icon" });
			btn.setAttr("aria-label", tooltip);
			setIcon(btn, icon);
			btn.addEventListener("click", (e) => onClick(e));
			return btn;
		};

		// sidebar toggle + options dropdown
		mkBtn("panel-left", "切换侧栏", () => void this.toggleSidebar());
		mkBtn("chevron-down", "侧栏选项", (e) => this.openSidebarMenu(e));

		this.headerEl.createDiv({ cls: "pr-divider" });

		// zoom out / zoom in + options dropdown
		mkBtn("zoom-out", "缩小", () => void this.zoomBy(1 / 1.2));
		mkBtn("zoom-in", "放大", () => void this.zoomBy(1.2));
		mkBtn("chevron-down", "缩放与布局选项", (e) => this.openZoomMenu(e));

		// pen tool + width dropdown
		this.penBtn = mkBtn("pencil", "画笔（再次点击或 Esc 退出）", () =>
			this.setDrawingTool(this.drawingTool === "pen" ? null : "pen")
		);
		this.penBtn.toggleClass("pr-pen-on", this.drawingTool === "pen");
		this.rectangleBtn = mkBtn("square", "矩形框（再次点击或 Esc 退出）", () =>
			this.setDrawingTool(this.drawingTool === "rectangle" ? null : "rectangle")
		);
		this.rectangleBtn.toggleClass("pr-pen-on", this.drawingTool === "rectangle");
		mkBtn("chevron-down", "画笔粗细", (e) => this.openPenMenu(e));

		// undo / redo
		this.undoBtn = mkBtn("undo-2", "撤销 (Cmd/Ctrl+Z)", () => void this.history.undo());
		this.redoBtn = mkBtn("redo-2", "重做 (Cmd/Ctrl+Shift+Z)", () => void this.history.redo());
		this.updateHistoryButtons();

		this.headerEl.createDiv({ cls: "pr-divider" });

		// selection action group
		this.selectionActions = new SelectionActions(
			{
				getColor: () => this.popupColor,
				getStyle: () => this.popupStyle,
				applyColor: (key) => void this.applyHeaderColor(key),
				applyStyle: (style) => void this.applyHeaderStyle(style),
				onClearHighlight: () => void this.clearHighlightsInSelection(),
				onCopy: () => void this.copySelection(),
				onNote: () => this.openNotePopup(),
				onTranslate: () => this.withPayload(p => void this.openAiPanel("translate", p)),
				onExplain: () => this.withPayload(p => void this.openAiPanel("explain", p)),
				onAsk: () => this.withPayload(p => void this.openAiPanel("ask", p)),
			},
			() => this.plugin.settings.highlightColors
		);
		this.selectionActions.setEnabled(!!this.currentPayload);
		this.headerEl.appendChild(this.selectionActions.el);

		// page number input, pinned right
		const pageWrap = this.headerEl.createDiv({ cls: "pr-page-wrap" });
		this.pageInputEl = pageWrap.createEl("input", {
			cls: "pr-page-input",
			attr: { type: "text", inputmode: "numeric" },
		});
		this.pageInputEl.value = String(this.currentPage);
		this.pageInputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				const n = parseInt(this.pageInputEl?.value ?? "", 10);
				if (Number.isFinite(n)) void this.scrollToPage(n);
				this.pageInputEl?.blur();
			}
			e.stopPropagation();
		});
		this.pageInputEl.addEventListener("blur", () => {
			if (this.pageInputEl) this.pageInputEl.value = String(this.currentPage);
		});
		this.pageTotalEl = pageWrap.createSpan({
			cls: "pr-page-total",
			text: `/ ${this.renderer.numPages}`,
		});
	}

	private openSidebarMenu(e: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("缩略图")
				.setIcon("image")
				.setChecked(this.sidebarMode === "thumbs")
				.onClick(() => this.setSidebarMode("thumbs"))
		);
		menu.addItem((item) =>
			item
				.setTitle("目录")
				.setIcon("list")
				.setChecked(this.sidebarMode === "outline")
				.setDisabled(!this.outline || this.outline.length === 0)
				.onClick(() => this.setSidebarMode("outline"))
		);
		menu.addItem((item) =>
			item
				.setTitle("标注")
				.setIcon("list-checks")
				.setChecked(this.sidebarMode === "annotations")
				.onClick(() => this.setSidebarMode("annotations"))
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("显示当前所在目录")
				.setIcon("locate")
				.setChecked(this.followOutline)
				.setDisabled(!this.outline || this.outline.length === 0)
				.onClick(() => this.setFollowOutline(!this.followOutline))
		);
		menu.showAtMouseEvent(e);
	}

	private openPenMenu(e: MouseEvent): void {
		const menu = new Menu();
		const widths = ["细", "中", "粗"];
		widths.forEach((label, i) => {
			menu.addItem((item) =>
				item
					.setTitle(label)
					.setChecked(this.penWidthIndex === i)
					.onClick(() => this.setPenWidth(i))
			);
		});
		menu.showAtMouseEvent(e);
	}

	private openZoomMenu(e: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("适应宽度")
				.setChecked(this.zoomMode === "fit-width")
				.onClick(() => void this.setZoomMode("fit-width"))
		);
		menu.addItem((item) =>
			item
				.setTitle("适应高度")
				.setChecked(this.zoomMode === "fit-height")
				.onClick(() => void this.setZoomMode("fit-height"))
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("连续滚动")
				.setChecked(this.layoutMode === "continuous")
				.onClick(() => void this.setLayoutMode("continuous"))
		);
		menu.addItem((item) =>
			item
				.setTitle("单页")
				.setChecked(this.layoutMode === "single")
				.onClick(() => void this.setLayoutMode("single"))
		);
		menu.addItem((item) =>
			item
				.setTitle("双页（奇数）")
				.setChecked(this.layoutMode === "double-odd")
				.onClick(() => void this.setLayoutMode("double-odd"))
		);
		menu.addItem((item) =>
			item
				.setTitle("双页（偶数）")
				.setChecked(this.layoutMode === "double-even")
				.onClick(() => void this.setLayoutMode("double-even"))
		);
		menu.addSeparator();
		const isDark = document.body.classList.contains("theme-dark");
		menu.addItem((item) =>
			item
				.setTitle("适应主题（暗色反色）")
				.setChecked(this.plugin.settings.invertColorsInDark)
				.setDisabled(!isDark)
				.onClick(() => void this.toggleInvertColors())
		);
		menu.showAtMouseEvent(e);
	}

	// ---- sidebar / outline ----

	private buildSidebarContent(): void {
		if (this.sidebarMode === "annotations") {
			this.sidebar.showAnnotations(this.data.annotations);
		} else if (
			this.sidebarMode === "outline" &&
			this.outline &&
			this.outline.length > 0
		) {
			this.sidebar.showOutline(this.outline);
		} else {
			this.sidebarMode = "thumbs";
			this.sidebar.showThumbs(this.renderer.numPages);
		}
		this.sidebar.setFollowOutline(this.followOutline);
	}

	private setSidebarMode(mode: SidebarMode): void {
		this.sidebarMode = mode;
		if (this.sidebarCollapsed) {
			this.sidebarCollapsed = false;
			this.sidebar.setCollapsed(false);
		}
		this.buildSidebarContent();
		this.app.workspace.requestSaveLayout();
	}

	private setFollowOutline(follow: boolean): void {
		this.followOutline = follow;
		if (follow && this.sidebarMode !== "outline" && this.outline?.length) {
			this.sidebarMode = "outline";
			this.buildSidebarContent();
		}
		this.sidebar.setFollowOutline(follow);
		this.app.workspace.requestSaveLayout();
	}

	private async toggleSidebar(): Promise<void> {
		this.sidebarCollapsed = !this.sidebarCollapsed;
		this.sidebar.setCollapsed(this.sidebarCollapsed);
		// persist in view state
		this.app.workspace.requestSaveLayout();
		// sidebar width change affects fit-based scales
		if (this.zoomMode !== "manual" && this.pages.length > 0) {
			await this.renderAll();
		}
	}

	// ---- zoom / layout ----

	private computeScale(): number {
		if (this.zoomMode === "manual" || !this.baseDims) return this.scale;
		const isDouble = this.layoutMode.startsWith("double");
		if (this.zoomMode === "fit-height") {
			const availH = this.scrollEl.clientHeight - 32;
			if (availH > 0) {
				return Math.min(MAX_SCALE, Math.max(MIN_SCALE, availH / this.baseDims.height));
			}
			return this.scale;
		}
		const cols = isDouble ? 2 : 1;
		const availW = this.scrollEl.clientWidth - 48 - PAGE_GAP * (cols - 1);
		if (availW > 0 && this.baseDims.width > 0) {
			return Math.min(
				MAX_SCALE,
				Math.max(MIN_SCALE, availW / cols / this.baseDims.width)
			);
		}
		return this.scale;
	}

	private async setZoomMode(mode: ZoomMode): Promise<void> {
		this.zoomMode = mode;
		await this.renderAll();
		this.schedulePositionSave();
	}

	private async setLayoutMode(mode: LayoutMode): Promise<void> {
		this.layoutMode = mode;
		await this.renderAll();
		if (this.layoutMode === "single") this.scrollEl.scrollTop = 0;
		this.schedulePositionSave();
	}

	private async zoomBy(factor: number): Promise<void> {
		this.zoomMode = "manual";
		this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
		await this.renderAll();
		this.schedulePositionSave();
	}

	private async toggleInvertColors(): Promise<void> {
		this.plugin.settings.invertColorsInDark = !this.plugin.settings.invertColorsInDark;
		await this.plugin.saveSettings();
		this.applyInvertColors();
	}

	private applyInvertColors(): void {
		const dark = document.body.classList.contains("theme-dark");
		this.contentEl.toggleClass(
			"pr-invert",
			this.plugin.settings.invertColorsInDark && dark
		);
	}

	// ---- rendering ----

	private async renderAll(): Promise<void> {
		if (this.closed) return;
		const token = ++this.renderToken;
		this.pageRender?.abort.abort();
		this.wantedPages.clear(); this.mountedPages.clear(); this.failedPages.clear();
		this.scale = this.computeScale();
		const scrollRatio =
			this.scrollEl.scrollHeight > 0
				? this.scrollEl.scrollTop / this.scrollEl.scrollHeight
				: 0;

		for (const page of this.pages) this.renderer.releasePage(page);
		this.pagesEl.empty();
		this.pages = [];
		const n = this.renderer.numPages;
		if (n === 0) return;

		if (this.layoutMode === "single") {
			const p = Math.min(Math.max(1, this.currentPage), n);
			if (!(await this.renderOnePage(p, token, this.pagesEl))) return;
		} else if (this.layoutMode === "continuous") {
			for (let p = 1; p <= n; p++) {
				if (!(await this.renderOnePage(p, token, this.pagesEl))) return;
			}
		} else {
			// book-style rows of two pages
			const rows: (number | null)[][] = [];
			if (this.layoutMode === "double-odd") {
				for (let p = 1; p <= n; p += 2) rows.push([p, p + 1 <= n ? p + 1 : null]);
			} else {
				rows.push([null, 1]);
				for (let p = 2; p <= n; p += 2) rows.push([p, p + 1 <= n ? p + 1 : null]);
			}
			for (const row of rows) {
				if (token !== this.renderToken) return;
				const rowEl = this.pagesEl.createDiv({ cls: "pr-row" });
				for (const slot of row) {
					if (slot === null) {
						const ph = rowEl.createDiv({ cls: "pr-page-placeholder" });
						if (this.baseDims) {
							ph.style.width = `${Math.floor(this.baseDims.width * this.scale)}px`;
							ph.style.height = `${Math.floor(this.baseDims.height * this.scale)}px`;
						}
					} else if (!(await this.renderOnePage(slot, token, rowEl))) {
						return;
					}
				}
			}
		}

		if (this.layoutMode === "single") {
			this.scrollEl.scrollTop = 0;
			this.updateCurrentPage(this.currentPage);
		} else {
			this.scrollEl.scrollTop = scrollRatio * this.scrollEl.scrollHeight;
			if (scrollRatio === 0 && this.currentPage > 1) {
				this.scrollEl.scrollTop = this.pages.find(p => p.pageNumber === this.currentPage)?.wrapper.offsetTop ?? 0;
			}
			this.updateCurrentPageFromScroll();
		}
		await this.refreshPageWindow();
	}

	private async renderOnePage(
		pageNumber: number,
		token: number,
		parent: HTMLElement
	): Promise<boolean> {
		if (token !== this.renderToken) return false;
		let rendered: RenderedPage;
		try { rendered = await this.renderer.createPlaceholder(pageNumber, this.scale); }
		catch (error) { if (token !== this.renderToken || this.closed) return false; throw error; }
		if (token !== this.renderToken) return false;
		this.pages.push(rendered);
		parent.appendChild(rendered.wrapper);
		return true;
	}

	/** Keep lightweight page geometry; raster/text resources belong only to the reading window. */
	private async refreshPageWindow(): Promise<void> {
		if (this.closed || !this.pages.length) return;
		const bounds = this.scrollEl.getBoundingClientRect();
		const margin = this.scrollEl.clientHeight;
		const center = (bounds.top + bounds.bottom) / 2;
		const candidates = this.pages.map(page => ({ page, rect: page.wrapper.getBoundingClientRect() }))
			.filter(({ rect }) => rect.bottom >= bounds.top - margin && rect.top <= bounds.bottom + margin)
			.sort((a, b) => Math.abs((a.rect.top + a.rect.bottom) / 2 - center) - Math.abs((b.rect.top + b.rect.bottom) / 2 - center));
		// ponytail: eight nearby pages plus active selection/drawing; tune only with viewport evidence.
		this.wantedPages = new Set(candidates.slice(0, 8).map(({ page }) => page.pageNumber));
		const selection = this.scrollEl.ownerDocument.getSelection();
		for (const page of this.pages) {
			if ((selection?.anchorNode && page.wrapper.contains(selection.anchorNode)) ||
				(selection?.focusNode && page.wrapper.contains(selection.focusNode)) ||
				(this.liveStroke && page.pageNumber === this.liveStrokePage) || page.pageNumber === this.rectangleEdit?.page) {
				this.wantedPages.add(page.pageNumber);
			}
			if (this.mountedPages.has(page.pageNumber) && !this.wantedPages.has(page.pageNumber)) {
				this.renderer.releasePage(page); this.mountedPages.delete(page.pageNumber);
			}
		}
		if (this.pageRender && !this.wantedPages.has(this.pageRender.page)) this.pageRender.abort.abort();
		if (!this.pageWindowTask) {
			this.pageWindowTask = Promise.resolve().then(async () => {
				while (!this.closed) {
					const slot = this.pages.find(p => this.wantedPages.has(p.pageNumber) && !this.mountedPages.has(p.pageNumber) && !this.failedPages.has(p.pageNumber));
					if (!slot) break;
					const token = this.renderToken, abort = new AbortController();
					this.pageRender = { page: slot.pageNumber, abort };
					try {
						const rendered = await this.renderer.renderPage(slot.pageNumber, this.scale, abort.signal);
						if (token !== this.renderToken || abort.signal.aborted || this.closed) { this.renderer.releasePage(rendered); continue; }
						const wrapper = slot.wrapper;
						wrapper.replaceChildren(...Array.from(rendered.wrapper.childNodes));
						Object.assign(slot, rendered, { wrapper });
						this.mountedPages.add(slot.pageNumber);
						this.redrawHighlights(slot); this.redrawInk(slot);
						const hit = this.searchHits[this.currentHit];
						if (hit?.page === slot.pageNumber) this.applySearchHighlights(hit);
					} catch (error) {
						if (!abort.signal.aborted && token === this.renderToken && !this.closed) {
							this.failedPages.add(slot.pageNumber);
							new Notice(`第 ${slot.pageNumber} 页渲染失败，请重新打开 PDF`);
							console.error("[paper-reader] page render failed", error);
						}
					} finally { this.pageRender = null; }
				}
			}).finally(() => { this.pageWindowTask = null; });
		}
		await this.pageWindowTask;
	}

	private redrawHighlights(page: RenderedPage): void {
		if (!this.mountedPages.has(page.pageNumber)) return;
		const annotations = this.data.annotations.filter(
			(a) =>
				(a.type === "highlight" || a.type === "note") &&
				a.page === page.pageNumber
		);
		renderHighlightRects(
			page.highlightLayer,
			annotations,
			this.scale,
			this.plugin.settings.highlightColors,
			(ann, x, y) => this.onAnnotationClick(ann, x, y)
		);
	}

	/** note annotations reopen the popup for editing; others get the menu */
	private onAnnotationClick(ann: Annotation, x: number, y: number): void {
		if (ann.type === "note") {
			this.editingNoteId = ann.id;
			this.hlMenu.hide();
			this.popup.showEdit(ann, x, y);
			return;
		}
		this.openHighlightMenu(ann, x, y);
	}

	private redrawAllHighlights(): void {
		for (const page of this.pages) this.redrawHighlights(page);
	}

	// ---- current page tracking / navigation ----

	private updateCurrentPage(page: number): void {
		this.currentPage = page;
		if (this.pageInputEl && document.activeElement !== this.pageInputEl) {
			this.pageInputEl.value = String(page);
		}
		if (this.pageTotalEl) {
			this.pageTotalEl.setText(`/ ${this.renderer.numPages}`);
		}
		this.sidebar.setCurrentPage(page);
	}

	private updateCurrentPageFromScroll(): void {
		if (this.pages.length === 0 || this.layoutMode === "single") return;
		const mid = this.scrollEl.scrollTop + this.scrollEl.clientHeight / 2;
		let current = 1;
		for (const page of this.pages) {
			if (page.wrapper.offsetTop <= mid) current = page.pageNumber;
			else break;
		}
		if (current !== this.currentPage) this.updateCurrentPage(current);
	}

	private async scrollToPage(pageNumber: number): Promise<void> {
		const n = this.renderer.numPages;
		if (n === 0) return;
		const target = Math.min(Math.max(1, Math.round(pageNumber)), n);
		if (this.layoutMode === "single") {
			this.currentPage = target;
			await this.renderAll();
			return;
		}
		const page = this.pages.find((p) => p.pageNumber === target);
		if (!page) return;
		this.scrollEl.scrollTop = page.wrapper.offsetTop - 8;
		this.updateCurrentPage(target);
		await this.refreshPageWindow();
	}

	private isEditableTarget(t: EventTarget | null): boolean {
		const el = t as HTMLElement | null;
		if (!el || !el.tagName) return false;
		return (
			el.tagName === "INPUT" ||
			el.tagName === "TEXTAREA" ||
			el.isContentEditable === true
		);
	}

	private onPageNavKey(e: KeyboardEvent): void {
		if (this.layoutMode !== "single") return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (this.isEditableTarget(e.target)) return;
		// only when this view's leaf is active
		if (this.app.workspace.getActiveViewOfType(PaperReaderView) !== this) return;
		if (e.key === "ArrowLeft" || e.key === "PageUp") {
			e.preventDefault();
			void this.scrollToPage(this.currentPage - 1);
		} else if (e.key === "ArrowRight" || e.key === "PageDown") {
			e.preventDefault();
			void this.scrollToPage(this.currentPage + 1);
		}
	}

	// ---- pen tool ----

	private setDrawingTool(tool: DrawingTool): void {
		if (this.drawingTool === tool) return;
		this.drawingTool = tool;
		if (this.liveStroke) {
			this.liveStroke.discard();
			this.liveStroke = null;
		}
		this.pagesEl.toggleClass("pr-pen-mode", tool !== null);
		this.penBtn?.toggleClass("pr-pen-on", tool === "pen");
		this.rectangleBtn?.toggleClass("pr-pen-on", tool === "rectangle");
		if (tool) {
			this.popup.hide();
			this.clearSelection();
			this.selectedInkId = null;
			this.editingNoteId = null;
			this.redrawAllInk();
		}
	}

	private setPenWidth(index: number): void {
		this.penWidthIndex = index;
	}

	private penBtn: HTMLButtonElement | null = null;
	private rectangleBtn: HTMLButtonElement | null = null;

	private penWidthPx(): number {
		return [2, 4, 7][this.penWidthIndex] ?? 4;
	}

	private pageFromEvent(e: PointerEvent): RenderedPage | null {
		const el = (e.target as HTMLElement).closest?.(".pr-page");
		if (!(el instanceof HTMLElement)) return null;
		const n = Number(el.dataset.pageNumber);
		return this.pages.find((p) => p.pageNumber === n) ?? null;
	}

	private onPenPointerDown(e: PointerEvent): void {
		if (e.button !== 0 || this.liveStroke || this.rectangleEdit) return;
		const editTarget = (e.target as Element).closest?.<SVGElement>("[data-ink-handle]");
		if (!this.drawingTool && editTarget?.dataset.annotationId && editTarget.dataset.inkHandle) {
			const ann = this.data.annotations.find((a) => a.id === editTarget.dataset.annotationId);
			const page = ann && this.pages.find((p) => p.pageNumber === ann.page);
			if (ann?.ink?.shape === "rectangle" && page) {
				const point = this.pointOnPage(e, page);
				this.rectangleEdit = {
					id: ann.id, page: ann.page, pointerId: e.pointerId,
					handle: editTarget.dataset.inkHandle as RectangleHandle,
					startX: point.x, startY: point.y,
					bounds: inkBoundingRect(ann.ink.points), before: cloneAnnotation(ann),
				};
				e.preventDefault();
				e.stopPropagation();
				this.scrollEl.setPointerCapture(e.pointerId);
				return;
			}
		}
		if (!this.drawingTool) return;
		const page = this.pageFromEvent(e);
		if (!page) return;
		e.preventDefault();
		e.stopPropagation();
		const { x, y } = this.pointOnPage(e, page);
		this.liveStrokePage = page.pageNumber;
		const begin = this.drawingTool === "rectangle" ? beginInkRectangle : beginInkStroke;
		this.liveStroke = begin(
			page.inkLayer,
			(this.plugin.settings.highlightColors as Record<string, string>)[this.popupColor] ??
				this.popupColor,
			this.penWidthPx(),
			this.scale,
			x,
			y
		);
		this.scrollEl.setPointerCapture(e.pointerId);
	}

	private onPenPointerMove(e: PointerEvent): void {
		if (this.rectangleEdit) {
			const edit = this.rectangleEdit;
			const ann = this.data.annotations.find((a) => a.id === edit.id);
			const page = this.pages.find((p) => p.pageNumber === edit.page);
			if (!ann?.ink || !page) return;
			e.preventDefault();
			const point = this.pointOnPage(e, page);
			const bounds = transformRectangle(
				edit.bounds, edit.handle, point.x - edit.startX, point.y - edit.startY,
				page.widthAtScale1, page.heightAtScale1, 8 / this.scale
			);
			ann.ink.points = rectanglePoints(bounds.x, bounds.y, bounds.width, bounds.height);
			ann.rects = [bounds];
			this.redrawInk(page);
			return;
		}
		if (!this.liveStroke) return;
		const page = this.pages.find((p) => p.pageNumber === this.liveStrokePage);
		if (!page) return;
		e.preventDefault();
		const { x, y } = this.pointOnPage(e, page);
		this.liveStroke.addPoint(x, y);
	}

	private onPenPointerEnd(e: PointerEvent, commit: boolean): void {
		if (this.rectangleEdit) {
			void this.finishRectangleEdit(e.pointerId, commit);
			return;
		}
		const stroke = this.liveStroke;
		if (!stroke) return;
		this.liveStroke = null;
		if (this.scrollEl.hasPointerCapture(e.pointerId)) {
			this.scrollEl.releasePointerCapture(e.pointerId);
		}
		if (!commit) {
			stroke.discard();
			return;
		}
		const ink = stroke.finish();
		if (!ink || !this.file) return;
		const page = this.liveStrokePage;
		const ann: Annotation = {
			id: crypto.randomUUID(),
			type: "ink",
			page,
			rects: [inkBoundingRect(ink.points)],
			text: "",
			color: this.popupColor,
			ink,
			createdAt: new Date().toISOString(),
			textOffset: -1,
			contextBefore: "",
			contextAfter: "",
		};
		this.data.annotations.push(ann);
		void this.persistAndRefresh([page]).then((ok) => {
			if (ok) {
				this.history.push({ kind: "add", ann });
				if (ink.shape === "rectangle") {
					this.setDrawingTool(null);
					this.selectedInkId = ann.id;
					this.editingNoteId = ann.id;
					this.redrawAllInk();
					this.popup.showEdit(ann, e.clientX, e.clientY);
				}
			}
			else this.data.annotations = this.data.annotations.filter((a) => a.id !== ann.id);
		});
	}

	private pointOnPage(e: PointerEvent, page: RenderedPage): { x: number; y: number } {
		const rect = page.wrapper.getBoundingClientRect();
		return {
			x: Math.min(Math.max((e.clientX - rect.left) / this.scale, 0), page.widthAtScale1),
			y: Math.min(Math.max((e.clientY - rect.top) / this.scale, 0), page.heightAtScale1),
		};
	}

	private cancelRectangleEdit(): void {
		const edit = this.rectangleEdit;
		if (!edit) return;
		const ann = this.data.annotations.find((a) => a.id === edit.id);
		if (ann) Object.assign(ann, edit.before);
		if (this.scrollEl?.hasPointerCapture(edit.pointerId)) this.scrollEl.releasePointerCapture(edit.pointerId);
		this.rectangleEdit = null;
		this.redrawAllInk();
	}

	private async finishRectangleEdit(pointerId: number, commit: boolean): Promise<void> {
		const edit = this.rectangleEdit;
		if (!edit) return;
		this.rectangleEdit = null;
		if (this.scrollEl.hasPointerCapture(pointerId)) this.scrollEl.releasePointerCapture(pointerId);
		const ann = this.data.annotations.find((a) => a.id === edit.id);
		if (!ann) return;
		if (!commit) {
			Object.assign(ann, edit.before);
			this.redrawAllInk();
			return;
		}
		if (JSON.stringify(ann.ink?.points) === JSON.stringify(edit.before.ink?.points)) return;
		if (!(await this.persistAndRefresh([edit.page]))) {
			Object.assign(ann, edit.before);
			this.redrawAllInk();
			return;
		}
		this.history.push({ kind: "update", before: edit.before, after: cloneAnnotation(ann) });
	}

	private redrawInk(page: RenderedPage): void {
		if (!this.mountedPages.has(page.pageNumber)) return;
		renderInkStrokes(
			page.inkLayer,
			this.data.annotations.filter((a) => a.type === "ink" && a.page === page.pageNumber),
			this.scale,
			this.plugin.settings.highlightColors,
			(ann, x, y) => this.onInkClick(ann, x, y),
			this.selectedInkId
		);
	}

	private redrawAllInk(): void {
		for (const page of this.pages) this.redrawInk(page);
	}

	private onInkClick(ann: Annotation, x: number, y: number): void {
		this.selectedInkId = ann.id;
		this.redrawAllInk();
		if (ann.ink?.shape === "rectangle") {
			this.editingNoteId = ann.id;
			this.hlMenu.hide();
			this.popup.showEdit(ann, x, y);
		} else {
			this.popup.hide();
			this.hlMenu.show(x, y, ann.color);
		}
	}

	// ---- undo / redo ----

	private async applyHistoryOp(op: HistoryOp, dir: HistoryDirection): Promise<boolean> {
		if (!this.file) return false;
		const anns = this.data.annotations;
		if (op.kind === "add") {
			if (dir === "undo") {
				this.data.annotations = anns.filter((a) => a.id !== op.ann.id);
			} else {
				this.data.annotations = [...anns, cloneAnnotation(op.ann)];
			}
		} else if (op.kind === "remove") {
			if (dir === "undo") {
				const list = [...anns];
				op.anns.forEach((ann, i) => {
					list.splice(Math.min(op.indexes[i], list.length), 0, cloneAnnotation(ann));
				});
				this.data.annotations = list;
			} else {
				const ids = new Set(op.anns.map((a) => a.id));
				this.data.annotations = anns.filter((a) => !ids.has(a.id));
			}
		} else {
			const target = dir === "undo" ? op.before : op.after;
			this.data.annotations = anns.map((a) =>
				a.id === target.id ? cloneAnnotation(target) : a
			);
		}
		const ok = await this.persistAndRefresh();
		if (!ok) {
			// persistence failed: applyHistoryOp's caller keeps stack pointers,
			// but data must be restored to match
			new Notice("撤销/重做保存失败，操作已回滚");
			const revertDir: HistoryDirection = dir === "undo" ? "redo" : "undo";
			// re-apply in the opposite direction without saving again is unsafe;
			// simplest consistent fallback: reload handled annotations from disk
			this.data = await this.store.load(this.file.path);
			this.redrawAllHighlights();
			this.redrawAllInk();
			void revertDir;
		}
		return ok;
	}

	private updateHistoryButtons(): void {
		if (this.undoBtn) this.undoBtn.disabled = !this.history.canUndo;
		if (this.redoBtn) this.redoBtn.disabled = !this.history.canRedo;
	}

	/** persist current annotations and refresh overlays + sidebar list */
	private async persistAndRefresh(pages?: number[]): Promise<boolean> {
		if (!this.file) return false;
		const ok = await this.store.save(this.file.path, this.data);
		if (ok) {
			if (pages) {
				for (const p of pages) {
					const page = this.pages.find((pg) => pg.pageNumber === p);
					if (page) {
						this.redrawHighlights(page);
						this.redrawInk(page);
					}
				}
			} else {
				this.redrawAllHighlights();
				this.redrawAllInk();
			}
			this.refreshAnnotationList();
		}
		return ok;
	}

	private refreshAnnotationList(): void {
		if (this.sidebarMode === "annotations") {
			this.sidebar.showAnnotations(this.data.annotations);
		}
	}

	// ---- annotation list interactions + notes export ----

	private async jumpToAnnotation(ann: Annotation): Promise<void> {
		await this.scrollToPage(ann.page);
		this.flashAnnotation(ann.id);
	}

	/** briefly outline the target annotation after a jump */
	private flashAnnotation(id: string): void {
		window.setTimeout(() => {
			const els = this.contentEl.querySelectorAll(
				`[data-annotation-id="${id}"]`
			);
			els.forEach((el) => {
				el.addClass("pr-flash");
				window.setTimeout(() => el.removeClass("pr-flash"), 1300);
			});
		}, 150);
	}

	private async exportAnnotation(ann: Annotation): Promise<void> {
		if (!this.file) return;
		await appendToNotes(
			this.app,
			this.file.path,
			this.plugin.settings.notesSuffix,
			this.notesEntryFor(ann)
		);
	}

	private async exportAllAnnotations(): Promise<void> {
		if (!this.file || this.data.annotations.length === 0) {
			new Notice("暂无可导出的标注");
			return;
		}
		await appendManyToNotes(this.app, this.file.path, this.plugin.settings.notesSuffix,
			this.data.annotations.map(ann => this.notesEntryFor(ann)));
	}

	private notesEntryFor(ann: Annotation): NotesEntry {
		const base = { page: ann.page, annId: ann.id };
		switch (ann.type) {
			case "note":
				return { ...base, title: "批注", quote: ann.text, content: ann.note ?? "" };
			case "translation":
				return { ...base, title: "翻译", quote: ann.text, content: ann.aiContent ?? "" };
			case "ink": {
				const svg = inkPreviewSvg(ann, 120)?.outerHTML ?? "";
				const bytes = new TextEncoder().encode(svg);
				let binary = "";
				for (const byte of bytes) binary += String.fromCharCode(byte);
				const img = `![画笔 p.${ann.page}](data:image/svg+xml;base64,${btoa(binary)})`;
				return { ...base, title: "画笔", quote: "", content: img };
			}
			default:
				return { ...base, title: "高亮", quote: ann.text, content: ann.note ?? "" };
		}
	}

	// ---- selection state ----

	/**
	 * Recompute the current selection payload and sync the header action
	 * group's enabled state. Called on mouseup and (debounced) selectionchange.
	 */
	private refreshSelectionState(): void {
		const sel = window.getSelection();
		let payload: SelectionPayload | null = null;
		if (sel && !sel.isCollapsed && sel.toString().trim()) {
			const anchorEl =
				sel.anchorNode?.nodeType === Node.ELEMENT_NODE
					? (sel.anchorNode as Element)
					: sel.anchorNode?.parentElement;
			// only react to selections inside this view's text layers
			if (anchorEl && this.pagesEl.contains(anchorEl)) {
				payload = selectionToPayload(sel, this.scale, (p) =>
					this.renderer.getPageText(p)
				);
			}
		}
		this.currentPayload = payload;
		for (const page of this.pages) {
			const rects = payload?.page === page.pageNumber ? payload.rects : [];
			if (rects.length || page.wrapper.classList.contains("pr-selection-preview")) {
				renderSelectionPreview(page.selectionLayer, rects, this.scale);
			}
		}
		this.selectionActions?.setEnabled(!!payload);
	}

	private onMouseUp(): void {
		// let the browser finalise the selection first
		window.setTimeout(() => {
			this.refreshSelectionState();
			if (this.plugin.settings.showFloatingToolbar && this.currentPayload) {
				this.hlMenu.hide();
				this.editingNoteId = null;
				this.popup.show(this.currentPayload);
			}
		}, 0);
	}

	private openNotePopup(): void {
		if (!this.currentPayload) return;
		this.editingNoteId = null;
		this.hlMenu.hide();
		this.popup.show(this.currentPayload);
		this.popup.focusNote();
	}

	private withPayload(fn: (payload: SelectionPayload) => void): void {
		if (!this.currentPayload) {
			new Notice("请先在 PDF 中选择文字");
			return;
		}
		fn(this.currentPayload);
	}

	private async commitHighlight(
		color: string,
		payload: SelectionPayload | null = this.currentPayload
	): Promise<void> {
		if (!payload || !this.file) {
			new Notice("请先在 PDF 中选择文字");
			return;
		}
		this.popupColor = color;
		this.selectionActions?.refreshIndicator();
		const annotation = annotationFromPayload(payload, {
			type: "highlight",
			color,
			style: this.popupStyle,
		});
		this.data.annotations.push(annotation);
		if (!(await this.persistAndRefresh([payload.page]))) {
			this.data.annotations = this.data.annotations.filter(
				(a) => a.id !== annotation.id
			);
			return;
		}
		this.history.push({ kind: "add", ann: annotation });
		this.clearSelection();
	}

	// ---- selection popup actions ----

	/** marker menu color picked: annotate selection, or just switch the default */
	private async applyHeaderColor(color: string): Promise<void> {
		this.popupColor = color;
		this.selectionActions?.refreshIndicator();
		if (this.currentPayload) await this.commitHighlight(color);
	}

	/** marker menu style picked: annotate selection, or just switch the default */
	private async applyHeaderStyle(style: AnnotationStyle): Promise<void> {
		this.popupStyle = style;
		if (this.currentPayload) await this.commitHighlight(this.popupColor);
	}

	/** color dot clicked in the popup: annotate selection, or recolor edit target */
	private async applyPopupAnnotation(color: string): Promise<void> {
		if (this.editingNoteId) {
			const ann = this.data.annotations.find((a) => a.id === this.editingNoteId);
			if (ann && this.file) {
				const before = cloneAnnotation(ann);
				ann.color = color;
				if (!(await this.persistAndRefresh())) {
					Object.assign(ann, before);
					return;
				}
				this.history.push({ kind: "update", before, after: cloneAnnotation(ann) });
			}
			this.editingNoteId = null;
			this.popup.hide();
			return;
		}
		// the popup's snapshot survives selection loss from popup interactions
		await this.commitHighlight(color, this.popup.payloadSnapshot ?? this.currentPayload);
	}

	/** style button clicked: remember for the session; also restyle edit target */
	private async setPopupStyle(style: AnnotationStyle): Promise<void> {
		this.popupStyle = style;
		if (this.editingNoteId) {
			const ann = this.data.annotations.find((a) => a.id === this.editingNoteId);
			if (ann && this.file) {
				const before = cloneAnnotation(ann);
				ann.style = style;
				if (!(await this.persistAndRefresh())) {
					Object.assign(ann, before);
					return;
				}
				this.history.push({ kind: "update", before, after: cloneAnnotation(ann) });
			}
		}
	}

	private async setPopupInkWidth(width: number): Promise<void> {
		const ann = this.data.annotations.find((a) => a.id === this.editingNoteId);
		if (!ann?.ink || !this.file || ann.ink.width === width) return;
		const before = cloneAnnotation(ann);
		ann.ink.width = width;
		if (!(await this.persistAndRefresh([ann.page]))) {
			Object.assign(ann, before);
			return;
		}
		this.history.push({ kind: "update", before, after: cloneAnnotation(ann) });
	}

	/** note submitted in the popup: create a note annotation, or update the edit target */
	private async submitNote(text: string): Promise<boolean> {
		if (this.editingNoteId) {
			const ann = this.data.annotations.find((a) => a.id === this.editingNoteId);
			if (ann && this.file) {
				const before = cloneAnnotation(ann);
				ann.note = text;
				// on save failure keep the edited draft in memory (retry-safe),
				// just without the success notice or history entry
				if (!(await this.persistAndRefresh())) return false;
				this.history.push({ kind: "update", before, after: cloneAnnotation(ann) });
				new Notice("批注已更新");
			}
			this.editingNoteId = null;
			this.popup.hide();
			return true;
		}
		const payload = this.popup.payloadSnapshot ?? this.currentPayload;
		if (!payload || !this.file) {
			new Notice("选区已失效，请重新选择后再添加批注");
			return false;
		}
		const annotation = annotationFromPayload(payload, {
			type: "note",
			color: this.popupColor,
			style: "highlight",
			note: text,
		});
		this.data.annotations.push(annotation);
		// Retain the draft as an edit target so retries do not duplicate it.
		this.editingNoteId = annotation.id;
		if (!(await this.persistAndRefresh([payload.page]))) return false;
		this.history.push({ kind: "add", ann: annotation });
		new Notice("批注已添加");
		this.clearSelection();
		return true;
	}

	/** streaming translation for the popup; throws LlmError on config/network issues */
	private async translateForPopup(
		payload: SelectionPayload,
		onChunk: (full: string) => void
	): Promise<string> {
		const s = this.plugin.settings;
		if (!s.llmBaseUrl.trim() || !s.llmApiKey.trim() || !s.llmModel.trim()) {
			throw new LlmError(
				"config",
				"请先在 设置 → Paper Reader 中配置 LLM（Base URL / API Key / 模型名）"
			);
		}
		const file = this.file;
		const data = this.data;
		const document = this.documentToken;
		const messages = buildTranslateMessages(payload.text, s.translateTargetLang);
		let out = "";
		for await (const chunk of this.llm.streamChat(messages)) {
			out += chunk;
			onChunk(out);
		}
		if (this.closed || document !== this.documentToken || this.file !== file || this.data !== data) return out;
		// record as a translation annotation, mirroring the answer panel flow;
		// use the popup's payload directly (selection may be gone by now)
		if (this.file) {
			this.data.annotations.push(
				annotationFromPayload(payload, {
					type: "translation",
					color: "",
					aiContent: out,
				})
			);
			await this.store.save(this.file.path, this.data);
		}
		// selection may have changed while the request was in flight — the
		// result stays bound to the captured snapshot, never the new selection
		if (this.currentPayload && !sameSelection(this.currentPayload, payload)) {
			new Notice("选区已变化，结果仍关联原选中文本");
		}
		return out;
	}

	private async insertPopupTranslation(translation: string): Promise<void> {
		const payload = this.popup.payloadSnapshot ?? this.currentPayload;
		if (!this.file || !payload) {
			new Notice("选区已失效，请重新选择后再插入");
			return;
		}
		await appendToNotes(this.app, this.file.path, this.plugin.settings.notesSuffix, {
			title: "翻译",
			page: payload.page,
			quote: payload.text,
			content: translation,
		});
	}

	/** Remove all highlights on the selection page that overlap the selection. */
	private async clearHighlightsInSelection(): Promise<void> {
		const payload = this.currentPayload;
		if (!payload || !this.file) {
			new Notice("请先在 PDF 中选择文字");
			return;
		}
		const removedAnns: Annotation[] = [];
		const removedIdx: number[] = [];
		this.data.annotations.forEach((a, i) => {
			if (a.type !== "highlight" || a.page !== payload.page) return;
			if (a.rects.some((r1) => payload.rects.some((r2) => rectsOverlap(r1, r2)))) {
				removedAnns.push(a);
				removedIdx.push(i);
			}
		});
		if (removedAnns.length === 0) {
			new Notice("选区内没有高亮");
			return;
		}
		const removedIds = new Set(removedAnns.map((a) => a.id));
		const backup = this.data.annotations;
		this.data.annotations = backup.filter((a) => !removedIds.has(a.id));
		if (!(await this.persistAndRefresh())) {
			this.data.annotations = backup;
			return;
		}
		this.history.push({ kind: "remove", anns: removedAnns, indexes: removedIdx });
		new Notice(`已删除 ${removedAnns.length} 条高亮`);
		this.clearSelection();
	}

	private clearSelection(): void {
		this.currentPayload = null;
		for (const page of this.pages) {
			if (page.wrapper.classList.contains("pr-selection-preview")) {
				renderSelectionPreview(page.selectionLayer, [], this.scale);
			}
		}
		this.editingNoteId = null;
		this.selectionActions?.setEnabled(false);
		this.popup.hide();
		window.getSelection()?.removeAllRanges();
	}

	private async copySelection(): Promise<void> {
		const payload = this.currentPayload;
		if (!payload) {
			new Notice("请先在 PDF 中选择文字");
			return;
		}
		try {
			await navigator.clipboard.writeText(payload.text);
			new Notice("已复制");
		} catch (e) {
			console.error("[paper-reader] clipboard failed", e);
			new Notice("复制失败");
		}
	}

	// ---- AI / LLM ----

	/** Assemble the context text for AI requests per the configured level. */
	private async openAiPanel(mode: PanelMode, payload: SelectionPayload): Promise<void> {
		const request = ++this.aiPanelToken, document = this.documentToken;
		try {
			const context = await this.contextTextFor(payload);
			if (this.closed || request !== this.aiPanelToken || document !== this.documentToken) return;
			if (mode === "translate") this.panel.openTranslate(payload, context);
			else if (mode === "explain") this.panel.openExplain(payload, context);
			else this.panel.openAsk(payload, context);
		} catch { if (!this.closed && document === this.documentToken) new Notice("无法读取 AI 上下文，请重试"); }
	}

	private async contextTextFor(payload: SelectionPayload): Promise<string> {
		const token = this.documentToken;
		const level = this.plugin.settings.aiContextLevel;
		if (level === "selection") return payload.text;
		const pageText = await this.renderer.getPageTextEnsured(payload.page) || payload.text;
		if (level === "page") return pageText;
		// full text, expanded around the current page within a char budget
		const n = this.renderer.numPages;
		let text = `[page ${payload.page}]\n${pageText}\n`;
		for (let d = 1; d < n && text.length < FULL_TEXT_LIMIT; d++) {
			if (token !== this.documentToken || this.closed) break;
			for (const p of [payload.page - d, payload.page + d]) {
				if (p < 1 || p > n) continue;
				const t = await this.renderer.getPageTextEnsured(p);
				if (!t) continue;
				text += `[page ${p}]\n${t}\n`;
				if (text.length >= FULL_TEXT_LIMIT) break;
			}
		}
		return text.slice(0, FULL_TEXT_LIMIT);
	}

	/** Record completed translations as annotations (type: translation). */
	private async recordAiAnnotation(
		mode: PanelMode,
		payload: SelectionPayload,
		answer: string
	): Promise<void> {
		if (mode !== "translate" || !this.file || this.closed) return;
		this.data.annotations.push(
			annotationFromPayload(payload, {
				type: "translation",
				color: "",
				aiContent: answer,
			})
		);
		if (!(await this.store.save(this.file.path, this.data))) return;
	}

	// ---- existing highlight interactions ----

	private activeAnnotationId: string | null = null;

	private openHighlightMenu(ann: Annotation, x: number, y: number): void {
		this.activeAnnotationId = ann.id;
		this.popup.hide();
		this.hlMenu.show(x, y, ann.color);
	}

	private async recolorHighlight(color: string): Promise<void> {
		const ann = this.data.annotations.find((a) => a.id === this.activeAnnotationId);
		if (!ann || !this.file) return;
		const before = cloneAnnotation(ann);
		ann.color = color;
		if (!(await this.persistAndRefresh())) {
			Object.assign(ann, before);
			return;
		}
		this.history.push({ kind: "update", before, after: cloneAnnotation(ann) });
		this.hlMenu.hide();
	}

	private async deleteHighlight(id = this.activeAnnotationId): Promise<void> {
		if (!this.file) return;
		const idx = this.data.annotations.findIndex((a) => a.id === id);
		if (idx < 0) return;
		const backup = this.data.annotations;
		const removed = backup[idx];
		this.data.annotations = backup.filter((a) => a.id !== removed.id);
		if (!(await this.persistAndRefresh())) {
			this.data.annotations = backup;
			return;
		}
		this.history.push({ kind: "remove", anns: [removed], indexes: [idx] });
		if (this.editingNoteId === id) {
			this.editingNoteId = null;
			this.popup.hide();
		}
		this.selectedInkId = null;
		this.hlMenu.hide();
	}
}
