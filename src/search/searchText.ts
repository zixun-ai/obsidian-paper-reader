export interface SearchHit {
	page: number;
	/** char offset within the page's extracted text */
	index: number;
	length: number;
}

/**
 * Lowercase + collapse whitespace runs to single spaces, keeping a map from
 * normalized index back to the original index. Handles the gaps pdf.js leaves
 * between text items so queries need not match a single span exactly.
 */
export function normalizeWithMap(text: string): { norm: string; map: number[] } {
	const map: number[] = [];
	let norm = "";
	let inWs = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (/\s/.test(ch)) {
			if (!inWs && norm.length > 0) {
				norm += " ";
				map.push(i);
			}
			inWs = true;
		} else {
			norm += ch.toLowerCase();
			map.push(i);
			inWs = false;
		}
	}
	return { norm, map };
}

export function normalizeQuery(query: string): string {
	return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Find all hits of query inside each page's extracted text.
 * pageTexts[i] corresponds to page i + 1; undefined entries are skipped.
 */
export function findHits(
	pageTexts: (string | undefined)[],
	query: string
): SearchHit[] {
	const q = normalizeQuery(query);
	if (!q) return [];
	const hits: SearchHit[] = [];
	for (let p = 0; p < pageTexts.length; p++) {
		const text = pageTexts[p];
		if (!text) continue;
		const { norm, map } = normalizeWithMap(text);
		let from = 0;
		for (;;) {
			const idx = norm.indexOf(q, from);
			if (idx < 0) break;
			const origStart = map[idx];
			const origEnd = idx + q.length - 1 < map.length ? map[idx + q.length - 1] : text.length - 1;
			hits.push({ page: p + 1, index: origStart, length: origEnd - origStart + 1 });
			from = idx + 1;
		}
	}
	return hits;
}
