import { setIcon } from "obsidian";
import type { Annotation, HighlightRect } from "../storage/annotationStore";

export type HighlightClickHandler = (
	annotation: Annotation,
	clientX: number,
	clientY: number
) => void;

function hexToRgba(hex: string, alpha: number): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return hex;
	const n = parseInt(m[1], 16);
	const r = (n >> 16) & 0xff;
	const g = (n >> 8) & 0xff;
	const b = n & 0xff;
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** repeating SVG wave used as background-image for wavy annotations */
function wavyBackground(color: string, scale: number): string {
	const w = 8;
	const h = Math.max(3, Math.round(3 * scale));
	const stroke = Math.max(1, 1.5 * scale);
	const svg =
		`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>` +
		`<path d='M0 ${h - 1} Q ${w / 4} 0 ${w / 2} ${h - 1} T ${w} ${h - 1}' ` +
		`fill='none' stroke='${color}' stroke-width='${stroke}'/></svg>`;
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function styleRect(
	el: HTMLElement,
	ann: Annotation,
	colorHex: string,
	scale: number
): void {
	const style = ann.style ?? "highlight";
	if (ann.type === "note") {
		// notes: light fill, distinct from highlights
		el.style.backgroundColor = hexToRgba(colorHex, 0.18);
		el.addClass("pr-note-rect");
		return;
	}
	if (style === "underline") {
		el.style.borderBottom = `${Math.max(1.5, 2 * scale)}px solid ${colorHex}`;
		el.addClass("pr-line-rect");
	} else if (style === "wavy") {
		el.style.backgroundImage = wavyBackground(colorHex, scale);
		el.style.backgroundRepeat = "repeat-x";
		el.style.backgroundPosition = "bottom left";
		el.addClass("pr-line-rect");
	} else if (style === "strikethrough") {
		// solid line at the vertical middle of each line rect
		const thickness = Math.max(1.5, 2 * scale);
		el.style.backgroundImage = `linear-gradient(${colorHex}, ${colorHex})`;
		el.style.backgroundRepeat = "no-repeat";
		el.style.backgroundSize = `100% ${thickness}px`;
		el.style.backgroundPosition = "0 50%";
		el.addClass("pr-line-rect");
	} else {
		el.style.backgroundColor = hexToRgba(colorHex, 1);
		el.style.mixBlendMode = "multiply";
	}
}

/** Render overlay rects for all annotations of one page (one rect per line). */
export function renderHighlightRects(
	layerEl: HTMLElement,
	annotations: Annotation[],
	scale: number,
	colors: Record<string, string>,
	onClick: HighlightClickHandler
): void {
	layerEl.empty();
	for (const ann of annotations) {
		const color = colors[ann.color] ?? ann.color;
		for (const rect of ann.rects) {
			const el = layerEl.createDiv({ cls: "pr-highlight-rect" });
			el.dataset.annotationId = ann.id;
			el.style.left = `${rect.x * scale}px`;
			el.style.top = `${rect.y * scale}px`;
			el.style.width = `${rect.width * scale}px`;
			el.style.height = `${rect.height * scale}px`;
			styleRect(el, ann, color, scale);
			el.addEventListener("click", (e) => {
				e.stopPropagation();
				onClick(ann, e.clientX, e.clientY);
			});
		}
		// note marker icon at the end of the last rect
		if (ann.type === "note" && ann.rects.length > 0) {
			const last = ann.rects[ann.rects.length - 1];
			const icon = layerEl.createSpan({ cls: "pr-note-icon" });
			setIcon(icon, "message-square");
			icon.style.left = `${(last.x + last.width) * scale + 2}px`;
			icon.style.top = `${last.y * scale - 2}px`;
			icon.addEventListener("click", (e) => {
				e.stopPropagation();
				onClick(ann, e.clientX, e.clientY);
			});
		}
	}
}

export type { HighlightRect };
