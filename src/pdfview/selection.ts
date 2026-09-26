import type { HighlightRect } from "../storage/annotationStore";

export interface SelectionPayload {
	page: number;
	rects: HighlightRect[];
	text: string;
	textOffset: number;
	contextBefore: string;
	contextAfter: string;
	/** viewport coords of the selection end, used to position the toolbar */
	anchorRect: DOMRect;
}

const CONTEXT_LEN = 32;

/** Whether two unscaled page rects overlap (with a small tolerance). */
export function rectsOverlap(a: HighlightRect, b: HighlightRect): boolean {
	const tol = 1;
	return (
		a.x < b.x + b.width - tol &&
		a.x + a.width > b.x + tol &&
		a.y < b.y + b.height - tol &&
		a.y + a.height > b.y + tol
	);
}

function elementOf(node: Node | null): Element | null {
	if (!node) return null;
	return node.nodeType === Node.ELEMENT_NODE
		? (node as Element)
		: node.parentElement;
}

/** Caret (collapsed range) rect at a DOM position — reliable even inside
 *  scaled spans, unlike Range.getClientRects() on transformed elements. */
function caretRect(node: Node, offset: number): DOMRect | null {
	const r = document.createRange();
	r.setStart(node, offset);
	r.collapse(true);
	const rects = r.getClientRects();
	return rects.length > 0 ? rects[0] : null;
}

export interface RectLike {
	left: number;
	top: number;
	width: number;
	height: number;
	bottom?: number;
}

/** Single-line selection band from caret positions; null if not single-line. */
export function buildSingleLineRect(
	startCaret: RectLike,
	endCaret: RectLike
): RectLike | null {
	if (Math.abs(startCaret.top - endCaret.top) >= Math.max(startCaret.height, 1) * 0.5) {
		return null;
	}
	const width = endCaret.left - startCaret.left;
	if (width <= 0 || startCaret.height < 2) return null;
	return {
		left: startCaret.left,
		top: startCaret.top,
		width,
		height: startCaret.height,
	};
}

/**
 * Multi-line rect cleanup: keep rects inside the caret-bounded vertical band,
 * drop oversized boxes from transformed spans, dedupe near-duplicate pairs.
 */
export function filterMultiLineRects<T extends RectLike>(
	raw: T[],
	bandTop: number,
	bandBottom: number,
	lineH: number
): T[] {
	const kept: T[] = [];
	for (const r of raw) {
		const bottom = r.bottom ?? r.top + r.height;
		if (r.width < 2 || r.height < 2) continue;
		if (bottom < bandTop || r.top > bandBottom) continue;
		if (lineH > 0 && r.height > lineH * 2.5) continue;
		if (kept.some((k) => Math.abs(k.top - r.top) < 4 && Math.abs(k.left - r.left) < 4))
			continue;
		kept.push(r);
	}
	return kept;
}

/** Rejoin adjacent glyph cells into line bands, retaining gaps between columns. */
export function mergeTextRects(raw: RectLike[]): RectLike[] {
	const merged: RectLike[] = [];
	for (const rect of [...raw].sort((a, b) => a.top - b.top || a.left - b.left)) {
		const last = merged[merged.length - 1];
		if (last && Math.abs(last.top - rect.top) < 1 && Math.abs(last.height - rect.height) < 1 &&
			rect.left <= last.left + last.width + Math.max(1, rect.height / 2)) {
			last.width = Math.max(last.left + last.width, rect.left + rect.width) - last.left;
		} else merged.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
	}
	return merged;
}

/** Text boxes only: a DOM Range may also include duplicate transformed span boxes. */
export function textRangeRects(range: Range, root: Node): DOMRect[] {
	const rects: DOMRect[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!node.textContent?.trim() || !range.intersectsNode(node)) continue;
		const part = document.createRange();
		part.selectNodeContents(node);
		if (part.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
			part.setStart(range.startContainer, range.startOffset);
		}
		if (part.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
			part.setEnd(range.endContainer, range.endOffset);
		}
		if (!part.collapsed) rects.push(...Array.from(part.getClientRects()));
	}
	return rects;
}

/** Clip adjacent selection lines at their midpoint so translucent fills never stack. */
export function separateSelectionLines(rects: HighlightRect[]): HighlightRect[] {
	const lines: { center: number; rects: HighlightRect[] }[] = [];
	for (const rect of [...rects].sort((a, b) => a.y + a.height / 2 - b.y - b.height / 2)) {
		const center = rect.y + rect.height / 2;
		const line = lines.find((item) =>
			Math.abs(item.center - center) < Math.min(item.rects[0].height, rect.height) / 2
		);
		if (line) line.rects.push(rect);
		else lines.push({ center, rects: [rect] });
	}
	return lines.flatMap((line, index) => {
		const top = index > 0 ? (lines[index - 1].center + line.center) / 2 : -Infinity;
		const bottom = index + 1 < lines.length
			? (line.center + lines[index + 1].center) / 2
			: Infinity;
		return line.rects.map((rect) => {
			const y = Math.max(rect.y, top);
			return { ...rect, y, height: Math.max(0, Math.min(rect.y + rect.height, bottom) - y) };
		}).filter((rect) => rect.height > 0);
	});
}

/** Draw the active browser selection with line-safe bands over the PDF page. */
export function renderSelectionPreview(layer: HTMLElement, rects: HighlightRect[], scale: number): void {
	layer.replaceChildren();
	layer.parentElement?.classList.toggle("pr-selection-preview", rects.length > 0);
	for (const rect of separateSelectionLines(rects)) {
		const el = layer.createDiv({ cls: "pr-selection-rect" });
		el.setCssStyles({ backgroundColor: "rgba(122, 96, 255, 0.35)" });
		el.style.left = `${rect.x * scale}px`;
		el.style.top = `${rect.y * scale}px`;
		el.style.width = `${rect.width * scale}px`;
		el.style.height = `${rect.height * scale}px`;
	}
}

