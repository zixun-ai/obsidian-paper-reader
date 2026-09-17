import { Menu, setIcon } from "obsidian";
import { COLOR_KEYS } from "../settings";
import type { AnnotationStyle } from "../storage/annotationStore";

export interface SelectionActionsCallbacks {
	getColor: () => string;
	getStyle: () => AnnotationStyle;
	/** color picked in the marker menu: apply to selection, or set default */
	applyColor: (colorKey: string) => void;
	/** style picked in the marker menu: apply to selection, or set default */
	applyStyle: (style: AnnotationStyle) => void;
	onClearHighlight: () => void;
	onCopy: () => void;
	/** 批注 placeholder for M1 */
	onNote: () => void;
	onTranslate: () => void;
	onExplain: () => void;
	onAsk: () => void;
}

const COLOR_LABELS: Record<string, string> = {
	yellow: "黄色",
	red: "红色",
	green: "绿色",
	blue: "蓝色",
	purple: "紫色",
	pink: "粉色",
	orange: "橙色",
};

const STYLE_ITEMS: { key: AnnotationStyle; label: string; icon: string | null }[] = [
	{ key: "highlight", label: "实心高亮", icon: "highlighter" },
	{ key: "underline", label: "下划线", icon: "underline" },
	{ key: "wavy", label: "波浪线", icon: "waves" },
	{ key: "strikethrough", label: "删除线", icon: "strikethrough" },
];

/**
 * Selection action group embedded in the view header:
 * marker button (color/style dropdown) + clear-highlight | copy / note /
 * translate / explain / ask. All buttons except the marker are disabled
 * until the PDF has a non-empty text selection.
 */
export class SelectionActions {
	readonly el: HTMLElement;
	private buttons: HTMLButtonElement[] = [];
	private colorBar: HTMLElement;

	constructor(
		private callbacks: SelectionActionsCallbacks,
		private getColors: () => Record<string, string>
	) {
		this.el = createDiv({ cls: "pr-actions" });

		// group 1: marker dropdown + clear
		const hlGroup = this.el.createDiv({ cls: "pr-action-group" });
		// the marker button stays clickable without a selection (switch defaults)
		const marker = hlGroup.createEl("button", {
			cls: "pr-marker-btn clickable-icon",
		});
		marker.setAttr("aria-label", "标注（选择颜色与样式）");
		// don't steal focus / collapse the PDF selection when clicked
		marker.addEventListener("mousedown", (e) => e.preventDefault());
		const iconWrap = marker.createSpan({ cls: "pr-marker-icon" });
		setIcon(iconWrap, "highlighter");
		this.colorBar = marker.createSpan({ cls: "pr-marker-colorbar" });
		marker.addEventListener("click", (e) => this.openMarkerMenu(e));
		this.refreshIndicator();

		this.mkBtn(hlGroup, "eraser", "清除选区内的高亮", () =>
			this.callbacks.onClearHighlight()
		);

		this.el.createDiv({ cls: "pr-divider" });

		// group 2: operations
		const opGroup = this.el.createDiv({ cls: "pr-action-group" });
		this.mkBtn(opGroup, "copy", "复制", () => this.callbacks.onCopy());
		this.mkBtn(opGroup, "message-square-plus", "批注", () => this.callbacks.onNote());
		this.mkBtn(opGroup, "languages", "翻译", () => this.callbacks.onTranslate());
		this.mkBtn(opGroup, "sparkles", "AI 解释", () => this.callbacks.onExplain());
		this.mkBtn(opGroup, "message-circle-question", "AI 问答", () =>
			this.callbacks.onAsk()
		);

		this.setEnabled(false);
	}

	private mkBtn(
		parent: HTMLElement,
		icon: string,
		tooltip: string,
		onClick: () => void
	): HTMLButtonElement {
		const btn = parent.createEl("button", { cls: "pr-header-btn clickable-icon" });
		btn.setAttr("aria-label", tooltip);
		setIcon(btn, icon);
		// don't steal focus / collapse the PDF selection when clicked
		btn.addEventListener("mousedown", (e) => e.preventDefault());
		btn.addEventListener("click", onClick);
		this.buttons.push(btn);
		return btn;
	}

	/** Sync the marker button's color bar with the current color. */
	refreshIndicator(): void {
		const key = this.callbacks.getColor();
		this.colorBar.style.backgroundColor = this.getColors()[key] ?? key;
	}

	private openMarkerMenu(e: MouseEvent): void {
		const menu = new Menu();
		const colors = this.getColors();
		for (const key of COLOR_KEYS) {
			menu.addItem((item) => {
				// color dot inside the title; setChecked shows a ✓ on the left
				const frag = createFragment((fragment) => {
					const dot = fragment.createSpan({ cls: "pr-menu-dot" });
					dot.style.backgroundColor = colors[key] ?? key;
					fragment.createSpan({ text: COLOR_LABELS[key] ?? key });
				});
				item
					.setTitle(frag)
					.setChecked(this.callbacks.getColor() === key)
					.onClick(() => this.callbacks.applyColor(key));
			});
		}
		menu.addSeparator();
		for (const s of STYLE_ITEMS) {
			menu.addItem((item) =>
				item
					.setTitle(s.label)
					.setIcon(s.icon)
					.setChecked(this.callbacks.getStyle() === s.key)
					.onClick(() => this.callbacks.applyStyle(s.key))
			);
		}
		menu.showAtMouseEvent(e);
	}

	setEnabled(enabled: boolean): void {
		this.el.toggleClass("pr-actions-disabled", !enabled);
		for (const btn of this.buttons) {
			btn.disabled = !enabled;
		}
	}
}
