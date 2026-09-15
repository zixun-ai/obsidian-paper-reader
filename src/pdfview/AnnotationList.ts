import { setIcon } from "obsidian";
import type { Annotation } from "../storage/annotationStore";
import { inkBoundingRect } from "./InkLayer";

export interface AnnotationListCallbacks {
	onSelect: (ann: Annotation) => void;
	onExport: (ann: Annotation) => void;
	onExportAll: () => void;
}

const TYPE_ICONS: Record<string, string> = {
	highlight: "highlighter",
	note: "message-square",
	translation: "languages",
	qa: "help-circle",
	ink: "pencil",
};

function excerpt(text: string, max = 60): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > max ? t.slice(0, max) + "…" : t;
}

/** small SVG preview of an ink stroke for list/notes */
export function inkPreviewSvg(ann: Annotation, size = 48): string {
	if (!ann.ink || ann.ink.points.length < 2) return "";
	const b = inkBoundingRect(ann.ink.points);
	const pad = ann.ink.width + 2;
	const w = Math.max(b.width + pad * 2, 1);
	const h = Math.max(b.height + pad * 2, 1);
	let d = `M ${ann.ink.points[0] - b.x + pad} ${ann.ink.points[1] - b.y + pad}`;
	for (let i = 2; i + 1 < ann.ink.points.length; i += 2) {
		d += ` L ${ann.ink.points[i] - b.x + pad} ${ann.ink.points[i + 1] - b.y + pad}`;
	}
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
		`viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">` +
		`<path d="${d}" fill="none" stroke="#888" stroke-width="${ann.ink.width}" ` +
		`stroke-linecap="round" stroke-linejoin="round"/></svg>`
	);
}

/**
 * Sidebar "annotations" mode: page-ordered list of all annotations with
 * jump + export actions. Rebuilt by the view after every data change.
 */
export class AnnotationList {
	readonly el: HTMLElement;

	constructor(
		private callbacks: AnnotationListCallbacks,
		private getColors: () => Record<string, string>
	) {
		this.el = createDiv({ cls: "pr-ann-list" });
	}

	build(annotations: Annotation[]): void {
		this.el.empty();
		const sorted = [...annotations].sort((a, b) => {
			if (a.page !== b.page) return a.page - b.page;
			const ra = a.rects[0];
			const rb = b.rects[0];
			return (ra?.y ?? 0) - (rb?.y ?? 0) || (ra?.x ?? 0) - (rb?.x ?? 0);
		});

		const header = this.el.createDiv({ cls: "pr-ann-header" });
		header.createSpan({ text: `标注（${sorted.length}）` });
		const exportAll = header.createEl("button", { cls: "clickable-icon" });
		setIcon(exportAll, "file-output");
		exportAll.setAttr("aria-label", "全部导出到标注笔记");
		exportAll.addEventListener("click", () => this.callbacks.onExportAll());

		if (sorted.length === 0) {
			this.el.createDiv({ cls: "pr-ann-empty", text: "暂无标注" });
			return;
		}

		const colors = this.getColors();
		for (const ann of sorted) {
			const item = this.el.createDiv({ cls: "pr-ann-item" });
			item.dataset.annotationId = ann.id;
			item.addEventListener("click", () => this.callbacks.onSelect(ann));

			const iconEl = item.createSpan({ cls: "pr-ann-icon" });
			setIcon(iconEl, TYPE_ICONS[ann.type] ?? "highlighter");
			if (ann.type !== "ink") {
				iconEl.style.color = colors[ann.color] ?? "var(--text-muted)";
			}

			const main = item.createDiv({ cls: "pr-ann-main" });
			const firstLine = main.createDiv({ cls: "pr-ann-text" });
			if (ann.type === "ink") {
				const preview = main.createDiv({ cls: "pr-ann-ink-preview" });
				preview.innerHTML = inkPreviewSvg(ann);
				firstLine.setText("画笔");
			} else {
				firstLine.setText(excerpt(ann.text) || "(无文本)");
			}
			const detail =
				ann.type === "note" && ann.note
					? ann.note
					: ann.type === "translation" && ann.aiContent
						? ann.aiContent
						: "";
			if (detail) {
				main.createDiv({ cls: "pr-ann-detail", text: excerpt(detail, 48) });
			}

			const pageEl = item.createSpan({ cls: "pr-ann-page" });
			pageEl.setText(`p.${ann.page}`);

			const exportBtn = item.createEl("button", { cls: "pr-ann-export clickable-icon" });
			setIcon(exportBtn, "file-output");
			exportBtn.setAttr("aria-label", "导出到标注笔记");
			exportBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.callbacks.onExport(ann);
			});
		}
	}
}