/** Whether two payloads describe the same selection (page + text identity). */
export function sameSelection(
	a: SelectionPayload | null,
	b: SelectionPayload | null
): boolean {
	return !!a && !!b && a.page === b.page && a.text === b.text;
}

/**
 * Best-effort offset of the selected text inside the page's extracted text.
 * DOM selection text and pdf.js extracted text may differ in whitespace,
 * so we fall back to a whitespace-normalised search on a prefix.
 */
function locateInPageText(
	pageText: string,
	selectedText: string
): { offset: number; length: number } {
	const needle = selectedText.trim();
	if (!needle) return { offset: -1, length: 0 };
	let offset = pageText.indexOf(needle);
	if (offset >= 0) return { offset, length: needle.length };

	// whitespace-normalised fallback: search a prefix of the selection
	const prefix = needle.slice(0, 24);
	offset = pageText.indexOf(prefix);
	if (offset >= 0) return { offset, length: needle.length };
	return { offset: -1, length: 0 };
}

/**
 * Map the current DOM selection (inside a pdf.js text layer) to page number,
 * unscaled page rects and a text fingerprint. Returns null when the selection
 * is empty or outside the reader.
 *
 * M1 limitation: only the part of the selection on the anchor page is kept.
 */
export function selectionToPayload(
	selection: Selection,
	scale: number,
	getPageText: (page: number) => string | undefined
): SelectionPayload | null {
	if (selection.isCollapsed || selection.rangeCount === 0) return null;
	const text = selection.toString();
	if (!text.trim()) return null;

	const range = selection.getRangeAt(0);
	const anchorEl = elementOf(selection.anchorNode);
	const pageEl = anchorEl?.closest(".pr-page");
	if (!(pageEl instanceof HTMLElement)) return null;
	const page = Number(pageEl.dataset.pageNumber);
	if (!Number.isFinite(page)) return null;

	const pageRect = pageEl.getBoundingClientRect();
	const toPageRect = (
		left: number,
		top: number,
		width: number,
		height: number
	): HighlightRect | null => {
		// clip to page bounds (cross-page bleed) and skip slivers
		const l = Math.max(left, pageRect.left);
		const t = Math.max(top, pageRect.top);
		const r = Math.min(left + width, pageRect.right);
		const b = Math.min(top + height, pageRect.bottom);
		const w = r - l;
		const h = b - t;
		if (w <= 0 || h < 2) return null;
		// Line-box height includes leading; trim ~10% top and bottom so
		// highlight bands hug the glyphs and don't overlap adjacent lines.
		const trim = h * 0.1;
		return {
			x: (l - pageRect.left) / scale,
			y: (t + trim - pageRect.top) / scale,
			width: w / scale,
			height: (h - 2 * trim) / scale,
		};
	};

	// Caret rects at both ends of the (document-ordered) range.
	const startCaret = caretRect(range.startContainer, range.startOffset);
	const endCaret = caretRect(range.endContainer, range.endOffset);
	const singleLineRect =
		!text.includes("\n") && startCaret && endCaret
			? buildSingleLineRect(startCaret, endCaret)
			: null;

	const rects: HighlightRect[] = [];
	if (singleLineRect) {
		// Exact single-line band from caret positions. This avoids the
		// pathological multi-line boxes Range.getClientRects() returns for
		// spans with CSS transforms (rotated/scaled text), where the whole
		// block would otherwise be covered by a one-line selection.
		const rect = toPageRect(
			singleLineRect.left,
			singleLineRect.top,
			singleLineRect.width,
			singleLineRect.height
		);
		if (rect) rects.push(rect);
	} else {
		// A range spanning whole PDF spans includes both element and text boxes.
		// Measure selected text nodes only, so each glyph run is counted once.
		const raw = textRangeRects(range, pageEl.querySelector(".textLayer") ?? pageEl);
		const bandTop =
			Math.min(startCaret?.top ?? Infinity, endCaret?.top ?? Infinity) - 2;
		const bandBottom = Math.max(
			(startCaret ? startCaret.top + startCaret.height : -Infinity),
			(endCaret ? endCaret.top + endCaret.height : -Infinity)
		) + 2;
		const lineH = Math.max(startCaret?.height ?? 0, endCaret?.height ?? 0);
		const kept = filterMultiLineRects(
			mergeTextRects(raw),
			bandTop,
			bandBottom,
			lineH
		);
		const source =
			kept.length > 0
				? kept
				: // fallback: unfiltered (e.g. rotated text where caret heights
				  // are degenerate); better a rough box than no annotation
				  raw;
		for (const r of source) {
			const rect = toPageRect(r.left, r.top, r.width, r.height);
			if (rect) rects.push(rect);
		}
	}
	if (rects.length === 0) return null;

	const pageText = getPageText(page) ?? "";
	const { offset, length } = locateInPageText(pageText, text);
	const contextBefore =
		offset >= 0 ? pageText.slice(Math.max(0, offset - CONTEXT_LEN), offset) : "";
	const contextAfter =
		offset >= 0 ? pageText.slice(offset + length, offset + length + CONTEXT_LEN) : "";

	return {
		page,
		rects,
		text,
		textOffset: offset,
		contextBefore,
		contextAfter,
		anchorRect: range.getBoundingClientRect(),
	};
}
