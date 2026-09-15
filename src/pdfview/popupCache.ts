import type { SelectionPayload } from "./selection";

export interface PopupCachedState {
	translation?: string;
	noteDraft?: string;
}

/** Cache key identifying "the same selection": page + text identity. */
export function popupCacheKey(payload: SelectionPayload): string {
	return `${payload.page}|${payload.text.length}|${payload.text.slice(0, 48)}`;
}

/**
 * View-session cache for popup state (translation result + note draft).
 * Survives popup re-renders and hide/show cycles for the same selection;
 * a different selection yields a different key and starts fresh.
 */
export class PopupStateCache {
	private map = new Map<string, PopupCachedState>();

	get(key: string): PopupCachedState | undefined {
		return this.map.get(key);
	}

	merge(key: string, state: PopupCachedState): void {
		this.map.set(key, { ...this.map.get(key), ...state });
	}

	clear(): void {
		this.map.clear();
	}
}
