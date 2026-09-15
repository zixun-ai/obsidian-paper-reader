// Minimal obsidian module stub for unit tests (aliased by esbuild).
export class Notice {
	static messages: string[] = [];
	constructor(msg: unknown) {
		Notice.messages.push(String(msg));
	}
	static reset(): void {
		Notice.messages = [];
	}
}
export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}
export class App {}
export class TFile {}
export function setIcon(): void {}
export async function requestUrl(): Promise<never> {
	throw new Error("requestUrl not available in tests");
}
