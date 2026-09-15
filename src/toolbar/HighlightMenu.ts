import { setIcon } from "obsidian";
import { COLOR_KEYS } from "../settings";

export interface HighlightMenuCallbacks {
	onRecolor: (colorKey: string) => void;
	onDelete: () => void;
}

const COLOR_ORDER = COLOR_KEYS;

/**
 * Small popup shown when clicking an existing highlight:
 * color dots to recolor + a delete button.
 */
export class HighlightMenu {
	private el: HTMLElement | null = null;

	constructor(
		private callbacks: HighlightMenuCallbacks,
		private getColors: () => Record<string, string>
	) {}

	get isVisible(): boolean {
		return this.el !== null;
	}

	contains(target: Node): boolean {
		return this.el?.contains(target) ?? false;
	}

	show(clientX: number, clientY: number, currentColor: string): void {
		this.hide();
		const el = document.body.createDiv({ cls: "pr-hl-menu" });

		for (const key of COLOR_ORDER) {
			const dot = el.createDiv({ cls: "pr-color-dot" });
			dot.style.backgroundColor = this.getColors()[key] ?? key;
			if (key === currentColor) dot.addClass("pr-color-dot-active");
			dot.setAttr("aria-label", `Recolor ${key}`);
			dot.addEventListener("click", (e) => {
				e.stopPropagation();
				this.callbacks.onRecolor(key);
			});
		}

		const del = el.createEl("button", { cls: "pr-toolbar-btn" });
		setIcon(del, "trash-2");
		del.setAttr("aria-label", "删除高亮");
		del.addEventListener("click", (e) => {
			e.stopPropagation();
			this.callbacks.onDelete();
		});

		document.body.appendChild(el);
		this.el = el;

		const rect = el.getBoundingClientRect();
		const left = Math.max(4, Math.min(clientX, window.innerWidth - rect.width - 4));
		const top = Math.max(4, Math.min(clientY + 8, window.innerHeight - rect.height - 4));
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
	}

	hide(): void {
		this.el?.remove();
		this.el = null;
	}
}
