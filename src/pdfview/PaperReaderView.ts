import { createInkWidthControl, MIN_INK_WIDTH, MAX_INK_WIDTH } from "../toolbar/InkWidthControl";
import { DrawingController, type DrawingTool, type RectangleEdit } from "./DrawingController";
import { t } from "../i18n";
import { ReadingPositionManager } from "./ReadingPositionManager";
import { refreshLeafHeader } from "../obsidian-internals";
import { SearchController } from "../search/SearchController";
import { ItemView, Menu, Modal, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type { ViewStateResult } from "obsidian";
import type PaperReaderPlugin from "../main";
import { PdfRenderer, RenderedPage } from "./PdfRenderer";
import { SelectionPayload, rectsOverlap, renderSelectionPreview, sameSelection, selectionRectsForPage, selectionToPayload, domRangeForText as mappedTextRange, rangeFromPageTextOffset } from "./selection";
import { PopupStateCache } from "./popupCache";
import {
	LiveStroke,
	renderInkStrokes,
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
import { buildPageContext } from "../llm/context";
import { buildTranslateMessages } from "../llm/prompts";
import { OutlineNode } from "../outline/OutlineTree";
import { appendManyToNotes, appendToNotes, NotesEntry } from "../storage/notesWriter";
import { ReadingPosition, llmConfig } from "../settings";
import { SearchHit } from "../search/searchText";
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

const MIN_SCALE = 0.3;
const MAX_SCALE = 5;
const PAGE_GAP = 16;

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
	private pageLabels: string[] | null = null;
	private navigationBack: ReadingPosition[] = [];
	private pendingNoteIds: string[] = [];
	private passwordModal: Modal | null = null;
	private editingRangeId: string | null = null;
	private rangeDrag: { node: Node; offset: number; pointerId: number } | null = null;
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
	/** pending rAF that repaints the drag overlay; 0 when none is queued */
	private selectionPreviewFrame = 0;

	private popup: SelectionPopup;
	private popupCache = new PopupStateCache();
	private hlMenu: HighlightMenu;
	private selectionActions: SelectionActions | null = null;
	private currentPayload: SelectionPayload | null = null;
	/** session-scoped annotation style/color chosen in the popup */
	private popupStyle: AnnotationStyle = "highlight";
	private penBtn: HTMLButtonElement | null = null;
	private rectangleBtn: HTMLButtonElement | null = null;
	private activeAnnotationId: string | null = null;
	private textTool: AnnotationStyle | null = null;
	private savingHighlight = false;
	private popupColor = "yellow";
	private editingNoteId: string | null = null;

	// drawing tool state
	private drawingController: DrawingController | null = null;
	private drawingTool: DrawingTool = null;
	private penWidth = 4;
	private penMenuEl: HTMLElement | null = null;
	private penMenuFlush: (() => void | Promise<void>) | null = null;
	private inkWidthBefore: { annotation: Annotation; token: number } | null = null;
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
	private lastReadingPosition: ReadingPosition | null = null;
	private restoringPosition = false;

	// in-document search
	private searchController: SearchController | null = null;
	private searchBarEl: HTMLElement | null = null;
	private searchInputEl: HTMLInputElement | null = null;
	private searchCountEl: HTMLElement | null = null;
	private searchHits: SearchHit[] = [];
	private currentHit = -1;
	private searchToken = 0;
	private searchDebounce: number | null = null;
	private searchReturnFocus: HTMLElement | null = null;
	private wheelZoomTimer: number | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeTimer: number | null = null;
	private undoMenuBtn: HTMLButtonElement | null = null;
	private redoMenuBtn: HTMLButtonElement | null = null;
	private wheelZoomFactor = 1;
	private wheelZoomPoint = { x: 0, y: 0 };
	private wheelZoomRunning = false;

	constructor(leaf: WorkspaceLeaf, plugin: PaperReaderPlugin) {
		super(leaf);
		this.plugin = plugin;
		// plugin.app is guaranteed set; this.app on the view may not be
		// injected yet when the constructor runs during workspace restore
		this.store = new AnnotationStore(plugin.app, () => this.plugin.settings.annotationSuffix);
		this.llm = new LlmClient(plugin.app, () => llmConfig(plugin.app, this.plugin.settings));

		this.popup = new SelectionPopup({
			getColors: () => this.plugin.settings.highlightColors,
			getStyle: () => this.popupStyle,
			getPageLabel: page => this.pageLabels?.[page - 1] ?? String(page),
			onDismiss: () => { this.activeAnnotationId = null; this.editingNoteId = null; this.redrawAllHighlights(); },
			setStyle: (style) => void this.setPopupStyle(style),
			setInkWidth: (width, commit, id) => this.setPopupInkWidth(width, commit, id),
			applyAnnotation: (color) => void this.applyPopupAnnotation(color),
			copySelection: () => void this.copySelection(),
			onNote: () => void this.openNotePopup(),
			onExplain: payload => void this.openAiPanel("explain", payload),
			submitNote: (text) => this.submitNote(text),
			deleteAnnotation: (id) => this.deleteHighlight(id),
			translate: (payload, onChunk, signal) => this.translateForPopup(payload, onChunk, signal),
			insertTranslation: (t) => this.insertPopupTranslation(t),
			getCached: (key) => this.popupCache.get(key),
			setCached: (key, state) => this.popupCache.merge(key, state),
		}, () => this.contentEl.ownerDocument);
		this.hlMenu = new HighlightMenu(
			{
				onRecolor: (color) => void this.recolorHighlight(color),
				onDelete: () => void this.deleteHighlight(),
			},
			() => this.plugin.settings.highlightColors,
			() => this.contentEl.ownerDocument
		);
		this.sidebar = new ThumbnailSidebar(this.renderer, {
			onSelect: (page) => void this.scrollToPage(page),
			annotationList: {
				onSelect: (ann) => void this.jumpToAnnotation(ann),
				onExport: (ann) => void this.exportAnnotation(ann),
				onExportAll: () => void this.exportAllAnnotations(),
			},
			getColors: () => this.plugin.settings.highlightColors,
			onModeChange: (mode) => this.setSidebarMode(mode),
			hasOutline: () => !!this.outline?.length,
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

		this.scrollEl.tabIndex = -1;
		// Refit "fit width/height" when the pane, sidebar or answer panel changes size.
		this.resizeObserver = new ResizeObserver(() => this.onReaderResize());
		this.resizeObserver.observe(this.contentEl);
		this.resizeObserver.observe(this.scrollEl);
		this.registerDomEvent(this.scrollEl, "wheel", (e: WheelEvent) => this.onZoomWheel(e), { passive: false });
		this.registerDomEvent(this.scrollEl, "scroll", () => {
			this.repositionPopup();
			this.hlMenu.hide();
			this.updateCurrentPageFromScroll();
			this.updateDetails();
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
		this.registerDomEvent(this.scrollEl, "pointermove", (e: PointerEvent) => {
			if (this.rangeDrag) { this.moveRangeEndpoint(e); return; }
			this.onPenPointerMove(e);
			if (!this.drawingTool && (e.buttons & 1) !== 0 && this.pagesEl.contains(e.target as Node)) {
				this.scheduleSelectionPreview();
			}
		});
		this.registerDomEvent(this.scrollEl, "pointerup", (e: PointerEvent) =>
			{
				if (this.rangeDrag) { this.rangeDrag = null; void this.saveRangeEdit(); }
				else this.onPenPointerEnd(e, true);
			}
		);
		this.registerDomEvent(this.scrollEl, "pointercancel", (e: PointerEvent) =>
			{ this.rangeDrag = null; this.cancelRangeEdit(); this.onPenPointerEnd(e, false); }
		);
		// track selection lifecycle to enable/disable the header action group
		this.registerDomEvent(this.contentEl.ownerDocument, "selectionchange", () => {
			if (this.closed) return;
			// Keep the custom selection preview current during keyboard selection.
			this.scheduleSelectionPreview();
			if (this.selectionTimer !== null) window.clearTimeout(this.selectionTimer);
			this.selectionTimer = window.setTimeout(() => this.refreshSelectionState(), 100);
		});
		this.registerDomEvent(this.contentEl.ownerDocument, "keydown", (e: KeyboardEvent) => {
			if (e.defaultPrevented) return;
			if (e.key === "Escape") {
				if (this.searchBarEl && !this.searchBarEl.hasClass("pr-hidden")) {
					e.preventDefault(); this.closeSearch(); return;
				}
				if (this.textTool) this.setTextTool(null);
				if (this.editingRangeId) { this.clearSelection(); return; }
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
				this.activeAnnotationId = null; this.redrawAllHighlights();
				this.hlMenu.hide();
				return;
			}
			if (this.editingRangeId && e.key === "Enter" && !e.isComposing) { e.preventDefault(); void this.saveRangeEdit(); return; }
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
			if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing && !this.isEditableTarget(e.target) &&
				this.app.workspace.getActiveViewOfType(PaperReaderView) === this && e.key.toLowerCase() === "p") {
				e.preventDefault(); this.setDrawingTool(this.drawingTool === "pen" ? null : "pen"); return;
			}
			this.onPageNavKey(e);
		});
		this.registerDomEvent(this.contentEl.ownerDocument, "mousedown", (e: MouseEvent) => {
			const t = e.target as Node;
			if (this.penMenuEl && !this.penMenuEl.contains(t) && !this.headerEl.contains(t)) this.closePenMenu();
			if (!this.popup.contains(t) && !this.headerEl.contains(t) && this.activeAnnotationId) { this.activeAnnotationId = null; this.redrawAllHighlights(); }
			if (this.popup.isVisible && !this.popup.contains(t)) this.popup.hide();
			if (this.hlMenu.isVisible && !this.hlMenu.contains(t)) this.hlMenu.hide();
			const el = e.target as Element;
			if (this.selectedInkId && !el.closest?.(".pr-ink-path, .pr-ink-selection, .pr-ink-handle, .pr-popup, .pr-hl-menu, .pr-header, .pr-pen-popover")) {
				this.selectedInkId = null;
				this.editingNoteId = null;
				this.selectionActions?.refreshIndicator();
				this.redrawAllInk();
			}
		});
		const win = this.contentEl.ownerDocument.defaultView!;
		let density = win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`);
		const densityChanged = () => {
			density.removeEventListener("change", densityChanged);
			density = win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`);
			density.addEventListener("change", densityChanged);
			if (!this.closed) void this.renderAll();
		};
		density.addEventListener("change", densityChanged);
		this.register(() => density.removeEventListener("change", densityChanged));

	}

	async onClose(): Promise<void> {
		this.closePenMenu();
		this.popup.hide();
		this.closed = true;
		if (this.wheelZoomTimer !== null) window.clearTimeout(this.wheelZoomTimer);
		this.wheelZoomTimer = null; this.wheelZoomFactor = 1;
		this.resizeObserver?.disconnect(); this.resizeObserver = null;
		if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
		this.resizeTimer = null;
		this.passwordModal?.close();
		this.cancelRangeEdit();
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
		if (this.selectionPreviewFrame !== 0) {
			window.cancelAnimationFrame(this.selectionPreviewFrame);
			this.selectionPreviewFrame = 0;
		}
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
			annotation?: string;
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
				await this.openFile(file, { page: state.page, annotation: state.annotation });
			} else {
				this.showEmpty(t("文件不存在或不是 PDF: {path}", { path: state.file }));
			}
		}
		await super.setState(state, result);
	}

	async openFile(file: TFile, opts?: { page?: number; annotation?: string }): Promise<void> {
		this.closePenMenu();
		this.popup.hide();
		this.inkWidthBefore = null;
		this.passwordModal?.close();
		const token = ++this.documentToken;
		this.panel?.close();
		this.file = file;
		this.lastReadingPosition = null;
		this.currentPayload = null;
		this.editingNoteId = null;
		this.popupCache.clear();
		this.pendingNoteIds = [];
		this.navigationBack = [];
		this.cancelRangeEdit();
		this.selectedInkId = null;
		this.setDrawingTool(null);
		this.history.clear();
		this.closeSearch();
		this.currentPage = 1;
		this.popup.hide();
		this.hlMenu.hide();
		this.showEmpty(t("加载中…"));
		try {
			const buf = await this.app.vault.readBinary(file);
			if (token !== this.documentToken || this.closed) return;
			await this.renderer.load(buf, { ownerDocument: this.contentEl.ownerDocument,
				onPassword: (update, reason) => this.requestPdfPassword(update, reason) });
			if (token !== this.documentToken || this.closed) return;
			const store = new AnnotationStore(this.app, () => this.plugin.settings.annotationSuffix);
			const data = await store.load(file.path);
			if (token !== this.documentToken || this.closed) return;
			this.store = store; this.data = data;
			const dims = await this.renderer.getPageDims(1);
			const outline = await this.renderer.getOutline().catch(() => null);
			if (token !== this.documentToken || this.closed) return;
			this.baseDims = dims; this.outline = outline;
			this.pageLabels = await this.renderer.getPageLabels();
		} catch (e) {
			if (token !== this.documentToken || this.closed) return;
			console.error("[paper-reader] failed to load pdf", e);
			this.showEmpty(t("PDF 加载失败: {path}", { path: file.path }));
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
		if (opts?.annotation) {
			const ann = this.data.annotations.find(a => a.id === opts.annotation);
			if (ann) await this.jumpToAnnotation(ann);
		}
		// refresh leaf tab title
		refreshLeafHeader(this.leaf);
		this.lastReadingPosition = this.currentPosition();
	}


	/** "/ total" beside the page box; the physical page is shown only when the PDF label differs. */
	private pageCountLabel(): string {
		const total = this.renderer.numPages;
		const label = this.pageLabels?.[this.currentPage - 1];
		return label && label !== String(this.currentPage) ? `(${this.currentPage} / ${total})` : `/ ${total}`;
	}

	private requestPdfPassword(update: (password: string) => void, reason: number): void {
		const modal = new Modal(this.app);
		this.passwordModal = modal;
		modal.titleEl.setText(reason === 2 ? t("密码错误，请重试") : t("此 PDF 需要密码"));
		const input = modal.contentEl.createEl("input", { attr: { type: "password", "aria-label": t("PDF 密码") } });
		let accepted = false;
		const submit = () => { accepted = true; update(input.value); modal.close(); };
		modal.contentEl.createEl("button", { text: t("打开") }).addEventListener("click", submit);
		input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) submit(); });
		modal.onClose = () => {
			if (this.passwordModal === modal) this.passwordModal = null;
			if (!accepted) void this.renderer.destroy();
		};
		this.register(() => { accepted = true; modal.close(); });
		modal.open(); input.focus();
	}

	private rememberNavigation(): void {
		const position = this.currentPosition();
		if (position) { this.navigationBack.push(position); if (this.navigationBack.length > 30) this.navigationBack.shift(); }
	}

	private async goBack(): Promise<void> {
		const position = this.navigationBack.pop();
		if (!position) return;
		if (this.layoutMode === "single") await this.scrollToPage(position.page);
		await this.restorePosition(position);
	}

	private async followPdfLink(dest: string | unknown[]): Promise<void> {
		const token = this.documentToken;
		const page = await this.renderer.resolveDestination(dest);
		if (page === null || token !== this.documentToken || this.closed) return;
		this.rememberNavigation();
		this.clearSelection();
		await this.scrollToPage(page);
	}

	private scrollToRect(pageNumber: number, rect?: { x: number; y: number; width: number; height: number }): void {
		const page = this.pages.find(p => p.pageNumber === pageNumber);
		if (!page || !rect) return;
		const pageBounds = page.wrapper.getBoundingClientRect(), viewBounds = this.scrollEl.getBoundingClientRect();
		this.scrollEl.scrollTop += pageBounds.top + rect.y * this.scale - viewBounds.top - this.scrollEl.clientHeight / 3;
		this.scrollEl.scrollLeft += Math.max(0, pageBounds.left + rect.x * this.scale - viewBounds.right + rect.width * this.scale + 16);
	}

	private updateDetails(): void {
		const bounds = this.scrollEl.getBoundingClientRect();
		for (const page of this.pages) if (this.mountedPages.has(page.pageNumber)) void this.renderer.updateDetail(page, bounds).catch(error => console.error("[paper-reader] detail render failed", error));
	}

	private repositionPopup(): void {
		if (!this.popup.isVisible) return;
		const id = this.editingNoteId;
		const ann = id ? this.data.annotations.find(a => a.id === id) : null;
		const selection = this.activeTextSelection();
		if (ann) {
			const page = this.pages.find(p => p.pageNumber === ann.page), rect = ann.rects[0];
			if (page && rect) {
				const bounds = page.wrapper.getBoundingClientRect();
				this.popup.reposition(new DOMRect(bounds.left + rect.x * this.scale, bounds.top + rect.y * this.scale, rect.width * this.scale, rect.height * this.scale));
			}
		} else if (selection) this.popup.reposition(selection.getRangeAt(0).getBoundingClientRect());
	}

	private annotationsForPayload(payload: SelectionPayload, fields: Parameters<typeof annotationFromPayload>[1]): Annotation[] {
		const annotations = (payload.segments ?? [payload]).map(segment => annotationFromPayload(segment, fields));
		if (annotations.length > 1) for (const ann of annotations) ann.groupId = annotations[0].id;
		return annotations;
	}

	private annotationGroup(ann: Annotation): Annotation[] {
		return ann.groupId ? this.data.annotations.filter(a => a.groupId === ann.groupId) : [ann];
	}

	private recordAdded(annotations: Annotation[]): void {
		const ops: HistoryOp[] = annotations.map(ann => ({ kind: "add", ann: cloneAnnotation(ann) }));
		this.history.push(ops.length === 1 ? ops[0] : { kind: "batch", ops });
	}

	private recordUpdates(before: Annotation[], after: Annotation[]): void {
		const ops: HistoryOp[] = before.map((ann, i) => ({ kind: "update", before: ann, after: cloneAnnotation(after[i]) }));
		this.history.push(ops.length === 1 ? ops[0] : { kind: "batch", ops });
	}

	private async updateGroup(ann: Annotation, fields: Partial<Annotation>): Promise<boolean> {
		const group = this.annotationGroup(ann), before = group.map(a => cloneAnnotation(a));
		for (const item of group) Object.assign(item, fields);
		if (!(await this.persistAndRefresh())) { group.forEach((item, i) => Object.assign(item, before[i])); return false; }
		this.recordUpdates(before, group);
		return true;
	}

	// ---- reading position persistence ----

	/**
	 * Apply a saved position's layout/zoom/page BEFORE rendering, so the
	 * saved page exists in all layout modes (single-page renders currentPage
	 * only). Page is clamped for PDFs that lost pages.
	 */
	private prepareSavedLayout(saved: ReadingPosition): void {
		const position = ReadingPositionManager.normalize(saved, this.renderer.numPages);
		this.layoutMode = position.layoutMode as LayoutMode;
		this.zoomMode = position.zoomMode as ZoomMode;
		if (this.zoomMode === "manual") this.scale = position.scale;
		this.currentPage = position.page;
	}

	private savedPositionFor(path: string): ReadingPosition | undefined {
		// exact path only: same-named PDFs in different folders stay isolated.
		// renames are handled by the vault "rename" event in main.ts.
		return this.plugin.settings.readingPositions[path];
	}

	private currentPosition(): ReadingPosition | null {
		if (!this.file || !this.scrollEl.clientHeight || !this.pages[0]?.wrapper.offsetHeight) return null;
		return ReadingPositionManager.capture(this.pages, this.scrollEl.scrollTop, this.scrollEl.clientHeight,
			{ zoomMode: this.zoomMode, scale: this.scale, layoutMode: this.layoutMode });
	}

	private schedulePositionSave(): void {
		if (!this.file || this.restoringPosition) return;
		this.lastReadingPosition = this.currentPosition() ?? this.lastReadingPosition;
		if (this.positionTimer !== null) window.clearTimeout(this.positionTimer);
		this.positionTimer = window.setTimeout(() => {
			this.positionTimer = null;
			void this.savePositionNow();
		}, 800);
	}

	private async savePositionNow(): Promise<void> {
		const pos = (this.closed ? null : this.currentPosition()) ?? this.lastReadingPosition;
		if (!pos || !this.file) return;
		// A pending debounce must not resurrect a deleted document record.
		if (this.app.vault.getAbstractFileByPath && !this.app.vault.getAbstractFileByPath(this.file.path)) return;
		this.plugin.settings.readingPositions[this.file.path] = pos;
		await this.plugin.saveSettings();
	}

	private async restorePosition(saved: ReadingPosition): Promise<void> {
		this.restoringPosition = true;
		try {
			const position = ReadingPositionManager.normalize(saved, this.renderer.numPages);
			const page = position.page;
			const rendered = this.pages.find(p => p.pageNumber === page);
			if (!rendered) return;
			this.scrollEl.scrollTop = ReadingPositionManager.scrollTop(rendered, position.pageFraction, this.scrollEl.clientHeight);
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
			attr: { type: "text", placeholder: t("在本文档中搜索…") },
		});
		this.searchCountEl = bar.createSpan({ cls: "pr-search-count" });
		const mkBtn = (icon: string, tooltip: string, onClick: () => void) => {
			const btn = bar.createEl("button", { cls: "pr-header-btn clickable-icon" });
			setIcon(btn, icon);
			btn.setAttr("aria-label", tooltip);
			btn.addEventListener("mousedown", (e) => e.preventDefault());
			btn.addEventListener("click", onClick);
		};
		mkBtn("chevron-up", t("上一个 (Shift+Enter)"), () => void this.gotoHit(-1));
		mkBtn("chevron-down", t("下一个 (Enter)"), () => void this.gotoHit(1));
		mkBtn("x", t("关闭 (Esc)"), () => this.closeSearch());
		this.searchInputEl.addEventListener("input", () => {
			this.searchToken++;
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
		if (this.searchBarEl.hasClass("pr-hidden")) {
			const active = this.contentEl.ownerDocument.activeElement;
			this.searchReturnFocus = active !== this.contentEl.ownerDocument.body ? active as HTMLElement | null : null;
		}
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
		const focus = this.searchReturnFocus;
		this.searchReturnFocus = null;
		if (!this.closed && focus?.isConnected) focus.focus({ preventScroll: true });
		else if (!this.closed) this.scrollEl?.focus({ preventScroll: true });
	}

	private clearSearchHighlights(): void {
		for (const page of this.pages) {
			page.highlightLayer
				.querySelectorAll(".pr-search-hit")
				.forEach((el) => el.remove());
		}
	}

	private getSearchController(): SearchController {
		if (!this.searchController) {
			const view = this;
			this.searchController = new SearchController({
				get token() { return view.searchToken; }, set token(value) { view.searchToken = value; },
				get hits() { return view.searchHits; }, set hits(value) { view.searchHits = value; },
				get current() { return view.currentHit; }, set current(value) { view.currentHit = value; },
			}, {
				renderer: this.renderer, input: () => this.searchInputEl, count: () => this.searchCountEl,
				hasFile: () => !!this.file, pages: () => this.pages, scale: () => this.scale,
				clearHighlights: () => this.clearSearchHighlights(), rememberNavigation: () => this.rememberNavigation(),
				scrollToPage: page => this.scrollToPage(page), domRangeForText: (wrapper, start, length) => this.domRangeForText(wrapper, start, length),
				scrollToRect: (page, rect) => this.scrollToRect(page, rect),
			});
		}
		return this.searchController;
	}

	private runSearch(): Promise<void> { return this.getSearchController().run(); }
	private gotoHit(dir: number, absolute = false): Promise<void> { return this.getSearchController().goto(dir, absolute); }
	private applySearchHighlights(current: SearchHit): void { this.getSearchController().applyHighlights(current); }

	/** locate [start, start+length) of the page's extracted text inside the text layer DOM */
	private domRangeForText(
		pageWrapper: HTMLElement,
		start: number,
		length: number
	): Range | null {
		const textLayer = pageWrapper.querySelector(".textLayer");
		if (!textLayer) return null;
		return mappedTextRange(textLayer, start, length);
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
			const btn = buttonParent.createEl("button", { cls: "pr-header-btn clickable-icon" });
			setIcon(btn, icon);
			btn.createSpan({ cls: "pr-sr-only", text: tooltip });
			btn.addEventListener("click", (e) => onClick(e));
			return btn;
		};

		const start = this.headerEl.createDiv({ cls: "pr-header-start" });
		const center = this.headerEl.createDiv({ cls: "pr-header-center" });
		const end = this.headerEl.createDiv({ cls: "pr-header-end" });
		// A main button and its dropdown read as one split control.
		const group = (parent: HTMLElement, cls: string): HTMLElement => (buttonParent = parent.createDiv({ cls }));
		const mkChevron = (tooltip: string, onClick: (e: MouseEvent) => void): HTMLButtonElement => {
			const btn = mkBtn("chevron-down", tooltip, onClick);
			btn.addClass("pr-header-chevron");
			return btn;
		};
		let buttonParent: HTMLElement = start;
		group(start, "pr-split");
		mkBtn("panel-left", t("切换侧栏"), () => void this.toggleSidebar());
		mkChevron(t("侧栏选项"), (e) => this.openSidebarMenu(e));
		start.createDiv({ cls: "pr-divider" });
		group(start, "pr-tool-group pr-hide-narrow");
		mkBtn("zoom-out", t("缩小"), () => void this.zoomBy(1 / 1.2));
		mkBtn("zoom-in", t("放大"), () => void this.zoomBy(1.2));
		group(start, "pr-split");
		mkBtn("move-horizontal", t("适应宽度"), () => void this.setZoomMode("fit-width"));
		mkChevron(t("缩放与布局选项"), (e) => this.openZoomMenu(e));
		start.createDiv({ cls: "pr-divider pr-hide-compact" });
		group(start, "pr-tool-group pr-hide-compact");
		mkBtn("undo-2", t("返回上一阅读位置"), () => void this.goBack());
		mkBtn("chevron-up", t("上一页"), () => void this.scrollToPage(this.currentPage - 1));
		mkBtn("chevron-down", t("下一页"), () => void this.scrollToPage(this.currentPage + 1));

		// selection action group
		this.selectionActions = new SelectionActions(
			{
				getColor: () => this.data.annotations.find(a => a.id === this.selectedInkId && a.ink)?.color ?? this.popupColor,
				getStyle: () => this.popupStyle,
				getMode: () => this.textTool,
				isDrawing: () => this.drawingTool !== null,
				canPickColor: () => !!(this.textTool || this.drawingTool || this.currentPayload || this.data.annotations.some(a => a.id === this.selectedInkId && a.ink)),
				setMode: (style) => this.setTextTool(style),
				applyColor: (key) => void this.applyHeaderColor(key),
				applyStyle: (style) => void this.applyHeaderStyle(style),
				onClearHighlight: () => void this.clearHighlightsInSelection(),
				onCopy: () => void this.copySelection(),
				onNote: () => void this.openNotePopup(),
				onTranslate: () => this.withPayload(p => void this.openAiPanel("translate", p)),
				onExplain: () => this.withPayload(p => void this.openAiPanel("explain", p)),
				onAsk: () => this.withPayload(p => void this.openAiPanel("ask", p)),
			},
			() => this.plugin.settings.highlightColors
		);
		this.selectionActions.setEnabled(!!this.currentPayload);
		center.appendChild(this.selectionActions.el);
		end.appendChild(this.selectionActions.secondaryEl);
		// Controls hidden from a narrow header stay reachable from the overflow menu.
		const overflow = this.selectionActions.addOverflowItems([
			{ icon: "undo-2", label: t("返回上一阅读位置"), cls: "pr-only-compact", onClick: () => void this.goBack() },
			{ icon: "chevron-up", label: t("上一页"), cls: "pr-only-compact", onClick: () => void this.scrollToPage(this.currentPage - 1) },
			{ icon: "chevron-down", label: t("下一页"), cls: "pr-only-compact", onClick: () => void this.scrollToPage(this.currentPage + 1) },
			{ icon: "zoom-out", label: t("缩小"), cls: "pr-only-narrow", onClick: () => void this.zoomBy(1 / 1.2) },
			{ icon: "zoom-in", label: t("放大"), cls: "pr-only-narrow", onClick: () => void this.zoomBy(1.2) },
			{ icon: "scan", label: t("矩形框"), cls: "pr-only-narrow", onClick: () => this.setDrawingTool(this.drawingTool === "rectangle" ? null : "rectangle") },
			{ icon: "undo-2", label: t("撤销 (Cmd/Ctrl+Z)"), cls: "pr-only-narrow", onClick: () => void this.history.undo() },
			{ icon: "redo-2", label: t("重做 (Cmd/Ctrl+Shift+Z)"), cls: "pr-only-narrow", onClick: () => void this.history.redo() },
		]);
		this.undoMenuBtn = overflow[6];
		this.redoMenuBtn = overflow[7];

		// PDF label followed by physical page / total, beside page navigation
		const pageWrap = start.createDiv({ cls: "pr-page-wrap" });
		this.pageInputEl = pageWrap.createEl("input", {
			cls: "pr-page-input",
			attr: { type: "text", id: `pr-page-${crypto.randomUUID()}` },
		});
		pageWrap.createEl("label", { cls: "pr-sr-only", text: t("页码"), attr: { for: this.pageInputEl.id } });
		this.pageInputEl.value = this.pageLabels?.[this.currentPage - 1] ?? String(this.currentPage);
		this.pageInputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.isComposing) {
				const value = this.pageInputEl?.value.trim() ?? "";
				const labelIndex = this.pageLabels?.indexOf(value) ?? -1;
				const n = labelIndex >= 0 ? labelIndex + 1 : Number(value);
				if (value && Number.isInteger(n)) void this.scrollToPage(n);
				this.pageInputEl?.blur();
			}
			e.stopPropagation();
		});
		this.pageInputEl.addEventListener("blur", () => {
			if (this.pageInputEl) this.pageInputEl.value = this.pageLabels?.[this.currentPage - 1] ?? String(this.currentPage);
		});
		this.pageTotalEl = pageWrap.createSpan({
			cls: "pr-page-total",
			text: this.pageCountLabel(),
		});
		buttonParent = center;
		this.rectangleBtn = mkBtn("scan", t("矩形框（再次点击或 Esc 退出）"), () =>
			this.setDrawingTool(this.drawingTool === "rectangle" ? null : "rectangle"));
		this.rectangleBtn.addClass("pr-hide-narrow");
		group(center, "pr-split");
		this.rectangleBtn.toggleClass("pr-pen-on", this.drawingTool === "rectangle");
		this.rectangleBtn.setAttr("aria-pressed", String(this.drawingTool === "rectangle"));
		this.penBtn = mkBtn("pencil", t("画笔（P 切换，Esc 退出）"), () =>
			this.setDrawingTool(this.drawingTool === "pen" ? null : "pen"));
		this.penBtn.toggleClass("pr-pen-on", this.drawingTool === "pen");
		this.penBtn.setAttr("aria-pressed", String(this.drawingTool === "pen"));
		mkChevron(t("画笔粗细"), e => this.openPenMenu(e));
		buttonParent = center;
		center.createDiv({ cls: "pr-divider" });
		center.appendChild(this.selectionActions.colorButton);
		center.createDiv({ cls: "pr-divider pr-hide-narrow" });
		group(center, "pr-tool-group pr-hide-narrow");
		this.undoBtn = mkBtn("undo-2", t("撤销 (Cmd/Ctrl+Z)"), () => void this.history.undo());
		this.redoBtn = mkBtn("redo-2", t("重做 (Cmd/Ctrl+Shift+Z)"), () => void this.history.redo());
		this.updateHistoryButtons();
		buttonParent = end;
		mkBtn("search", t("搜索文档 (Cmd/Ctrl+F)"), () => this.openSearch());
	}

	private openSidebarMenu(e: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(t("缩略图"))
				.setIcon("image")
				.setChecked(this.sidebarMode === "thumbs")
				.onClick(() => this.setSidebarMode("thumbs"))
		);
		menu.addItem((item) =>
			item
				.setTitle(t("目录"))
				.setIcon("list")
				.setChecked(this.sidebarMode === "outline")
				.setDisabled(!this.outline || this.outline.length === 0)
				.onClick(() => this.setSidebarMode("outline"))
		);
		menu.addItem((item) =>
			item
				.setTitle(t("标注"))
				.setIcon("list-checks")
				.setChecked(this.sidebarMode === "annotations")
				.onClick(() => this.setSidebarMode("annotations"))
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(t("显示当前所在目录"))
				.setIcon("locate")
				.setChecked(this.followOutline)
				.setDisabled(!this.outline || this.outline.length === 0)
				.onClick(() => this.setFollowOutline(!this.followOutline))
		);
		menu.showAtMouseEvent(e);
	}

	private closePenMenu(): void {
		void this.penMenuFlush?.(); this.penMenuFlush = null;
		this.penMenuEl?.remove(); this.penMenuEl = null;
	}

	private openPenMenu(e: MouseEvent): void {
		if (this.penMenuEl) { this.closePenMenu(); return; }
		this.popup.hide();
		const ann = this.data.annotations.find(a => a.id === this.selectedInkId && a.ink);
		const id = ann?.id, token = this.documentToken;
		const el = this.contentEl.ownerDocument.body.createDiv({ cls: "pr-pen-popover pr-popup" });
		this.penMenuEl = el;
		this.penMenuFlush = createInkWidthControl(el, ann?.ink?.width ?? this.penWidth,
			(width, commit) => {
				if (token !== this.documentToken || this.closed) return;
				if (id) return this.setPopupInkWidth(width, commit, id);
				else this.penWidth = width;
			});
		el.style.left = `${Math.max(8, Math.min(e.clientX, (el.ownerDocument.defaultView?.innerWidth ?? 1000) - 300))}px`;
		el.style.top = `${e.clientY + 12}px`;
		el.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); this.closePenMenu(); } });
	}

	private openZoomMenu(e: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(t("适应宽度"))
				.setChecked(this.zoomMode === "fit-width")
				.onClick(() => void this.setZoomMode("fit-width"))
		);
		menu.addItem((item) =>
			item
				.setTitle(t("适应高度"))
				.setChecked(this.zoomMode === "fit-height")
				.onClick(() => void this.setZoomMode("fit-height"))
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(t("连续滚动"))
				.setChecked(this.layoutMode === "continuous")
				.onClick(() => void this.setLayoutMode("continuous"))
		);
		menu.addItem((item) =>
			item
				.setTitle(t("单页"))
				.setChecked(this.layoutMode === "single")
				.onClick(() => void this.setLayoutMode("single"))
		);
		menu.addItem((item) =>
			item
				.setTitle(t("双页（奇数）"))
				.setChecked(this.layoutMode === "double-odd")
				.onClick(() => void this.setLayoutMode("double-odd"))
		);
		menu.addItem((item) =>
			item
				.setTitle(t("双页（偶数）"))
				.setChecked(this.layoutMode === "double-even")
				.onClick(() => void this.setLayoutMode("double-even"))
		);
		menu.addSeparator();
		const isDark = document.body.classList.contains("theme-dark");
		menu.addItem((item) =>
			item
				.setTitle(t("适应主题（暗色反色）"))
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

	private onReaderResize(): void {
		if (this.closed) return;
		const width = this.contentEl.clientWidth;
		this.contentEl.toggleClass("pr-compact", width > 0 && width < 1000);
		this.contentEl.toggleClass("pr-narrow", width > 0 && width < 720);
		if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
		this.resizeTimer = window.setTimeout(() => {
			this.resizeTimer = null;
			void this.refitAfterResize();
		}, 120);
	}

	private async refitAfterResize(): Promise<void> {
		if (this.closed || this.zoomMode === "manual" || this.pages.length === 0) return;
		// Re-rendering mid-gesture would drop the stroke or range being dragged.
		if (this.liveStroke || this.rangeDrag) { this.onReaderResize(); return; }
		const next = this.computeScale();
		if (Math.abs(next - this.scale) <= this.scale * 0.01) return;
		await this.renderAll();
	}

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

	/** Chromium delivers trackpad pinch as a Ctrl+wheel event. Batch the gesture and
	 * keep its PDF point under the cursor; ordinary wheel events remain scrolling. */
	private onZoomWheel(e: WheelEvent): void {
		if ((!e.ctrlKey && !e.metaKey) || !this.file || !this.pages.length || e.deltaY === 0) return;
		e.preventDefault();
		const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.scrollEl.clientHeight : 1);
		this.wheelZoomFactor *= Math.exp(-Math.max(-200, Math.min(200, delta)) * 0.002);
		this.wheelZoomPoint = { x: e.clientX, y: e.clientY };
		if (this.wheelZoomTimer !== null) window.clearTimeout(this.wheelZoomTimer);
		this.wheelZoomTimer = window.setTimeout(() => { this.wheelZoomTimer = null; void this.flushWheelZoom(); }, 50);
	}

	private async flushWheelZoom(): Promise<void> {
		if (this.wheelZoomRunning || this.closed || this.wheelZoomFactor === 1) return;
		const factor = this.wheelZoomFactor, point = this.wheelZoomPoint;
		this.wheelZoomFactor = 1;
		const page = this.pages.find(p => {
			const r = p.wrapper.getBoundingClientRect();
			return point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
		}) ?? this.pages.find(p => p.pageNumber === this.currentPage);
		if (!page) return;
		const rect = page.wrapper.getBoundingClientRect();
		const x = (point.x - rect.left) / this.scale, y = (point.y - rect.top) / this.scale;
		const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
		if (next === this.scale) return;
		this.wheelZoomRunning = true;
		this.zoomMode = "manual"; this.scale = next;
		try {
			await this.renderAll(() => {
				const updated = this.pages.find(p => p.pageNumber === page.pageNumber)?.wrapper.getBoundingClientRect();
				if (!updated) return;
				this.scrollEl.scrollLeft += updated.left + x * this.scale - point.x;
				this.scrollEl.scrollTop += updated.top + y * this.scale - point.y;
				this.updateCurrentPageFromScroll();
			});
			this.schedulePositionSave();
		} finally {
			this.wheelZoomRunning = false;
			if (this.wheelZoomFactor !== 1 && !this.closed) void this.flushWheelZoom();
		}
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

	private async renderAll(onLayout?: () => void): Promise<void> {
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
		onLayout?.();
		await this.refreshPageWindow();
	}

	private async renderOnePage(
		pageNumber: number,
		token: number,
		parent: HTMLElement
	): Promise<boolean> {
		if (token !== this.renderToken) return false;
		let rendered: RenderedPage;
		try { rendered = await this.renderer.createPlaceholder(pageNumber, this.scale, this.contentEl.ownerDocument); }
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
		const center = (bounds.top + bounds.bottom) / 2;
		const geometry = this.pages.map(page => ({ page, rect: page.wrapper.getBoundingClientRect() }));
		const visiblePages = new Set(geometry.filter(({ rect }) =>
			rect.bottom > bounds.top && rect.top < bounds.bottom).map(({ page }) => page.pageNumber));
		if (!visiblePages.size) visiblePages.add(this.currentPage);
		// Match Zotero's buffer policy: visible pages, immediate neighbors, two recent pages.
		this.wantedPages = new Set(visiblePages);
		for (const number of visiblePages) {
			for (const neighbor of [number + 1, number - 1]) {
				if (this.pages.some(page => page.pageNumber === neighbor)) this.wantedPages.add(neighbor);
			}
			if (this.mountedPages.delete(number)) this.mountedPages.add(number);
		}
		const ordered = geometry.filter(({ page }) => this.wantedPages.has(page.pageNumber))
			.sort((a, b) => Number(visiblePages.has(b.page.pageNumber)) - Number(visiblePages.has(a.page.pageNumber)) ||
				Math.abs((a.rect.top + a.rect.bottom) / 2 - center) - Math.abs((b.rect.top + b.rect.bottom) / 2 - center));
		this.wantedPages = new Set(ordered.map(({ page }) => page.pageNumber));
		const recent = [...this.mountedPages].filter(number => !this.wantedPages.has(number)).slice(-2);
		for (const number of recent) this.wantedPages.add(number);
		const selection = this.scrollEl.ownerDocument.getSelection();
		const editingPages = this.data.annotations.filter(a => a.id === this.editingRangeId || (this.editingRangeId && a.groupId === this.editingRangeId)).map(a => a.page);
		const selectionRange = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
		for (const page of this.pages) {
			if ((selection?.anchorNode && page.wrapper.contains(selection.anchorNode)) ||
				(selection?.focusNode && page.wrapper.contains(selection.focusNode)) ||
				selectionRange?.intersectsNode(page.wrapper) || editingPages.includes(page.pageNumber) ||
				(this.liveStroke && page.pageNumber === this.liveStrokePage) || page.pageNumber === this.rectangleEdit?.page) {
				this.wantedPages.add(page.pageNumber);
			}
			if (this.mountedPages.has(page.pageNumber) && !this.wantedPages.has(page.pageNumber)) {
				this.renderer.releasePage(page); this.mountedPages.delete(page.pageNumber);
			}
		}
		if (this.pageRender && (!this.wantedPages.has(this.pageRender.page) ||
			(!visiblePages.has(this.pageRender.page) && [...visiblePages].some(page =>
				this.wantedPages.has(page) && !this.mountedPages.has(page) && !this.failedPages.has(page))))) {
			this.pageRender.abort.abort();
		}
		if (!this.pageWindowTask) {
			this.pageWindowTask = Promise.resolve().then(async () => {
				while (!this.closed) {
					const number = [...this.wantedPages].find(p => !this.mountedPages.has(p) && !this.failedPages.has(p));
					const slot = this.pages.find(p => p.pageNumber === number);
					if (!slot) break;
					const token = this.renderToken, abort = new AbortController();
					this.pageRender = { page: slot.pageNumber, abort };
					try {
						const rendered = await this.renderer.renderPage(slot.pageNumber, this.scale, abort.signal, this.contentEl.ownerDocument, link => { if (link.dest) void this.followPdfLink(link.dest); }, slot);
						if (token !== this.renderToken || abort.signal.aborted || this.closed) { this.renderer.releasePage(rendered); continue; }
						const wrapper = slot.wrapper;
						if (wrapper !== rendered.wrapper) wrapper.replaceChildren(...Array.from(rendered.wrapper.childNodes));
						Object.assign(slot, rendered, { wrapper });
						this.renderer.adoptPage(rendered, slot);
						this.mountedPages.add(slot.pageNumber);
						this.redrawHighlights(slot); this.redrawInk(slot);
						const hit = this.searchHits[this.currentHit];
						if (hit?.page === slot.pageNumber) this.applySearchHighlights(hit);
					} catch (error) {
						if (!abort.signal.aborted && token === this.renderToken && !this.closed) {
							this.failedPages.add(slot.pageNumber);
							this.showPageRenderError(slot);
							console.error("[paper-reader] page render failed", error);
						}
					} finally { this.pageRender = null; }
				}
			}).finally(() => { this.pageWindowTask = null; });
		}
		await this.pageWindowTask;
		this.updateDetails();
	}

	private showPageRenderError(page: RenderedPage): void {
		this.renderer.releasePage(page);
		page.wrapper.querySelector(".pr-page-error")?.remove();
		const error = page.wrapper.createDiv({ cls: "pr-page-error", attr: { role: "status" } });
		error.createSpan({ text: t("第 {page} 页渲染失败", { page: page.pageNumber }) });
		const retry = error.createEl("button", { text: t("重试此页"), attr: { type: "button" } });
		retry.addEventListener("click", () => {
			if (this.closed || !this.pages.includes(page)) return;
			error.remove(); this.failedPages.delete(page.pageNumber);
			void this.refreshPageWindow();
		});
	}

	private redrawHighlights(page: RenderedPage): void {
		if (!this.mountedPages.has(page.pageNumber)) return;
		const annotations = this.data.annotations.filter(
			(a) =>
				(a.type === "highlight" || a.type === "note") &&
				a.page === page.pageNumber
		);
		const selected = this.data.annotations.find(a => a.id === this.activeAnnotationId);
		renderHighlightRects(
			page.highlightLayer,
			annotations,
			this.scale,
			this.plugin.settings.highlightColors,
			(ann, x, y) => this.onAnnotationClick(ann, x, y),
			selected ? this.annotationGroup(selected).map(a => a.id) : []
		);
	}

	/** A single click selects an existing annotation and opens its comment. */
	private onAnnotationClick(ann: Annotation, x: number, y: number): void {
		this.openHighlightMenu(ann, x, y);
	}

	private redrawAllHighlights(): void {
		for (const page of this.pages) this.redrawHighlights(page);
	}

	// ---- current page tracking / navigation ----

	private updateCurrentPage(page: number): void {
		this.currentPage = page;
		if (this.pageInputEl && this.contentEl.ownerDocument.activeElement !== this.pageInputEl) {
			this.pageInputEl.value = this.pageLabels?.[page - 1] ?? String(page);
		}
		if (this.pageTotalEl) {
			this.pageTotalEl.setText(this.pageCountLabel());
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
		if (this.layoutMode !== "single" || e.defaultPrevented) return;
		if ((e.target as Element | null)?.closest?.(".pr-popup, .pr-hl-menu, .pr-sidebar, button")) return;
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
		this.penBtn?.setAttr("aria-pressed", String(tool === "pen"));
		this.rectangleBtn?.setAttr("aria-pressed", String(tool === "rectangle"));
		this.penBtn?.toggleClass("pr-pen-on", tool === "pen");
		this.rectangleBtn?.toggleClass("pr-pen-on", tool === "rectangle");
		if (tool) {
			this.textTool = null;
			this.selectionActions?.refreshIndicator();
			this.popup.hide();
			this.clearSelection();
			this.selectedInkId = null;
			this.editingNoteId = null;
			this.redrawAllInk();
		}
		this.selectionActions?.refreshIndicator();
	}

	private penWidthPx(): number { return this.penWidth; }

	private getDrawingController(): DrawingController {
		if (!this.drawingController) {
			const view = this;
			this.drawingController = new DrawingController({
				get tool() { return view.drawingTool; },
				get liveStroke() { return view.liveStroke; }, set liveStroke(value) { view.liveStroke = value; },
				get liveStrokePage() { return view.liveStrokePage; }, set liveStrokePage(value) { view.liveStrokePage = value; },
				get rectangleEdit() { return view.rectangleEdit; }, set rectangleEdit(value) { view.rectangleEdit = value; },
			}, {
				pages: () => this.pages, scale: () => this.scale, scrollElement: () => this.scrollEl,
				annotations: () => this.data.annotations, setAnnotations: annotations => { this.data.annotations = annotations; },
				color: () => ({ key: this.popupColor, css: (this.plugin.settings.highlightColors as Record<string, string>)[this.popupColor] ?? this.popupColor }),
				width: () => this.penWidthPx(), documentIdentity: () => this.closed || !this.file ? null : this.documentToken,
				persistAndRefresh: pages => this.persistAndRefresh(pages), recordHistory: op => this.history.push(op),
				setTool: tool => this.setDrawingTool(tool), redrawInk: page => this.redrawInk(page), redrawAllInk: () => this.redrawAllInk(),
				selectRectangle: (ann, x, y) => {
					this.selectedInkId = ann.id; this.editingNoteId = ann.id;
					this.redrawAllInk(); this.popup.showEdit(ann, x, y);
				},
			});
		}
		return this.drawingController;
	}

	private pageFromEvent(e: PointerEvent): RenderedPage | null { return this.getDrawingController().pageFromEvent(e); }
	private pointOnPage(e: PointerEvent, page: RenderedPage): { x: number; y: number } { return this.getDrawingController().pointOnPage(e, page); }
	private onPenPointerDown(e: PointerEvent): void { this.getDrawingController().pointerDown(e); }
	private onPenPointerMove(e: PointerEvent): void { this.getDrawingController().pointerMove(e); }
	private onPenPointerEnd(e: PointerEvent, commit: boolean): void { this.getDrawingController().pointerEnd(e, commit); }
	private cancelRectangleEdit(): void { if (this.rectangleEdit) this.getDrawingController().cancelRectangleEdit(); }
	private finishRectangleEdit(pointerId: number, commit: boolean): Promise<void> { return this.getDrawingController().finishRectangleEdit(pointerId, commit); }

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
		this.closePenMenu(); this.popup.hide();
		this.selectedInkId = this.activeAnnotationId = this.editingNoteId = ann.id;
		this.redrawAllHighlights();
		this.selectionActions?.refreshIndicator();
		this.redrawAllInk();
		this.hlMenu.hide();
		this.popup.showEdit(ann, x, y);
	}

	// ---- undo / redo ----

	private async applyHistoryOp(op: HistoryOp, dir: HistoryDirection): Promise<boolean> {
		if (!this.file) return false;
		const apply = (change: HistoryOp): void => {
			if (change.kind === "batch") {
				for (const child of dir === "undo" ? [...change.ops].reverse() : change.ops) apply(child);
				return;
			}
			const anns = this.data.annotations;
			if (change.kind === "add") {
				this.data.annotations = dir === "undo"
					? anns.filter(a => a.id !== change.ann.id)
					: [...anns, cloneAnnotation(change.ann)];
			} else if (change.kind === "remove") {
				if (dir === "undo") {
					const list = [...anns];
					change.anns.forEach((ann, i) => list.splice(Math.min(change.indexes[i], list.length), 0, cloneAnnotation(ann)));
					this.data.annotations = list;
				} else {
					const ids = new Set(change.anns.map(a => a.id));
					this.data.annotations = anns.filter(a => !ids.has(a.id));
				}
			} else {
				const target = dir === "undo" ? change.before : change.after;
				this.data.annotations = anns.map(a => a.id === target.id ? cloneAnnotation(target) : a);
			}
		};
		apply(op);
		const ok = await this.persistAndRefresh();
		if (!ok) {
			// persistence failed: applyHistoryOp's caller keeps stack pointers,
			// but data must be restored to match
			new Notice(t("撤销/重做保存失败，操作已回滚"));
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
		if (this.undoMenuBtn) this.undoMenuBtn.disabled = !this.history.canUndo;
		if (this.redoMenuBtn) this.redoMenuBtn.disabled = !this.history.canRedo;
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
			this.selectionActions?.refreshIndicator();
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
		this.rememberNavigation();
		await this.scrollToPage(ann.page);
		this.scrollToRect(ann.page, ann.rects[0]);
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
			new Notice(t("暂无可导出的标注"));
			return;
		}
		await appendManyToNotes(this.app, this.file.path, this.plugin.settings.notesSuffix,
			this.data.annotations.filter((ann, i, all) => !ann.groupId || all.findIndex(a => a.groupId === ann.groupId) === i).map(ann => this.notesEntryFor(ann)));
	}

	private notesEntryFor(ann: Annotation): NotesEntry {
		const group = this.annotationGroup(ann).sort((a, b) => a.page - b.page);
		const base = { page: group[0].page, annId: group[0].id };
		const quote = group.map(a => a.text).join("\n");
		switch (ann.type) {
			case "note":
				return { ...base, title: t("批注"), quote, content: ann.note ?? "" };
			case "translation":
				return { ...base, title: t("翻译"), quote, content: ann.aiContent ?? "" };
			case "ink": {
				const svg = inkPreviewSvg(ann, 120)?.outerHTML ?? "";
				const bytes = new TextEncoder().encode(svg);
				let binary = "";
				for (const byte of bytes) binary += String.fromCharCode(byte);
				const img = `![画笔 p.${ann.page}](data:image/svg+xml;base64,${btoa(binary)})`;
				return { ...base, title: t("画笔"), quote: "", content: img };
			}
			default:
				return { ...base, title: t("高亮"), quote, content: ann.note ?? "" };
		}
	}

	// ---- selection state ----

	/** Only selections anchored inside this reader can drive its preview or actions. */
	private activeTextSelection(): Selection | null {
		const sel = this.contentEl.ownerDocument.getSelection();
		return sel && !sel.isCollapsed && sel.toString().trim() && sel.anchorNode && this.pagesEl.contains(sel.anchorNode)
			? sel : null;
	}

	/** Draw the active selection over the page without touching committed state. */
	private paintSelectionPreview(sel: Selection | null): void {
		for (const page of this.pages) {
			const rects = sel ? selectionRectsForPage(sel, page.wrapper, this.scale) : [];
			if (rects.length || page.wrapper.classList.contains("pr-selection-preview")) {
				renderSelectionPreview(page.selectionLayer, rects, this.scale);
			}
		}
	}

	/**
	 * Coalesce drag repaints to one per frame. selectionchange is queued by the
	 * browser, so no particular first-frame latency is guaranteed.
	 */
	private scheduleSelectionPreview(): void {
		if (this.selectionPreviewFrame !== 0) return;
		this.selectionPreviewFrame = window.requestAnimationFrame(() => {
			this.selectionPreviewFrame = 0;
			if (this.closed) return;
			this.paintSelectionPreview(this.activeTextSelection());
		});
	}

	/**
	 * Recompute the current selection payload and sync the header action
	 * group's enabled state. Called on mouseup and (debounced) selectionchange.
	 */
	private refreshSelectionState(): void {
		const sel = this.activeTextSelection();
		const payload = sel ? selectionToPayload(sel, this.scale, (p) => this.renderer.getPageText(p)) : null;
		this.currentPayload = payload;
		this.paintSelectionPreview(sel);
		if (this.editingRangeId) this.drawRangeHandles();
		this.selectionActions?.setEnabled(!!payload);
	}

	private onMouseUp(): void {
		// let the browser finalise the selection first
		window.setTimeout(() => {
			this.refreshSelectionState();
			if (this.textTool && this.currentPayload && !this.editingRangeId) {
				this.popupStyle = this.textTool;
				void this.commitHighlight(this.popupColor);
				return;
			}
			if (!this.editingRangeId && this.plugin.settings.showFloatingToolbar && this.currentPayload) {
				this.hlMenu.hide();
				this.editingNoteId = null;
				this.popup.show(this.currentPayload);
			}
		}, 0);
	}

	private async openNotePopup(): Promise<void> {
		const payload = this.popup.payloadSnapshot ?? this.currentPayload;
		if (!payload) return;
		const ann = await this.commitHighlight(this.popupColor, payload);
		if (!ann) return;
		this.editingNoteId = ann.id;
		this.hlMenu.hide();
		this.popup.showEdit(ann, payload.anchorRect.left, payload.anchorRect.bottom);
		this.popup.focusNote();
	}

	private setTextTool(style: AnnotationStyle | null): void {
		this.setDrawingTool(null);
		this.textTool = style;
		if (style) this.popupStyle = style;
		this.popup.hide();
		this.selectionActions?.refreshIndicator();
	}

	private withPayload(fn: (payload: SelectionPayload) => void): void {
		if (!this.currentPayload) {
			new Notice(t("请先在 PDF 中选择文字"));
			return;
		}
		fn(this.currentPayload);
	}

	private async commitHighlight(
		color: string,
		payload: SelectionPayload | null = this.currentPayload
	): Promise<Annotation | undefined> {
		if (!payload || !this.file) {
			new Notice(t("请先在 PDF 中选择文字"));
			return;
		}
		if (this.savingHighlight) return;
		this.savingHighlight = true;
		try {
			this.popupColor = color;
			this.selectionActions?.refreshIndicator();
			const annotations = this.annotationsForPayload(payload, { type: "highlight", color, style: this.popupStyle });
			const backup = this.data.annotations;
			this.data.annotations = [...backup, ...annotations];
			if (!(await this.persistAndRefresh(annotations.map(a => a.page)))) {
				this.data.annotations = backup;
				return;
			}
			this.recordAdded(annotations);
			this.clearSelection();
			return annotations[0];
		} finally {
			this.savingHighlight = false;
		}
	}

	// ---- selection popup actions ----

	/** marker menu color picked: annotate selection, or just switch the default */
	private async applyHeaderColor(color: string): Promise<void> {
		const ink = this.data.annotations.find(a => a.id === this.selectedInkId && a.ink);
		if (ink) { await this.updateGroup(ink, { color }); return; }
		this.popupColor = color;
		this.selectionActions?.refreshIndicator();
		if (this.currentPayload) await this.commitHighlight(color);
	}

	/** All toolbar style buttons activate the tool for subsequent selections. */
	private applyHeaderStyle(style: AnnotationStyle): void {
		this.setTextTool(style);
	}

	/** color dot clicked in the popup: annotate selection, or recolor edit target */
	private async applyPopupAnnotation(color: string): Promise<void> {
		if (this.editingNoteId) {
			const ann = this.data.annotations.find((a) => a.id === this.editingNoteId);
			if (ann && this.file) {
				if (!(await this.updateGroup(ann, { color }))) return;
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
				await this.updateGroup(ann, { style });
			}
		}
	}

	private async setPopupInkWidth(width: number, commit = true, id = this.editingNoteId): Promise<void> {
		const ann = this.data.annotations.find(a => a.id === id);
		if (!ann?.ink || !this.file || this.closed || !Number.isFinite(width)) return;
		width = Math.max(MIN_INK_WIDTH, Math.min(MAX_INK_WIDTH, width));
		if (!this.inkWidthBefore) {
			if (ann.ink.width === width) return;
			this.inkWidthBefore = { annotation: cloneAnnotation(ann), token: this.documentToken };
		}
		const edit = this.inkWidthBefore;
		if (edit.annotation.id !== ann.id || edit.token !== this.documentToken) { this.inkWidthBefore = null; return; }
		ann.ink.width = width;
		this.redrawAllInk();
		if (!commit) return;
		this.inkWidthBefore = null;
		if (edit.annotation.ink?.width === width) return;
		const after = cloneAnnotation(ann);
		if (!(await this.persistAndRefresh([ann.page]))) {
			Object.assign(ann, edit.annotation); this.redrawAllInk(); return;
		}
		if (edit.token === this.documentToken && !this.closed) this.history.push({ kind: "update", before: edit.annotation, after });
	}

	/** note submitted in the popup: create a note annotation, or update the edit target */
	private async submitNote(text: string): Promise<boolean> {
		if (this.editingNoteId) {
			const ann = this.data.annotations.find((a) => a.id === this.editingNoteId);
			if (ann && this.file) {
				const group = this.annotationGroup(ann);
				const before = group.map(a => cloneAnnotation(a));
				for (const item of group) item.note = text;
				// Keep the user's draft after a failed save; only saved edits enter history.
				if (!(await this.persistAndRefresh())) return false;
				if (this.pendingNoteIds?.includes(ann.id)) {
					this.recordAdded(group);
					this.pendingNoteIds = [];
				} else this.recordUpdates(before, group);
				new Notice(t("批注已更新"));
			}
			this.editingNoteId = null;
			this.popup.hide();
			return true;
		}
		const payload = this.popup.payloadSnapshot ?? this.currentPayload;
		if (!payload || !this.file) {
			new Notice(t("选区已失效，请重新选择后再添加批注"));
			return false;
		}
		const annotations = this.annotationsForPayload(payload, {
			type: "note", color: this.popupColor, style: this.popupStyle, note: text,
		});
		this.data.annotations.push(...annotations);
		this.pendingNoteIds = annotations.map(a => a.id);
		this.editingNoteId = annotations[0].id;
		if (!(await this.persistAndRefresh(annotations.map(a => a.page)))) return false;
		this.recordAdded(annotations);
		this.pendingNoteIds = [];
		new Notice(t("批注已添加"));
		this.clearSelection();
		return true;
	}

	/** streaming translation for the popup; throws LlmError on config/network issues */
	private async translateForPopup(
		payload: SelectionPayload,
		onChunk: (full: string) => void,
		signal?: AbortSignal
	): Promise<string> {
		const s = this.plugin.settings;
		if (!s.llmBaseUrl.trim() || !llmConfig(this.plugin.app, s).apiKey.trim() || !s.llmModel.trim()) {
			throw new LlmError(
				"config",
				t("请先在 设置 → Paper Reader 中配置 LLM（Base URL / API Key / 模型名）")
			);
		}
		const file = this.file;
		const data = this.data;
		const document = this.documentToken;
		const messages = buildTranslateMessages(payload.text, s.translateTargetLang);
		let out = "";
		for await (const chunk of this.llm.streamChat(messages, signal)) {
			out += chunk;
			onChunk(out);
		}
		if (this.closed || document !== this.documentToken || this.file !== file || this.data !== data) return out;
		// record as a translation annotation, mirroring the answer panel flow;
		// use the popup's payload directly (selection may be gone by now)
		if (this.file) {
			const annotations = this.annotationsForPayload(payload, { type: "translation", color: "", aiContent: out });
			this.data.annotations.push(...annotations);
			if (await this.persistAndRefresh()) this.recordAdded(annotations);
		}
		// selection may have changed while the request was in flight — the
		// result stays bound to the captured snapshot, never the new selection
		if (this.currentPayload && !sameSelection(this.currentPayload, payload)) {
			new Notice(t("选区已变化，结果仍关联原选中文本"));
		}
		return out;
	}

	private async insertPopupTranslation(translation: string): Promise<void> {
		const payload = this.popup.payloadSnapshot ?? this.currentPayload;
		if (!this.file || !payload) {
			new Notice(t("选区已失效，请重新选择后再插入"));
			return;
		}
		await appendToNotes(this.app, this.file.path, this.plugin.settings.notesSuffix, {
			title: t("翻译"),
			page: payload.page,
			quote: payload.text,
			content: translation,
		});
	}

	/** Remove all highlights on the selection page that overlap the selection. */
	private async clearHighlightsInSelection(): Promise<void> {
		const payload = this.currentPayload;
		if (!payload || !this.file) {
			new Notice(t("请先在 PDF 中选择文字"));
			return;
		}
		const removedAnns: Annotation[] = [];
		const removedIdx: number[] = [];
		this.data.annotations.forEach((a, i) => {
			if (a.type !== "highlight") return;
			if ((payload.segments ?? [payload]).some(segment => segment.page === a.page && a.rects.some(r1 => segment.rects.some(r2 => rectsOverlap(r1, r2))))) {
				removedAnns.push(a);
				removedIdx.push(i);
			}
		});
		if (removedAnns.length === 0) {
			new Notice(t("选区内没有高亮"));
			return;
		}
		const groups = new Set(removedAnns.map(a => a.groupId).filter(Boolean));
		this.data.annotations.forEach((a, i) => {
			if (a.groupId && groups.has(a.groupId) && !removedAnns.includes(a)) { removedAnns.push(a); removedIdx.push(i); }
		});
		const removedIds = new Set(removedAnns.map((a) => a.id));
		const backup = this.data.annotations;
		this.data.annotations = backup.filter((a) => !removedIds.has(a.id));
		if (!(await this.persistAndRefresh())) {
			this.data.annotations = backup;
			return;
		}
		const ordered = removedAnns.map((ann, i) => ({ ann, index: removedIdx[i] })).sort((a, b) => a.index - b.index);
		this.history.push({ kind: "remove", anns: ordered.map(x => cloneAnnotation(x.ann)), indexes: ordered.map(x => x.index) });
		new Notice(t("已删除 {count} 条高亮", { count: removedAnns.length }));
		this.clearSelection();
	}

	private clearSelection(): void {
		this.cancelRangeEdit();
		this.currentPayload = null;
		for (const page of this.pages) {
			if (page.wrapper.classList.contains("pr-selection-preview")) {
				renderSelectionPreview(page.selectionLayer, [], this.scale);
			}
		}
		this.editingNoteId = null;
		this.selectionActions?.setEnabled(false);
		this.popup.hide();
		this.contentEl.ownerDocument.getSelection()?.removeAllRanges();
	}

	private async copySelection(): Promise<void> {
		const payload = this.popup.payloadSnapshot ?? this.currentPayload;
		if (!payload) {
			new Notice(t("请先在 PDF 中选择文字"));
			return;
		}
		try {
			await navigator.clipboard.writeText(payload.text);
			new Notice(t("已复制"));
		} catch (e) {
			console.error("[paper-reader] clipboard failed", e);
			new Notice(t("复制失败"));
		}
	}

	// ---- AI / LLM ----

	/** Assemble the context text for AI requests per the configured level. */
	private async openAiPanel(mode: PanelMode, payload: SelectionPayload): Promise<void> {
		const request = ++this.aiPanelToken, document = this.documentToken;
		this.panel.prepareContext(mode, payload);
		try {
			const context = await this.contextTextFor(payload);
			if (this.closed || request !== this.aiPanelToken || document !== this.documentToken || !this.panel.isOpen) return;
			if (mode === "translate") this.panel.openTranslate(payload, context);
			else if (mode === "explain") this.panel.openExplain(payload, context);
			else this.panel.openAsk(payload, context);
		} catch {
			if (!this.closed && document === this.documentToken && request === this.aiPanelToken && this.panel.isOpen) {
				this.panel.showContextError();
				new Notice(t("无法读取 AI 上下文，请重试"));
			}
		}
	}

	private async contextTextFor(payload: SelectionPayload): Promise<string> {
		const token = this.documentToken;
		const level = this.plugin.settings.aiContextLevel;
		if (level === "selection") return payload.text;
		const pageText = await this.renderer.getPageTextEnsured(payload.page) || payload.text;
		if (level === "page") return `[page ${payload.page}]\n${pageText}`;
		return buildPageContext(payload.page, this.renderer.numPages,
			p => this.renderer.getPageTextEnsured(p),
			() => token === this.documentToken && !this.closed);
	}

	/** Record completed translations as annotations (type: translation). */
	private async recordAiAnnotation(
		mode: PanelMode,
		payload: SelectionPayload,
		answer: string
	): Promise<void> {
		if (mode !== "translate" || !this.file || this.closed) return;
		const annotations = this.annotationsForPayload(payload, { type: "translation", color: "", aiContent: answer });
		this.data.annotations.push(...annotations);
		if (await this.persistAndRefresh()) this.recordAdded(annotations);
	}


	private cancelRangeEdit(): void {
		if (this.rangeDrag && this.scrollEl?.hasPointerCapture(this.rangeDrag.pointerId)) this.scrollEl.releasePointerCapture(this.rangeDrag.pointerId);
		this.rangeDrag = null;
		this.editingRangeId = null;
		this.pagesEl?.querySelectorAll(".pr-range-handle").forEach(el => el.remove());
	}

	private async beginRangeEdit(): Promise<void> {
		const ann = this.data.annotations.find(a => a.id === this.activeAnnotationId);
		if (!ann || ann.type !== "highlight") return;
		this.clearSelection();
		this.editingRangeId = ann.groupId ?? ann.id;
		const group = this.annotationGroup(ann).sort((a, b) => a.page - b.page);
		await this.refreshPageWindow();
		const first = group[0], last = group[group.length - 1];
		const firstLayer = this.pages.find(p => p.pageNumber === first.page)?.wrapper.querySelector(".textLayer");
		const lastLayer = this.pages.find(p => p.pageNumber === last.page)?.wrapper.querySelector(".textLayer");
		const start = firstLayer && this.annotationCaret(firstLayer, first, false);
		const end = lastLayer && this.annotationCaret(lastLayer, last, true);
		if (!start || !end) { this.cancelRangeEdit(); new Notice(t("无法定位标注文字，请重新选择后标注")); return; }
		this.contentEl.ownerDocument.getSelection()?.setBaseAndExtent(start.startContainer, start.startOffset, end.startContainer, end.startOffset);
		this.hlMenu.hide(); this.popup.hide();
		this.refreshSelectionState();
	}

	private annotationCaret(layer: Element, ann: Annotation, end: boolean): Range | null {
		const text = this.renderer.getPageText(ann.page) ?? "";
		if (ann.textOffset >= 0 && text.slice(ann.textOffset, ann.textOffset + ann.text.length) === ann.text) {
			const caret = rangeFromPageTextOffset(layer, ann.textOffset + (end ? ann.text.length : 0), end);
			const caretBox = caret?.getClientRects()[0], target = end ? ann.rects[ann.rects.length - 1] : ann.rects[0];
			const bounds = layer.parentElement!.getBoundingClientRect();
			if (caret && caretBox && target && Math.abs(caretBox.left - bounds.left - (target.x + (end ? target.width : 0)) * this.scale) < 3 * this.scale) return caret;
		}
		const rect = end ? ann.rects[ann.rects.length - 1] : ann.rects[0];
		if (!rect) return null;
		const bounds = layer.parentElement!.getBoundingClientRect();
		return this.caretAt(bounds.left + (rect.x + (end ? rect.width : 0)) * this.scale, bounds.top + (rect.y + rect.height / 2) * this.scale);
	}

	private caretAt(x: number, y: number): Range | null {
		const doc = this.contentEl.ownerDocument as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
		const caret = doc.caretRangeFromPoint?.(x, y);
		return caret && this.pagesEl.contains(caret.startContainer) ? caret : null;
	}

	private drawRangeHandles(): void {
		this.pagesEl.querySelectorAll(".pr-range-handle").forEach(el => el.remove());
		const sel = this.activeTextSelection();
		if (!sel) return;
		const range = sel.getRangeAt(0);
		for (const end of [false, true]) {
			const caret = range.cloneRange(); caret.collapse(!end);
			const rect = caret.getClientRects()[0];
			const page = (caret.startContainer.parentElement)?.closest<HTMLElement>(".pr-page");
			if (!rect || !page) continue;
			const bounds = page.getBoundingClientRect();
			const handle = page.createEl("button", { cls: "pr-range-handle", attr: { "aria-label": end ? t("调整高亮结束位置") : t("调整高亮开始位置") } });
			handle.style.left = `${rect.left - bounds.left}px`;
			handle.style.top = `${rect.bottom - bounds.top}px`;
			handle.addEventListener("pointerdown", event => {
				event.preventDefault(); event.stopPropagation();
				this.rangeDrag = { node: end ? range.startContainer : range.endContainer,
					offset: end ? range.startOffset : range.endOffset, pointerId: event.pointerId };
				this.scrollEl.setPointerCapture(event.pointerId);
			});
		}
	}

	private moveRangeEndpoint(event: PointerEvent): void {
		const drag = this.rangeDrag, caret = this.caretAt(event.clientX, event.clientY);
		if (!drag || !caret || event.pointerId !== drag.pointerId) return;
		this.contentEl.ownerDocument.getSelection()?.setBaseAndExtent(drag.node, drag.offset, caret.startContainer, caret.startOffset);
		this.refreshSelectionState();
	}

	private async saveRangeEdit(): Promise<void> {
		const ann = this.data.annotations.find(a => a.id === this.editingRangeId || a.groupId === this.editingRangeId);
		const sel = this.activeTextSelection();
		const payload = sel && selectionToPayload(sel, this.scale, page => this.renderer.getPageText(page));
		if (!ann || !payload || !this.file) return;
		const before = this.annotationGroup(ann), backup = this.data.annotations;
		const updated = this.annotationsForPayload(payload, { type: ann.type, color: ann.color, style: ann.style, note: ann.note });
		for (const item of updated) {
			const previous = before.find(a => a.page === item.page);
			if (previous) { item.id = previous.id; item.createdAt = previous.createdAt; }
		}
		if (updated.length > 1) for (const item of updated) item.groupId = before[0].groupId ?? before[0].id;
		const ids = new Set(before.map(a => a.id));
		this.data.annotations = [...backup.filter(a => !ids.has(a.id)), ...updated];
		if (!(await this.persistAndRefresh())) { this.data.annotations = backup; return; }
		const ops: HistoryOp[] = [{ kind: "remove", anns: before.map(a => cloneAnnotation(a)), indexes: before.map(a => backup.indexOf(a)) },
			...updated.map((item): HistoryOp => ({ kind: "add", ann: cloneAnnotation(item) }))];
		this.history.push({ kind: "batch", ops });
		this.clearSelection();
	}

	// ---- existing highlight interactions ----


	private openHighlightMenu(ann: Annotation, x: number, y: number): void {
		this.closePenMenu(); this.popup.hide();
		this.selectedInkId = null;
		this.clearSelection();
		this.activeAnnotationId = ann.id;
		this.editingNoteId = ann.id;
		this.redrawAllInk(); this.redrawAllHighlights();
		this.hlMenu.hide();
		const page = this.pages.find(p => p.pageNumber === ann.page);
		const bounds = page?.wrapper.getBoundingClientRect();
		const rect = ann.rects.find(r => bounds && x >= bounds.left + r.x * this.scale && x <= bounds.left + (r.x + r.width) * this.scale && y >= bounds.top + r.y * this.scale && y <= bounds.top + (r.y + r.height) * this.scale) ?? ann.rects[0];
		const anchor = bounds && rect ? new DOMRect(bounds.left + rect.x * this.scale, bounds.top + rect.y * this.scale, rect.width * this.scale, rect.height * this.scale) : undefined;
		this.popup.showEdit(ann, x, y, anchor);
	}

	private async recolorHighlight(color: string): Promise<void> {
		const ann = this.data.annotations.find((a) => a.id === (this.selectedInkId ?? this.activeAnnotationId));
		if (!ann || !this.file) return;
		if (!(await this.updateGroup(ann, { color }))) return;
		this.hlMenu.hide();
	}

	private async deleteHighlight(id = this.activeAnnotationId): Promise<void> {
		if (!this.file) return;
		const idx = this.data.annotations.findIndex((a) => a.id === id);
		if (idx < 0) return;
		const backup = this.data.annotations;
		const removed = backup[idx];
		const group = this.annotationGroup(removed);
		const ids = new Set(group.map(a => a.id));
		this.data.annotations = backup.filter(a => !ids.has(a.id));
		if (!(await this.persistAndRefresh())) {
			this.data.annotations = backup;
			return;
		}
		this.history.push({ kind: "remove", anns: group.map(a => cloneAnnotation(a)), indexes: group.map(a => backup.indexOf(a)) });
		if (this.editingNoteId === id) {
			this.editingNoteId = null;
			this.popup.hide();
		}
		this.selectedInkId = null;
		this.hlMenu.hide();
	}
}
