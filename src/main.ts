import { Menu, Notice, Plugin, TFile } from "obsidian";
import { configureBundledPdfWorker } from "./pdfview/worker";
import {
	PaperReaderView,
	VIEW_TYPE_PAPER_READER,
} from "./pdfview/PaperReaderView";
import {
	DEFAULT_SETTINGS,
	PaperReaderSettingTab,
	PaperReaderSettings,
} from "./settings";

export default class PaperReaderPlugin extends Plugin {
	settings: PaperReaderSettings = { ...DEFAULT_SETTINGS };

	async onload(): Promise<void> {
		await this.loadSettings();

		this.register(configureBundledPdfWorker());

		this.registerView(
			VIEW_TYPE_PAPER_READER,
			(leaf) => new PaperReaderView(leaf, this)
		);

		// Take over the .pdf extension so double-clicking any PDF in the
		// vault opens our view directly (like Zotero's reader).
		if (this.settings.useAsDefaultPdfViewer) {
			this.takeoverPdfExtension();
			// Tabs already open with the core viewer keep their old view
			// instance; convert them once the layout is ready.
			this.app.workspace.onLayoutReady(() => this.convertOpenPdfLeaves());
		}

		this.addRibbonIcon("file-text", "Open paper reader", () => {
			void this.openActivePdf();
		});

		this.addCommand({
			id: "open-active-pdf",
			name: "Open active PDF",
			callback: () => void this.openActivePdf(),
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file) => {
				if (file instanceof TFile && file.extension === "pdf") {
					menu.addItem((item) =>
						item
							.setTitle("Open in Paper Reader")
							.setIcon("file-text")
							.onClick(() => void this.openPdf(file))
					);
				}
			})
		);

		// backlinks from exported notes: obsidian://paper-reader?file=<path>&page=N
		// (Obsidian only routes obsidian:// URIs here; action = plugin id)
		this.registerObsidianProtocolHandler("paper-reader", (params) => {
			this.handleProtocolOpen(params);
		});

		// keep reading positions attached across rename/move
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) {
					void this.migrateReadingPosition(oldPath, file.path);
				}
			})
		);

		this.addSettingTab(new PaperReaderSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PaperReaderSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...data,
			highlightColors: {
				...DEFAULT_SETTINGS.highlightColors,
				...(data?.highlightColors ?? {}),
			},
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * registerExtensions(["pdf"], ...) throws
	 * "Attempting to register an existing file extension" because the core
	 * PDF viewer already owns "pdf". Workaround (same as PDF++): remove the
	 * core mapping first, register ours, and restore the core mapping on
	 * unload. Note Component.unload runs register() callbacks LIFO, so the
	 * restore is registered BEFORE registerExtensions to run after its
	 * cleanup.
	 */
	private takeoverPdfExtension(): void {
		try {
			const registry = (
				this.app as unknown as {
					viewRegistry: { typeByExtension: Record<string, string> };
				}
			).viewRegistry;
			const coreType = registry.typeByExtension["pdf"];
			if (coreType) {
				this.register(() => {
					registry.typeByExtension["pdf"] = coreType;
				});
				delete registry.typeByExtension["pdf"];
			}
			this.registerExtensions(["pdf"], VIEW_TYPE_PAPER_READER);
		} catch (e) {
			console.error("[paper-reader] failed to take over .pdf extension", e);
			new Notice("Paper Reader: 接管 PDF 默认打开失败（不影响其他功能）");
		}
	}

	/** Handle obsidian://paper-reader?file=<vault path>&page=N (notes backlinks). */
	handleProtocolOpen(params: Record<string, string>): void {
		const path = params.file ?? "";
		const page = parseInt(params.page ?? "1", 10);
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
		if (!(file instanceof TFile) || file.extension !== "pdf") {
			new Notice(`Paper Reader: 找不到来源文件 (${path || "未知"})`);
			return;
		}
		void this.openPdf(file, Number.isFinite(page) ? page : 1);
	}

	/** Move the reading-position record when a file is renamed/moved. */
	async migrateReadingPosition(oldPath: string, newPath: string): Promise<void> {
		const positions = this.settings.readingPositions;
		const saved = positions[oldPath];
		if (!saved) return;
		delete positions[oldPath];
		positions[newPath] = saved;
		await this.saveSettings();
	}

	private openActivePdf(): void {
		const file = this.app.workspace.getActiveFile();
		if (file && file.extension === "pdf") {
			void this.openPdf(file);
		} else {
			new Notice("Paper Reader: 请先打开一个 PDF 文件");
		}
	}

	private async openPdf(file: TFile, page?: number): Promise<void> {
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_PAPER_READER,
			state: { file: file.path, ...(page ? { page } : {}) },
		});
		await this.app.workspace.revealLeaf(leaf);
	}

	/** Re-point tabs currently using the core PDF viewer at our view. */
	private convertOpenPdfLeaves(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view.getViewType() !== "pdf") return;
			const file = (leaf.view as { file?: TFile | null }).file;
			if (!(file instanceof TFile) || file.extension !== "pdf") return;
			void leaf.setViewState({
				type: VIEW_TYPE_PAPER_READER,
				state: { file: file.path },
			});
		});
	}
}
