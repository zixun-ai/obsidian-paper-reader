import { Notice, setIcon } from "obsidian";
import type { Annotation, AnnotationStyle } from "../storage/annotationStore";
import type { SelectionPayload } from "../pdfview/selection";
import { popupCacheKey, PopupCachedState } from "../pdfview/popupCache";
import { COLOR_KEYS } from "../settings";

export interface SelectionPopupDeps {
	getColors: () => Record<string, string>;
	getStyle: () => AnnotationStyle;
	/** style button clicked: update session default (and edit target, if any) */
	setStyle: (style: AnnotationStyle) => void;
	setInkWidth?: (width: number) => void;
	/** color dot clicked: create annotation from selection, or recolor edit target */
	applyAnnotation: (colorKey: string) => void;
	copySelection: () => void;
	/** create note from selection, or update edit target's note text */
	submitNote: (text: string) => Promise<boolean>;
	deleteAnnotation?: (id: string) => Promise<void>;
	/** stream a translation; onChunk receives the full text so far */
	translate: (payload: SelectionPayload, onChunk: (full: string) => void) => Promise<string>;
	insertTranslation: (translation: string) => Promise<void>;
	/** view-level per-selection state cache (translation + note draft) */
	getCached: (key: string) => PopupCachedState | undefined;
	setCached: (key: string, state: PopupCachedState) => void;
}

const STYLE_ORDER: { key: AnnotationStyle; icon: string | null; label: string }[] = [
	{ key: "highlight", icon: "highlighter", label: "实心高亮" },
	{ key: "underline", icon: "underline", label: "直线" },
	{ key: "wavy", icon: null, label: "波浪线" },
	{ key: "strikethrough", icon: "strikethrough", label: "删除线" },
];

/**
 * macOS-Preview-style selection popup: color dots, annotation style picker,
 * copy + note input, and an inline streaming translation area.
 */
export class SelectionPopup {
	private el: HTMLElement | null = null;
	private payload: SelectionPayload | null = null;
	private editTarget: Annotation | null = null;
	private anchorRect: DOMRect | null = null;
	private styleBtns = new Map<AnnotationStyle, HTMLButtonElement>();
	private noteInput: HTMLInputElement | null = null;
	private translateBtn: HTMLButtonElement | null = null;
	private resultEl: HTMLElement | null = null;
	private resultActionsEl: HTMLElement | null = null;
	private lastTranslation = "";
	private translating = false;
	private generation = 0;
	private cacheKey: string | null = null;

	constructor(private deps: SelectionPopupDeps) {}

	get isVisible(): boolean {
		return this.el !== null;
	}

	contains(target: Node): boolean {
		return this.el?.contains(target) ?? false;
	}

	show(payload: SelectionPayload): void {
		// hide() clears payload/editTarget — call it BEFORE assigning state
		this.hide();
		this.payload = payload;
		this.editTarget = null;
		this.anchorRect = payload.anchorRect;
		this.cacheKey = popupCacheKey(payload);
		this.render();
	}

	showEdit(ann: Annotation, clientX: number, clientY: number): void {
		this.hide();
		this.payload = null;
		this.editTarget = ann;
		this.anchorRect = new DOMRect(clientX, clientY, 0, 0);
		this.cacheKey = null;
		this.render();
	}

	/** the selection captured when the popup opened (survives selection loss) */
	get payloadSnapshot(): SelectionPayload | null {
		return this.payload;
	}

	focusNote(): void {
		this.noteInput?.focus();
	}

	hide(): void {
		this.generation++;
		this.el?.remove();
		this.el = null;
		this.payload = null;
		this.editTarget = null;
		this.lastTranslation = "";
		this.translating = false;
	}

