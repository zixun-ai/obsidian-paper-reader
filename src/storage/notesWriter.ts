import { App, Notice, normalizePath } from "obsidian";

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
	const path = notesPathFor(pdfPath, suffix);
	const pdfName = pdfPath.split("/").pop() ?? pdfPath;
	const marker = markerFor(entry);
	try {
		const adapter = app.vault.adapter;
		let existing = "";
		if (await adapter.exists(path)) {
			existing = await adapter.read(path);
		} else {
			existing =
				`---\npdf: "[[${pdfName}]]"\ncreated: "${new Date().toISOString()}"\n---\n\n` +
				`# ${pdfName.replace(/\.pdf$/i, "")} 标注笔记\n`;
		}
		if (existing.includes(marker)) {
			new Notice("该标注已导出过，已跳过");
			return false;
		}
		const quote = entry.quote
			.split("\n")
			.map((l) => `> ${l}`)
			.join("\n");
		const link = backlinkFor(pdfPath, entry.page);
		const block =
			`\n\n## ${entry.title} · p.${entry.page} · ${formatTime(new Date())}\n\n` +
			`${quote ? quote + "\n\n" : ""}${entry.content}\n\n` +
			`[→ 回到原文 p.${entry.page}](${link}) ${marker}\n`;
		await adapter.write(path, existing + block);
		new Notice(`已插入标注笔记：${path.split("/").pop()}`);
		return true;
	} catch (e) {
		console.error("[paper-reader] failed to append notes", e);
		new Notice(`写入标注笔记失败 (${path})`);
		return false;
	}
}
