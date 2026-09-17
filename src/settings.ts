import { App, Notice, PluginSettingTab } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
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

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ type: "group", heading: "高亮颜色", items: COLOR_KEYS.map((key) => ({
				name: COLOR_LABELS[key],
				desc: "点击色块自定义颜色值",
				control: { type: "color", key: `color.${key}` },
			})) },
			{ type: "group", heading: "标注存储", items: [
				{ name: "标注文件后缀", desc: "例如 paper.pdf -> paper.annotations.json", control: { type: "text", key: "annotationSuffix", placeholder: ".annotations.json" } },
				{ name: "标注笔记后缀", desc: "例如 paper.pdf -> paper.notes.md", control: { type: "text", key: "notesSuffix", placeholder: ".notes.md" } },
			] },
			{ type: "group", heading: "交互", items: [
				{ name: "默认 PDF 阅读器", desc: "接管 .pdf 文件（更改后需重载插件）", control: { type: "toggle", key: "useAsDefaultPdfViewer" } },
				{ name: "Selection popup", desc: "选中文字后弹出选区弹窗", control: { type: "toggle", key: "showFloatingToolbar" } },
			] },
			{ type: "group", heading: "LLM", items: [
				{ name: "Base URL", desc: "OpenAI 兼容接口地址", control: { type: "text", key: "llmBaseUrl", placeholder: "https://api.deepseek.com/v1" } },
				{ name: "API Key", desc: "密钥明文保存在插件 data.json 中，请勿公开上传", render: (setting) => setting.addText((text) => {
					text.inputEl.type = "password";
					text.setPlaceholder("sk-...").setValue(this.plugin.settings.llmApiKey).onChange(async (value) => {
						this.plugin.settings.llmApiKey = value.trim();
						await this.plugin.saveSettings();
					});
				}) },
				{ name: "模型名", desc: "如 deepseek-chat / gpt-4o-mini", control: { type: "text", key: "llmModel", placeholder: "deepseek-chat" } },
				{ name: "测试连接", desc: "发送一个最小请求验证上述配置", render: (setting) => {
					const resultEl = setting.controlEl.createSpan({ cls: "pr-test-result" });
					setting.addButton((button) => button.setButtonText("测试").onClick(async () => {
						button.setButtonText("测试中…").setDisabled(true);
						resultEl.setText("");
						const client = new LlmClient(this.app, () => ({
							baseUrl: this.plugin.settings.llmBaseUrl,
							apiKey: this.plugin.settings.llmApiKey,
							model: this.plugin.settings.llmModel,
						}));
						const result = await client.testConnection();
						button.setButtonText("测试").setDisabled(false);
						resultEl.setText(result.ok ? "✅ 连接成功" : `❌ ${result.error ?? "未知错误"}`);
						resultEl.toggleClass("pr-test-error", !result.ok);
						if (!result.ok) new Notice(`连接失败：${result.error ?? "未知错误"}`);
					}));
				} },
				{ name: "翻译目标语言", control: { type: "text", key: "translateTargetLang", placeholder: "中文" } },
				{ name: "AI 上下文级别", desc: "AI 解释/问答时携带的上下文范围", control: { type: "dropdown", key: "aiContextLevel", options: {
					selection: "仅选中文本", page: "选中文本 + 当前页全文", full: "选中文本 + 全文（超限截断）",
				} } },
			] },
		];
	}

	getControlValue(key: string): unknown {
		if (key.startsWith("color.")) {
			return this.plugin.settings.highlightColors[key.slice(6) as HighlightColorKey];
		}
		return this.plugin.settings[key as keyof PaperReaderSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key.startsWith("color.") && typeof value === "string") {
			this.plugin.settings.highlightColors[key.slice(6) as HighlightColorKey] = value;
		} else if (key === "annotationSuffix" && typeof value === "string") {
			this.plugin.settings.annotationSuffix = value.trim() || DEFAULT_SETTINGS.annotationSuffix;
		} else if (key === "notesSuffix" && typeof value === "string") {
			this.plugin.settings.notesSuffix = value.trim() || DEFAULT_SETTINGS.notesSuffix;
		} else if (key === "translateTargetLang" && typeof value === "string") {
			this.plugin.settings.translateTargetLang = value.trim() || DEFAULT_SETTINGS.translateTargetLang;
		} else if ((key === "llmBaseUrl" || key === "llmModel") && typeof value === "string") {
			this.plugin.settings[key] = value.trim();
		} else if ((key === "useAsDefaultPdfViewer" || key === "showFloatingToolbar") && typeof value === "boolean") {
			this.plugin.settings[key] = value;
		} else if (key === "aiContextLevel" && (value === "selection" || value === "page" || value === "full")) {
			this.plugin.settings.aiContextLevel = value;
		} else {
			return;
		}
		await this.plugin.saveSettings();
	}
}
