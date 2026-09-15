// Shared vm loader: execute a TS file with import stubs (no live Obsidian).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

export const notices: string[] = [];

export const obsidianStub = {
	Notice: class {
		constructor(message: string) {
			notices.push(message);
		}
	},
	ItemView: class {},
	setIcon() {},
	MarkdownRenderer: { render: async () => {} },
};

export function loadTs(path: string, imports: Record<string, unknown> = {}): any {
	const ts = createRequire(process.cwd() + "/package.json")("typescript");
	const exports: Record<string, unknown> = {};
	const source = ts.transpileModule(readFileSync(path, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	}).outputText;
	runInNewContext(source, {
		exports,
		require: (name: string) => imports[name] ?? obsidianStub,
		document: { body: elementStub() },
		window: { innerWidth: 1000, innerHeight: 1000, setTimeout, clearTimeout },
		DOMRect: class {},
		crypto,
		structuredClone,
	});
	return exports;
}

export function elementStub(): any {
	return {
		style: {},
		value: "",
		createDiv: elementStub,
		createEl: elementStub,
		createSpan: elementStub,
		addEventListener() {},
		setAttr() {},
		addClass() {},
		removeClass() {},
		toggleClass() {},
		setText(text: string) {
			this.text = text;
		},
		empty() {},
		focus() {},
		appendChild() {},
		remove() {},
		getBoundingClientRect: () => ({ width: 200, height: 100 }),
	};
}
