import { App, Notice } from "obsidian";
import { annotationPathFor } from "./paths";
import { withFileLock } from "./fileQueue";

/** Rect in unscaled PDF page coordinates (scale = 1 viewport units). */
export interface HighlightRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type AnnotationType = "highlight" | "note" | "translation" | "qa" | "ink";

/** rendering style of a page annotation; absent = "highlight" (back-compat) */
export type AnnotationStyle = "highlight" | "underline" | "wavy" | "strikethrough";

/** one pen stroke: flattened unscaled page coordinates [x1,y1,x2,y2,...] */
export interface InkStroke {
	/** stroke width in unscaled page units */
	width: number;
	points: number[];
	/** semantic shape marker; absent means freehand ink (back-compat) */
	shape?: "rectangle";
}

export interface Annotation {
	id: string;
	type: AnnotationType;
	/** 1-based page number */
	page: number;
	rects: HighlightRect[];
	text: string;
	/** color key, e.g. "yellow" | "green" | "blue" | "red" */
	color: string;
	style?: AnnotationStyle;
	note?: string;
	aiContent?: string;
	/** pen strokes; only for type "ink" */
	ink?: InkStroke;
	createdAt: string;
	/** best-effort offset of `text` within the page's extracted text, -1 if unknown */
	textOffset: number;
	/** up to 32 chars before/after the selection in the page text (fingerprint) */
	contextBefore: string;
	contextAfter: string;
}

export interface AnnotationFile {
	version: 1;
	file: string;
	annotations: Annotation[];
}

export function emptyAnnotationFile(pdfPath: string): AnnotationFile {
	const name = pdfPath.split("/").pop() ?? pdfPath;
	return { version: 1, file: name, annotations: [] };
}

/** Build an annotation from a captured selection payload snapshot. */
export function annotationFromPayload(
	payload: {
		page: number;
		rects: HighlightRect[];
		text: string;
		textOffset: number;
		contextBefore: string;
		contextAfter: string;
	},
	fields: {
		type: AnnotationType;
		color: string;
		style?: AnnotationStyle;
		note?: string;
		aiContent?: string;
	}
): Annotation {
	return {
		id: crypto.randomUUID(),
		createdAt: new Date().toISOString(),
		page: payload.page,
		rects: payload.rects,
		text: payload.text,
		textOffset: payload.textOffset,
		contextBefore: payload.contextBefore,
		contextAfter: payload.contextAfter,
		...fields,
	};
}

export class AnnotationStore {
	/** pdf paths whose annotation file is corrupt: writes are blocked */
	private corrupted = new Set<string>();
	private revision: { path: string; raw: string | null } | null = null;

	constructor(
		private app: App,
		private getSuffix: () => string
	) {}

	pathFor(pdfPath: string): string {
		return annotationPathFor(pdfPath, this.getSuffix());
	}

	/** whether the annotation file for this pdf failed to parse */
	isCorrupted(pdfPath: string): boolean {
		return this.corrupted.has(pdfPath);
	}

	async load(pdfPath: string): Promise<AnnotationFile> {
		const path = this.pathFor(pdfPath);
		const adapter = this.app.vault.adapter;
		try {
			return await withFileLock(adapter, path, async () => {
				if (!(await adapter.exists(path))) {
					this.revision = { path, raw: null };
					this.corrupted.delete(pdfPath);
					return emptyAnnotationFile(pdfPath);
				}
				const raw = await adapter.read(path);
				const parsed = JSON.parse(raw) as AnnotationFile;
				if (!parsed || !Array.isArray(parsed.annotations)) {
					throw new Error("invalid annotation file shape");
				}
				// a previously corrupt file parses fine now -> lift protection
				this.corrupted.delete(pdfPath);
				this.revision = { path, raw };
				return parsed;
			});
		} catch (e) {
			console.error("[paper-reader] failed to load annotations", e);
			// back up the corrupt file once, then enter read-only protection:
			// never overwrite the original with an empty set
			try {
				const bak = path + ".bak";
				if ((await adapter.exists(path)) && !(await adapter.exists(bak))) {
					await adapter.copy(path, bak);
				}
			} catch (backupErr) {
				console.error("[paper-reader] failed to back up corrupt file", backupErr);
			}
			this.corrupted.add(pdfPath);
			new Notice(
				`Paper Reader: 标注文件损坏，已进入只读保护（已备份为 ${path.split("/").pop()}.bak）`
			);
			return emptyAnnotationFile(pdfPath);
		}
	}

	async save(pdfPath: string, data: AnnotationFile): Promise<boolean> {
		const path = this.pathFor(pdfPath);
		const adapter = this.app.vault.adapter;
		if (this.corrupted.has(pdfPath)) {
			new Notice("Paper Reader: 标注文件已损坏，写入已阻断以保护原数据（请修复或删除后重开 PDF）");
			return false;
		}
		try {
			const content = JSON.stringify(data, null, 2);
			return await withFileLock(adapter, path, async () => {
				const current = await adapter.exists(path) ? await adapter.read(path) : null;
				if (current === content) {
					this.revision = { path, raw: content };
					return true; // Safe retry if the write succeeded but its verification read failed.
				}
				const expected = this.revision?.path === path ? this.revision.raw : null;
				if (current !== expected) {
					new Notice("标注已被其他窗口或同步更新，本次未覆盖。请保留批注草稿，重新打开 PDF 后重试。");
					return false;
				}
				await adapter.write(path, content);
				// write-verify: transient sync-dir failures must not pass silently
				const readBack = await adapter.read(path);
				if (readBack !== content) {
					throw new Error("read-back verification failed");
				}
				this.revision = { path, raw: content };
				return true;
			});
		} catch (e) {
			console.error("[paper-reader] failed to save annotations", e);
			new Notice(`Paper Reader: 标注写入失败，内存中的标注未丢失，请重试 (${path})`);
			return false;
		}
	}
}
