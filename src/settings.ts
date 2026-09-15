import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PaperReaderPlugin from "./main";
import { LlmClient } from "./llm/client";

export const COLOR_KEYS = [
	"yellow",
	"red",
	"green",
	"blue",
	"purple",
	"pink",
	"orange",
] as const;
export type HighlightColorKey = (typeof COLOR_KEYS)[number];

export type AiContextLevel = "selection" | "page" | "full";

export interface ReadingPosition {
	page: number;
	/** fraction of the page's height below its top edge */
	pageFraction: number;
	zoomMode: string;
	scale: number;
	layoutMode: string;
	updatedAt: number;
}

export interface PaperReaderSettings {
	highlightColors: Record<HighlightColorKey, string>;
	annotationSuffix: string;
	notesSuffix: string;
	/** when true, selecting text also pops up the old floating toolbar */
	showFloatingToolbar: boolean;
	/** take over the .pdf extension so PDFs open in our view on click */
	useAsDefaultPdfViewer: boolean;
	/** invert page colors in dark theme (zoom menu checkbox persists here) */
	invertColorsInDark: boolean;
	llmBaseUrl: string;
	llmApiKey: string;
	llmModel: string;
	translateTargetLang: string;
	aiContextLevel: AiContextLevel;
	/** per-PDF last reading position, keyed by vault path */
	readingPositions: Record<string, ReadingPosition>;
}

export const DEFAULT_SETTINGS: PaperReaderSettings = {
	highlightColors: {
		yellow: "#F5C542",
		red: "#F26D6D",
		green: "#7BD88F",
		blue: "#5EB2F2",
		purple: "#B48CE8",
		pink: "#F28CC8",
		orange: "#F2994A",
	},
	annotationSuffix: ".annotations.json",
	notesSuffix: ".notes.md",
	showFloatingToolbar: true,
	useAsDefaultPdfViewer: false,
	invertColorsInDark: false,
	llmBaseUrl: "",
	llmApiKey: "",
	llmModel: "",
	translateTargetLang: "中文",
	aiContextLevel: "page",
	readingPositions: {},
};

const COLOR_LABELS: Record<HighlightColorKey, string> = {
	yellow: "黄色（重点）",
	red: "红色（疑问）",
	green: "绿色（方法）",
	blue: "蓝色（概念）",
	purple: "紫色",
	pink: "粉色",
	orange: "橙色",
};

export class PaperReaderSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: PaperReaderPlugin
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Paper Reader" });

		containerEl.createEl("h3", { text: "高亮颜色" });
		for (const key of COLOR_KEYS) {
			new Setting(containerEl)
				.setName(COLOR_LABELS[key])
				.setDesc("点击色块自定义颜色值")
				.addColorPicker((picker) =>
					picker
						.setValue(this.plugin.settings.highlightColors[key])
						.onChange(async (value) => {
							this.plugin.settings.highlightColors[key] = value;
							await this.plugin.saveSettings();
						})
				);
		}

		containerEl.createEl("h3", { text: "标注存储" });
		new Setting(containerEl)
			.setName("标注文件后缀")
			.setDesc("每篇 PDF 的标注保存在同名文件中，例如 paper.pdf -> paper.annotations.json")
			.addText((text) =>
				text
					.setPlaceholder(".annotations.json")
					.setValue(this.plugin.settings.annotationSuffix)
					.onChange(async (value) => {
						this.plugin.settings.annotationSuffix =
							value.trim() || DEFAULT_SETTINGS.annotationSuffix;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("标注笔记后缀")
			.setDesc("AI 翻译/解释/问答结果可插入的 Markdown 笔记，例如 paper.pdf -> paper.notes.md")
			.addText((text) =>
				text
					.setPlaceholder(".notes.md")
					.setValue(this.plugin.settings.notesSuffix)
					.onChange(async (value) => {
						this.plugin.settings.notesSuffix =
							value.trim() || DEFAULT_SETTINGS.notesSuffix;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "交互" });
		new Setting(containerEl)
			.setName("默认 PDF 阅读器")
			.setDesc("接管 .pdf 文件：点击库内任意 PDF 直接用 Paper Reader 打开（更改后需重载插件生效）")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useAsDefaultPdfViewer)
					.onChange(async (value) => {
						this.plugin.settings.useAsDefaultPdfViewer = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Selection popup")
			.setDesc("选中文字后弹出选区弹窗（色点/标注样式/复制/批注/翻译，默认开启）")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showFloatingToolbar)
					.onChange(async (value) => {
						this.plugin.settings.showFloatingToolbar = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "LLM" });
		new Setting(containerEl)
			.setName("Base URL")
			.setDesc(
				"OpenAI 兼容接口地址。预置：DeepSeek https://api.deepseek.com/v1 ，OpenAI https://api.openai.com/v1"
			)
			.addText((text) =>
				text
					.setPlaceholder("https://api.deepseek.com/v1")
					.setValue(this.plugin.settings.llmBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.llmBaseUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("API Key")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.llmApiKey)
					.onChange(async (value) => {
						this.plugin.settings.llmApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});
		new Setting(containerEl)
			.setName("模型名")
			.setDesc("如 deepseek-chat / gpt-4o-mini")
			.addText((text) =>
				text
					.setPlaceholder("deepseek-chat")
					.setValue(this.plugin.settings.llmModel)
					.onChange(async (value) => {
						this.plugin.settings.llmModel = value.trim();
						await this.plugin.saveSettings();
					})
			);
		const testSetting = new Setting(containerEl)
			.setName("测试连接")
			.setDesc("发送一个最小请求验证上述配置");
		const testResultEl = testSetting.controlEl.createSpan({
			cls: "pr-test-result",
		});
		testSetting.addButton((btn) =>
			btn.setButtonText("测试").onClick(async () => {
				btn.setButtonText("测试中…").setDisabled(true);
				testResultEl.setText("");
				const client = new LlmClient(() => ({
					baseUrl: this.plugin.settings.llmBaseUrl,
					apiKey: this.plugin.settings.llmApiKey,
					model: this.plugin.settings.llmModel,
				}));
				const result = await client.testConnection();
				btn.setButtonText("测试").setDisabled(false);
				if (result.ok) {
					testResultEl.setText("✅ 连接成功");
					testResultEl.removeClass("pr-test-error");
				} else {
					testResultEl.setText(`❌ ${result.error ?? "未知错误"}`);
					testResultEl.addClass("pr-test-error");
					new Notice(`连接失败：${result.error ?? "未知错误"}`);
				}
			})
		);
		new Setting(containerEl)
			.setName("翻译目标语言")
			.addText((text) =>
				text
					.setPlaceholder("中文")
					.setValue(this.plugin.settings.translateTargetLang)
					.onChange(async (value) => {
						this.plugin.settings.translateTargetLang =
							value.trim() || DEFAULT_SETTINGS.translateTargetLang;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("AI 上下文级别")
			.setDesc("AI 解释/问答时携带的上下文范围")
			.addDropdown((drop) =>
				drop
					.addOption("selection", "仅选中文本")
					.addOption("page", "选中文本 + 当前页全文")
					.addOption("full", "选中文本 + 全文（超限截断）")
					.setValue(this.plugin.settings.aiContextLevel)
					.onChange(async (value) => {
						this.plugin.settings.aiContextLevel = value as AiContextLevel;
						await this.plugin.saveSettings();
					})
			);
	}
}
