import type { Annotation } from "../storage/annotationStore";

export type RectangleHandle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export interface RectangleBounds { x: number; y: number; width: number; height: number }

export function rectanglePoints(x: number, y: number, width: number, height: number): number[] {
	return [x, y, x + width, y, x + width, y + height, x, y + height, x, y];
}

export function transformRectangle(
	b: RectangleBounds,
	handle: RectangleHandle,
	dx: number,
	dy: number,
	pageWidth: number,
	pageHeight: number,
	minSize = 1
): RectangleBounds {
	if (handle === "move") {
		return {
			x: Math.max(0, Math.min(b.x + dx, pageWidth - b.width)),
			y: Math.max(0, Math.min(b.y + dy, pageHeight - b.height)),
			width: b.width,
			height: b.height,
		};
	}
	let left = b.x, top = b.y, right = b.x + b.width, bottom = b.y + b.height;
	if (handle.includes("w")) left = Math.max(0, Math.min(left + dx, right - minSize));
	if (handle.includes("e")) right = Math.min(pageWidth, Math.max(right + dx, left + minSize));
	if (handle.includes("n")) top = Math.max(0, Math.min(top + dy, bottom - minSize));
	if (handle.includes("s")) bottom = Math.min(pageHeight, Math.max(bottom + dy, top + minSize));
	return { x: left, y: top, width: right - left, height: bottom - top };
}

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
	const path = createSvg("path");
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
		if (ann.id === selectedId && ann.ink.shape === "rectangle") {
			const b = inkBoundingRect(ann.ink.points);
			const selection = createSvg("rect");
			selection.setAttribute("x", String(b.x * scale));
			selection.setAttribute("y", String(b.y * scale));
			selection.setAttribute("width", String(b.width * scale));
			selection.setAttribute("height", String(b.height * scale));
			selection.classList.add("pr-ink-selection");
			selection.dataset.annotationId = ann.id;
			selection.dataset.inkHandle = "move";
			svg.appendChild(selection);
			const handles: [RectangleHandle, number, number][] = [
				["nw", b.x, b.y], ["n", b.x + b.width / 2, b.y], ["ne", b.x + b.width, b.y],
				["e", b.x + b.width, b.y + b.height / 2], ["se", b.x + b.width, b.y + b.height],
				["s", b.x + b.width / 2, b.y + b.height], ["sw", b.x, b.y + b.height],
				["w", b.x, b.y + b.height / 2],
			];
			for (const [handle, x, y] of handles) {
				const dot = createSvg("circle");
				dot.setAttribute("cx", String(x * scale));
				dot.setAttribute("cy", String(y * scale));
				dot.setAttribute("r", "4.5");
				dot.classList.add("pr-ink-handle", `pr-ink-handle-${handle}`);
				dot.dataset.annotationId = ann.id;
				dot.dataset.inkHandle = handle;
				svg.appendChild(dot);
			}
		}
	}
}

export interface LiveStroke {
	addPoint(x: number, y: number): void;
	/** returns the finished stroke, or null when too few points */
	finish(): { width: number; points: number[]; shape?: "rectangle" } | null;
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
	const path = createSvg("path");
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

/** Live hollow rectangle stored as a closed ink path. */
export function beginInkRectangle(
	svg: SVGSVGElement,
	colorHex: string,
	width: number,
	scale: number,
	startX: number,
	startY: number
): LiveStroke {
	let endX = startX;
	let endY = startY;
	let points = rectanglePoints(startX, startY, 0, 0);
	const path = createSvg("path");
	path.setAttribute("fill", "none");
	path.setAttribute("stroke", colorHex);
	path.setAttribute("stroke-width", String(width * scale));
	path.setAttribute("stroke-linejoin", "round");
	path.classList.add("pr-ink-live");
	svg.appendChild(path);

	return {
		addPoint(x: number, y: number): void {
			endX = x;
			endY = y;
			const left = Math.min(startX, endX), top = Math.min(startY, endY);
			points = rectanglePoints(left, top, Math.abs(endX - startX), Math.abs(endY - startY));
			path.setAttribute("d", strokePath(points, scale));
		},
		finish() {
			path.remove();
			if (Math.abs(endX - startX) * scale < 2 || Math.abs(endY - startY) * scale < 2) return null;
			return { width, points, shape: "rectangle" };
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
