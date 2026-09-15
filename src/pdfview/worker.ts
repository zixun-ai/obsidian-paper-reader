import { configurePdfWorker } from "./PdfRenderer";

// Injected as text by esbuild; no runtime download or separate release asset.
declare const __PDF_WORKER_SOURCE__: string;

export function configureBundledPdfWorker(): () => void {
	const url = URL.createObjectURL(new Blob([__PDF_WORKER_SOURCE__], { type: "text/javascript" }));
	configurePdfWorker(url);
	return () => URL.revokeObjectURL(url);
}
