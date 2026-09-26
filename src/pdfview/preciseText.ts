/// <reference lib="es2022.intl" />
import type { PDFOperatorList, TextContent, TextItem } from "pdfjs-dist/types/src/display/api";

type Operators = Record<"save" | "restore" | "setFont" | "showText" |
	"setCharSpacing" | "setWordSpacing" | "setGState", number> &
	Partial<Record<"paintFormXObjectBegin" | "paintFormXObjectEnd" | "beginGroup" | "endGroup", number>>;
type Glyph = { text: string; start: number; end: number };
type Run = { glyphs: Glyph[]; width: number };
const keyOf = (font: string, text: string) => `${font}:${text.replace(/\s/g, "")}`;

/** Read PDF advances (including TJ kerning) without interpreting page coordinates.
 * ponytail: exact whole-run matches only; add positional matching if split runs need it.
 * TextContent supplies their page transform; uncertain runs keep PDF.js's layout.
 * Embedded fonts cannot simply be applied to Unicode: PDF.js remaps their glyphs.
 */
export function preciseTextContent(content: TextContent, list: PDFOperatorList, ops: Operators): {
	content: TextContent; glyphItems: Map<TextItem, TextItem>;
} {
	const runs = new Map<string, Map<string, Run>>();
	let state = { font: "", size: 0, char: 0, word: 0 };
	const stack: typeof state[] = [];
	for (let i = 0; i < list.fnArray.length; i++) {
		const op = list.fnArray[i];
		const args = list.argsArray[i] as unknown[];
		if (op === ops.save || op === ops.paintFormXObjectBegin || op === ops.beginGroup) stack.push({ ...state });
		else if (op === ops.restore || op === ops.paintFormXObjectEnd || op === ops.endGroup) {
			state = stack.pop() ?? { font: "", size: 0, char: 0, word: 0 };
		} else if (op === ops.setFont) {
			state.font = String(args[0]); state.size = Number(args[1]);
		} else if (op === ops.setCharSpacing) state.char = Number(args[0]);
		else if (op === ops.setWordSpacing) state.word = Number(args[0]);
		else if (op === ops.setGState && Array.isArray(args[0])) {
			for (const [name, value] of args[0] as [string, unknown][]) {
				if (name === "Font" && Array.isArray(value)) {
					state.font = String(value[0]); state.size = Number(value[1]);
				}
			}
		} else if (op === ops.showText && state.size > 0 && Array.isArray(args[0])) {
			let x = 0;
			const glyphs: Glyph[] = [];
			for (const value of args[0] as unknown[]) {
				if (typeof value === "number") { x -= value / 1000; continue; }
				if (!value || typeof value !== "object") { x = NaN; break; }
				const g = value as { unicode?: unknown; width?: unknown; isSpace?: boolean };
				if (typeof g.unicode !== "string" || typeof g.width !== "number") { x = NaN; break; }
				const start = x;
				x += g.width / 1000 + (state.char + (g.isSpace ? state.word : 0)) / state.size;
				glyphs.push({ text: g.unicode.normalize("NFKC"), start, end: x });
			}
			if (!glyphs.length || !Number.isFinite(x)) continue;
			const origin = glyphs[0].start;
			const run = { glyphs: glyphs.map(g => ({ ...g, start: g.start - origin, end: g.end - origin })), width: x - origin };
			const key = keyOf(state.font, glyphs.map(g => g.text).join(""));
			const candidates = runs.get(key) ?? new Map<string, Run>();
			// Repeated identical text usually shares metrics; avoid quadratic matching.
			candidates.set(JSON.stringify(run), run);
			runs.set(key, candidates);
		}
	}

	const glyphItems = new Map<TextItem, TextItem>();
	// PDF.js stops at 100,000 text divs. Expansion must never truncate page text.
	let extraItems = Math.max(0, 100_000 - content.items.length);
	const items = content.items.flatMap(item => {
		if (!("str" in item) || !item.str || item.dir !== "ltr" || content.styles[item.fontName]?.vertical) return [item];
		const [a, b, c, d, x, y] = item.transform as number[];
		const scale = Math.hypot(a, b);
		if (!(scale > 0) || ![a, b, c, d, x, y, item.width].every(Number.isFinite)) return [item];
		const matches = [...(runs.get(keyOf(item.fontName, item.str))?.values() ?? [])].filter(run =>
			Math.abs(run.width * scale - item.width) <= Math.max(0.02, item.width * 0.0001));
		if (matches.length !== 1) return [item];
		const run = matches[0];
		const parts: Glyph[] = [];
		let offset = 0, previousEnd = 0;
		for (const glyph of run.glyphs) {
			if (!glyph.text) return [item];
			// getTextContent synthesizes spaces for sufficiently large TJ gaps.
			if (!/^\s/.test(glyph.text)) {
				const space = /^\s+/.exec(item.str.slice(offset))?.[0];
				if (space) {
					parts.push({ text: space, start: previousEnd, end: glyph.start });
					offset += space.length;
				}
			}
			if (!item.str.startsWith(glyph.text, offset)) return [item];
			parts.push({ ...glyph }); offset += glyph.text.length; previousEnd = glyph.end;
		}
		if (offset !== item.str.length) return [item];
		// Each selectable cell ends at the next glyph's origin, including kerning.
		for (let i = 0; i < parts.length - 1; i++) parts[i].end = parts[i + 1].start;
		if (parts.some(p => !(p.end > p.start))) return [item];
		if (parts.length - 1 > extraItems) return [item];
		extraItems -= parts.length - 1;
		return parts.map((part, i): TextItem => {
			const glyph = { ...item, str: part.text, width: (part.end - part.start) * scale,
				transform: [a, b, c, d, x + part.start * a, y + part.start * b],
				hasEOL: i === parts.length - 1 && item.hasEOL };
			glyphItems.set(glyph, item);
			return glyph;
		});
	});
	return { content: { ...content, items }, glyphItems };
}

/** Absolute glyph cells need the original Unicode run for double-click word selection. */
export function preserveWordSelection(layer: HTMLElement, groups: HTMLElement[][]): void {
	const groupFor = new WeakMap<HTMLElement, HTMLElement[]>();
	for (const group of groups) for (const div of group) groupFor.set(div, group);
	const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
	layer.addEventListener("dblclick", event => {
		const group = groupFor.get(event.target as HTMLElement);
		if (!group) return;
		const offset = group.slice(0, group.indexOf(event.target as HTMLElement))
			.reduce((sum, div) => sum + (div.textContent?.length ?? 0), 0);
		const text = group.map(div => div.textContent ?? "").join("");
		const word = segmenter.segment(text).containing(offset);
		if (!word) return;
		const point = (position: number): [Node, number] => {
			for (const div of group) {
				const node = div.firstChild!;
				const length = node.textContent!.length;
				if (position <= length) return [node, position];
				position -= length;
			}
			const node = group[group.length - 1].firstChild!;
			return [node, node.textContent!.length];
		};
		const range = layer.ownerDocument.createRange();
		range.setStart(...point(word.index));
		range.setEnd(...point(word.index + word.segment.length));
		const selection = layer.ownerDocument.getSelection();
		selection?.removeAllRanges(); selection?.addRange(range);
	});
}