	private render(): void {
		const anchor = this.anchorRect;
		if (!anchor) return;

		const el = document.body.createDiv({ cls: "pr-popup" });
		// keep the document selection alive while interacting with the popup
		el.addEventListener("mousedown", (e) => {
			const t = e.target as HTMLElement;
			if (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA") e.preventDefault();
		});

		// row 1: color dots
		const colorsRow = el.createDiv({ cls: "pr-popup-colors" });
		const colors = this.deps.getColors();
		for (const key of COLOR_KEYS) {
			const dot = colorsRow.createDiv({ cls: "pr-color-dot" });
			dot.style.backgroundColor = colors[key] ?? key;
			if (this.editTarget && this.editTarget.color === key) {
				dot.addClass("pr-color-dot-active");
			}
			dot.setAttr("aria-label", `标注 ${key}`);
			dot.addEventListener("click", (e) => {
				e.stopPropagation();
				this.deps.applyAnnotation(key);
			});
		}

		// row 2: text style picker, or rectangle stroke width
		this.styleBtns.clear();
		if (this.editTarget?.ink?.shape === "rectangle") {
			const widthsRow = el.createDiv({ cls: "pr-popup-widths" });
			for (const width of [2, 4, 7]) {
				const btn = widthsRow.createEl("button", { cls: "pr-popup-width-btn" });
				btn.setAttr("aria-label", `线宽 ${width}`);
				btn.createSpan({ cls: "pr-popup-width-line" }).style.height = `${width}px`;
				if (this.editTarget.ink.width === width) btn.addClass("pr-popup-style-active");
				btn.addEventListener("click", (e) => {
					e.stopPropagation();
					this.deps.setInkWidth?.(width);
					for (const sibling of Array.from(widthsRow.children)) sibling.removeClass("pr-popup-style-active");
					btn.addClass("pr-popup-style-active");
				});
			}
		} else {
			const stylesRow = el.createDiv({ cls: "pr-popup-styles" });
			const currentStyle = this.editTarget?.style ?? this.deps.getStyle();
			for (const { key, icon, label } of STYLE_ORDER) {
				const btn = stylesRow.createEl("button", { cls: "pr-popup-style-btn" });
				btn.setAttr("aria-label", label);
				if (icon) setIcon(btn, icon);
				else {
					const svg = btn.createSvg("svg", { attr: {
						viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
						"stroke-width": "2", "stroke-linecap": "round",
					} });
					svg.createSvg("path", { attr: { d: "M2 14 Q 5 8 8 14 T 14 14 T 20 14 T 26 14" } });
				}
				if (key === currentStyle) btn.addClass("pr-popup-style-active");
				btn.addEventListener("click", (e) => {
					e.stopPropagation();
					this.deps.setStyle(key);
					for (const [k, b] of this.styleBtns) b.toggleClass("pr-popup-style-active", k === key);
				});
				this.styleBtns.set(key, btn);
			}
		}

		// row 3: copy + note input
		const actionsRow = el.createDiv({ cls: "pr-popup-actions" });
		if (!this.editTarget) {
			const copyBtn = actionsRow.createEl("button", { cls: "pr-popup-btn" });
			setIcon(copyBtn, "copy");
			copyBtn.setAttr("aria-label", "复制");
			copyBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.deps.copySelection();
			});
		}
		this.noteInput = actionsRow.createEl("input", {
			cls: "pr-popup-note-input",
			attr: { type: "text", placeholder: "添加批注…" },
		});
		// restore the note draft cached for this selection
		const cached = this.cacheKey ? this.deps.getCached(this.cacheKey) : undefined;
		if (this.editTarget?.note) {
			this.noteInput.value = this.editTarget.note;
		} else if (cached?.noteDraft) {
			this.noteInput.value = cached.noteDraft;
		}
		const submit = async () => {
			const text = this.noteInput?.value.trim() ?? "";
			if (!text) return;
			const cacheKey = this.cacheKey;
			if (!(await this.deps.submitNote(text))) return;
			// draft consumed
			if (cacheKey) this.deps.setCached(cacheKey, { noteDraft: "" });
		};
		this.noteInput.addEventListener("input", () => {
			if (this.cacheKey && this.noteInput) {
				this.deps.setCached(this.cacheKey, { noteDraft: this.noteInput.value });
			}
		});
		this.noteInput.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				submit();
			}
			e.stopPropagation();
		});
		const addBtn = actionsRow.createEl("button", { cls: "pr-popup-btn" });
		setIcon(addBtn, this.editTarget ? "check" : "plus");
		addBtn.setAttr("aria-label", this.editTarget ? "保存批注" : "添加批注");
		addBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			submit();
		});

		if (this.editTarget && this.deps.deleteAnnotation) {
			const id = this.editTarget.id;
			const del = actionsRow.createEl("button", { cls: "pr-popup-btn" });
			setIcon(del, "trash-2");
			del.setAttr("aria-label", "删除批注");
			del.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.deps.deleteAnnotation!(id);
			});
		}

		// row 4: translation (only for fresh selections)
		if (!this.editTarget) {
			const trRow = el.createDiv({ cls: "pr-popup-translate" });
			this.translateBtn = trRow.createEl("button", { cls: "pr-popup-translate-btn" });
			setIcon(this.translateBtn, "languages");
			this.translateBtn.createSpan({ text: "翻译" });
			this.translateBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.runTranslate();
			});
			this.resultEl = trRow.createDiv({ cls: "pr-popup-result pr-hidden" });
			this.resultActionsEl = trRow.createDiv({ cls: "pr-popup-result-actions pr-hidden" });
			const mkSmall = (label: string, onClick: () => void) => {
				const btn = this.resultActionsEl!.createEl("button", { cls: "pr-popup-small-btn" });
				btn.setText(label);
				btn.addEventListener("click", (e) => {
					e.stopPropagation();
					onClick();
				});
			};
			mkSmall("复制译文", () => void this.copyTranslation());
			mkSmall("插入标注笔记", () => void this.insertTranslation());
			// restore a cached translation for this selection (popup reopened)
			if (cached?.translation) {
				this.lastTranslation = cached.translation;
				this.resultEl.setText(cached.translation);
				this.resultEl.removeClass("pr-hidden");
				this.resultActionsEl.removeClass("pr-hidden");
			}
		}

		document.body.appendChild(el);
		this.el = el;
		this.position();
	}

	private position(): void {
		const el = this.el;
		const anchor = this.anchorRect;
		if (!el || !anchor) return;
		const rect = el.getBoundingClientRect();
		// below the selection by default, flip above when out of space
		let top = anchor.bottom + 8;
		if (top + rect.height > window.innerHeight - 8) {
			top = anchor.top - rect.height - 8;
		}
		top = Math.max(4, top);
		const left = Math.max(4, Math.min(anchor.left, window.innerWidth - rect.width - 4));
		el.style.top = `${top}px`;
		el.style.left = `${left}px`;
	}

	// ---- translation ----

	private async runTranslate(): Promise<void> {
		if (!this.payload || this.translating || !this.resultEl) return;
		this.translating = true;
		const generation = this.generation;
		const cacheKey = this.cacheKey;
		this.lastTranslation = "";
		this.resultEl.removeClass("pr-hidden");
		this.resultEl.setText("翻译中…");
		this.resultActionsEl?.addClass("pr-hidden");
		this.position();
		try {
			const out = await this.deps.translate(this.payload, (full) => {
				if (generation === this.generation && this.resultEl) {
					this.resultEl.setText(full);
					this.resultEl.scrollTop = this.resultEl.scrollHeight;
				}
			});
			if (generation !== this.generation) return;
			this.lastTranslation = out;
			if (cacheKey) {
				this.deps.setCached(cacheKey, { translation: out });
			}
		} catch (e) {
			if (generation !== this.generation) return;
			const msg = e instanceof Error ? e.message : String(e);
			if (this.resultEl) this.resultEl.setText(msg);
			new Notice(msg);
		}
		this.translating = false;
		if (this.lastTranslation && this.resultActionsEl) {
			this.resultActionsEl.removeClass("pr-hidden");
		}
		this.position();
	}

	private async copyTranslation(): Promise<void> {
		if (!this.lastTranslation) return;
		await navigator.clipboard.writeText(this.lastTranslation);
		new Notice("已复制译文");
	}

	private async insertTranslation(): Promise<void> {
		if (!this.lastTranslation) return;
		await this.deps.insertTranslation(this.lastTranslation);
	}
}
