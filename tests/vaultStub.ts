import { TFile } from "obsidian";

/** Only the Vault file APIs used by storage; process models the host's atomic callback. */
export function vaultFor(adapter: {
	files: Map<string, string>;
	read(path: string): Promise<string>;
	write(path: string, text: string): Promise<void>;
}) {
	const file = (path: string) => Object.assign(new TFile(), { path });
	const pending = new Map<string, Promise<unknown>>();
	return {
		adapter,
		getAbstractFileByPath: (path: string) => adapter.files.has(path) ? file(path) : null,
		async create(path: string, text: string) {
			if (adapter.files.has(path)) throw new Error("already exists");
			await adapter.write(path, text);
			return file(path);
		},
		process(target: TFile, update: (text: string) => string) {
			const task = (pending.get(target.path) ?? Promise.resolve()).then(async () => {
				const before = await adapter.read(target.path);
				const after = update(before);
				if (after !== before) await adapter.write(target.path, after);
				return after;
			});
			pending.set(target.path, task.catch(() => {}));
			return task;
		},
	};
}
