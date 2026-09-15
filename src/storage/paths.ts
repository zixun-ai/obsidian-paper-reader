import { normalizePath } from "obsidian";

/**
 * Resolve the annotation JSON path for a given PDF path.
 * The annotation file lives next to the PDF, e.g.
 * "papers/sub/foo.pdf" -> "papers/sub/foo.annotations.json" (default suffix).
 */
export function annotationPathFor(pdfPath: string, suffix: string): string {
	const dot = pdfPath.lastIndexOf(".");
	const base = dot > 0 ? pdfPath.slice(0, dot) : pdfPath;
	return normalizePath(base + suffix);
}
