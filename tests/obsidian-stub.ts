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
export class ConfirmationModal {
	private title = "";
	private content = "";
	private approve: (() => unknown) | null = null;
	onClose(): void {}
	constructor(_app: App) {}
	setTitle(value: string): this { this.title = value; return this; }
	setContent(value: string): this { this.content = value; return this; }
	addButton(cb: (button: any) => void): this {
		const button = {
			setButtonText: () => button,
			setCta: () => button,
			setInitialFocus: () => button,
			onClick: (handler: () => unknown) => { this.approve = handler; return button; },
		};
		cb(button);
		return this;
	}
	addCancelButton(): this { return this; }
	open(): void {
		if (window.confirm(`${this.title}\n${this.content}`)) void this.approve?.();
		else this.onClose();
	}
}
export class TFile {}
export class Component {
	children: Component[] = [];
	private cleanups: (() => void)[] = [];
	addChild<T extends Component>(child: T): T { this.children.push(child); return child; }
	removeChild(child: Component): void { this.children = this.children.filter(c => c !== child); child.unload(); }
	register(cleanup: () => void): void { this.cleanups.push(cleanup); }
	registerDomEvent(el: EventTarget, type: string, callback: EventListener): void {
		el.addEventListener(type, callback); this.register(() => el.removeEventListener(type, callback));
	}
	unload(): void { for (const child of this.children) child.unload(); this.children = []; for (const cleanup of this.cleanups) cleanup(); this.cleanups = []; }
}
export class ItemView extends Component {
	app: any;
	contentEl = document.createElement("div");
	constructor(public leaf: any) { super(); this.app = leaf.app; }
	async setState(): Promise<void> {}
}
export class Menu {}
export const MarkdownRenderer = { async render(_app: unknown, text: string, target: HTMLElement): Promise<void> { target.textContent = text; } };
export class PluginSettingTab {
	containerEl = {} as HTMLElement;
	constructor(..._args: unknown[]) {}
}
export class Setting {}
export function setIcon(): void {}
export async function requestUrl(options: { url: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<any> {
	const response = await fetch(options.url, {
		method: options.method,
		headers: options.headers,
		body: options.body,
		redirect: "error",
	});
	const text = await response.text();
	let json: unknown = null;
	try { json = JSON.parse(text); } catch {}
	return { status: response.status, text, json };
}
