import type { Annotation } from "../storage/annotationStore";

const SVG_NS = "http://www.w3.org/2000/svg";

function strokePath(points: number[], scale: number): string {
	if (points.length < 2) return "";
	let d = `M ${points[0] * scale} ${points[1] * scale}`;
	if (points.length === 2) {
		// single tap: draw a tiny segment so the dot is visible
		d += ` l 0.01 0`;
	}
	for (let i = 2; i + 1 < points.length; i += 2) {
		d += ` L ${points[i] * scale} ${points[i + 1] * scale}`;
	}
	return d;
}

function makePath(ann: Annotation, scale: number, colorHex: string): SVGPathElement {
	const path = document.createElementNS(SVG_NS, "path");
	path.setAttribute("d", strokePath(ann.ink!.points, scale));
	path.setAttribute("fill", "none");
	path.setAttribute("stroke", colorHex);
	path.setAttribute("stroke-width", String(ann.ink!.width * scale));
	path.setAttribute("stroke-linecap", "round");
	path.setAttribute("stroke-linejoin", "round");
	path.dataset.annotationId = ann.id;
	path.classList.add("pr-ink-path");
	return path;
}

/** Render persisted ink annotations of one page into its SVG layer. */
export function renderInkStrokes(
	svg: SVGSVGElement,
	annotations: Annotation[],
	scale: number,
	colors: Record<string, string>,
	onStrokeClick: (ann: Annotation, clientX: number, clientY: number) => void,
	selectedId: string | null
): void {
	svg.replaceChildren();
	for (const ann of annotations) {
		if (!ann.ink || ann.ink.points.length < 2) continue;
		const color = colors[ann.color] ?? ann.color;
		const path = makePath(ann, scale, color);
		if (ann.id === selectedId) path.classList.add("pr-ink-selected");
		path.addEventListener("click", (e) => {
			e.stopPropagation();
			onStrokeClick(ann, e.clientX, e.clientY);
		});
		svg.appendChild(path);
	}
}

export interface LiveStroke {
	addPoint(x: number, y: number): void;
	/** returns the finished stroke, or null when too few points */
	finish(): { width: number; points: number[] } | null;
	discard(): void;
}

/**
 * Live stroke being drawn with the pointer. Points are stored in unscaled
 * page coordinates so zoom/layout changes keep the position correct.
 */
export function beginInkStroke(
	svg: SVGSVGElement,
	colorHex: string,
	width: number,
	scale: number,
	startX: number,
	startY: number
): LiveStroke {
	const points: number[] = [startX, startY];
	const path = document.createElementNS(SVG_NS, "path");
	path.setAttribute("fill", "none");
	path.setAttribute("stroke", colorHex);
	path.setAttribute("stroke-width", String(width * scale));
	path.setAttribute("stroke-linecap", "round");
	path.setAttribute("stroke-linejoin", "round");
	path.classList.add("pr-ink-live");
	svg.appendChild(path);

	let lastX = startX;
	let lastY = startY;
	const minDist = 1.5 / scale; // sampling threshold in page units

	return {
		addPoint(x: number, y: number): void {
			const dx = x - lastX;
			const dy = y - lastY;
			if (dx * dx + dy * dy < minDist * minDist) return;
			points.push(x, y);
			lastX = x;
			lastY = y;
			path.setAttribute("d", strokePath(points, scale));
		},
		finish() {
			path.remove();
			if (points.length < 4) return null; // need at least 2 points
			return { width, points };
		},
		discard() {
			path.remove();
		},
	};
}

/** bounding box of an ink stroke in unscaled page coords */
export function inkBoundingRect(points: number[]): {
	x: number;
	y: number;
	width: number;
	height: number;
} {
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (let i = 0; i + 1 < points.length; i += 2) {
		minX = Math.min(minX, points[i]);
		maxX = Math.max(maxX, points[i]);
		minY = Math.min(minY, points[i + 1]);
		maxY = Math.max(maxY, points[i + 1]);
	}
	if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
