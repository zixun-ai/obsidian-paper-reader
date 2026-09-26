import { App, Notice, TFile, normalizePath } from "obsidian";
import { withFileLock } from "./fileQueue";

export interface NotesEntry {
	/** section title, e.g. 翻译 / AI 解释 / AI 问答 */
	title: string;
	page: number;
	/** quoted original text */
	quote: string;
	/** AI-produced content (markdown) */
	content: string;
	/** annotation id for duplicate-export detection */
	annId?: string;
}

export function notesPathFor(pdfPath: string, suffix: string): string {
	const dot = pdfPath.lastIndexOf(".");
	const base = dot > 0 ? pdfPath.slice(0, dot) : pdfPath;
	return normalizePath(base + suffix);
}

/** obsidian:// link that reopens the pdf at the given page.
 *  Obsidian only routes obsidian:// URIs to registerObsidianProtocolHandler,
 *  so the action segment must be the plugin id ("paper-reader"). */
export function backlinkFor(pdfPath: string, page: number): string {
	return `obsidian://paper-reader?file=${encodeURIComponent(pdfPath)}&page=${page}`;
}

function formatTime(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}`
	);
}

/** djb2 hash for dedupe markers of entries without an annotation id */
function simpleHash(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) {
		h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(36);
}

function markerFor(entry: NotesEntry): string {
	return entry.annId
		? `<!-- pr:ann:${entry.annId} -->`
		: `<!-- pr:hash:${simpleHash(entry.quote + "\n" + entry.content)} -->`;
}

/**
 * Append an entry to the paper's markdown notes file, creating it (with
 * frontmatter) on first use. Append-only: user edits are never rewritten.
 * Duplicate exports (same annotation id / same content hash) are skipped
 * with a Notice instead of being appended twice.
 */
export async function appendToNotes(
	app: App,
	pdfPath: string,
	suffix: string,
	entry: NotesEntry
): Promise<boolean> {
	return appendManyToNotes(app, pdfPath, suffix, [entry]);
}

/** A batch shares the same atomic path as single exports and emits one result. */
export async function appendManyToNotes(
	app: App, pdfPath: string, suffix: string, entries: NotesEntry[]
): Promise<boolean> {
	if (!entries.length) return false;
	const path = notesPathFor(pdfPath, suffix);
	const pdfName = pdfPath.split("/").pop() ?? pdfPath;
	const blocks = entries.map(entry => {
		const marker = markerFor(entry);
		const quote = entry.quote.split("\n").map(l => `> ${l}`).join("\n");
		return { marker, text:
			`\n\n## ${entry.title} · p.${entry.page} · ${formatTime(new Date())}\n\n` +
			`${quote ? quote + "\n\n" : ""}${entry.content}\n\n` +
			`[→ 回到原文 p.${entry.page}](${backlinkFor(pdfPath, entry.page)}) ${marker}\n` };
	});
	try {
		return await withFileLock(app.vault.adapter, path, async () => {
			const update = (existing: string) => {
				const markers = new Set(existing.match(/<!-- pr:(?:ann|hash):[^\r\n]*? -->/g) ?? []);
				const additions: string[] = [];
				for (const block of blocks) {
					if (markers.has(block.marker)) continue;
					markers.add(block.marker); additions.push(block.text);
				}
				return existing + additions.join("");
			};
			let file = app.vault.getAbstractFileByPath(path);
			if (!file) {
				const initial =
					`---\npdf: "[[${pdfName}]]"\ncreated: "${new Date().toISOString()}"\n---\n\n` +
					`# ${pdfName.replace(/\.pdf$/i, "")} 标注笔记\n`;
				try {
					await app.vault.create(path, update(initial));
					new Notice(`已插入标注笔记：${path.split("/").pop()}`);
					return true;
				} catch (error) {
					file = app.vault.getAbstractFileByPath(path);
					if (!file) throw error;
				}
			}
			if (!(file instanceof TFile)) throw new Error("笔记目标不是文件");
			let changed = false;
			await app.vault.process(file, before => {
				const after = update(before); changed = after !== before; return after;
			});
			new Notice(changed ? `已插入标注笔记：${path.split("/").pop()}` : "该标注已导出过，已跳过");
			return changed;
		});
	} catch (e) {
		console.error("[paper-reader] failed to append notes", e);
		new Notice(`写入标注笔记失败 (${path})`);
		return false;
	}
}
