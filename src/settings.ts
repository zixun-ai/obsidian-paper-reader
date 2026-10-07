import { t } from "./i18n";
import { App, Notice, PluginSettingTab, SecretComponent } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type PaperReaderPlugin from "./main";
import { LlmClient, type LlmConfig } from "./llm/client";

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
	llmApiKeyId: string;
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
	llmApiKeyId: "",
	llmModel: "",
	translateTargetLang: "中文",
	aiContextLevel: "full",
	readingPositions: {},
};

export function llmConfig(app: App, settings: PaperReaderSettings): LlmConfig {
	return {
		baseUrl: settings.llmBaseUrl,
		apiKey: settings.llmApiKeyId ? app.secretStorage.getSecret(settings.llmApiKeyId) ?? "" : "",
		model: settings.llmModel,
	};
}

const COLOR_LABELS: Record<HighlightColorKey, string> = {
	yellow: t("黄色（重点）"),
	red: t("红色（疑问）"),
	green: t("绿色（方法）"),
	blue: t("蓝色（概念）"),
	purple: t("紫色"),
	pink: t("粉色"),
	orange: t("橙色"),
};

export class PaperReaderSettingTab extends PluginSettingTab {
	private testAbort: AbortController | null = null;

	hide(): void {
		this.testAbort?.abort();
		this.testAbort = null;
		super.hide();
	}
	constructor(
		app: App,
		private plugin: PaperReaderPlugin
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ type: "group", heading: t("高亮颜色"), items: COLOR_KEYS.map((key) => ({
				name: COLOR_LABELS[key],
				desc: t("点击色块自定义颜色值"),
				control: { type: "color", key: `color.${key}` },
			})) },
			{ type: "group", heading: t("标注存储"), items: [
				{ name: t("标注文件后缀"), desc: t("例如 paper.pdf -> paper.annotations.json"), control: { type: "text", key: "annotationSuffix", placeholder: ".annotations.json" } },
				{ name: t("标注笔记后缀"), desc: t("例如 paper.pdf -> paper.notes.md"), control: { type: "text", key: "notesSuffix", placeholder: ".notes.md" } },
			] },
			{ type: "group", heading: t("交互"), items: [
				{ name: t("默认 PDF 阅读器"), desc: t("接管 .pdf 文件（更改后需重载插件）"), control: { type: "toggle", key: "useAsDefaultPdfViewer" } },
				{ name: "Selection popup", desc: t("选中文字后弹出选区弹窗"), control: { type: "toggle", key: "showFloatingToolbar" } },
			] },
			{ type: "group", heading: "LLM", items: [
				{ name: "Base URL", desc: t("OpenAI 兼容接口地址"), control: { type: "text", key: "llmBaseUrl", placeholder: "https://api.deepseek.com/v1" } },
				{ name: "API Key", desc: t("在 Obsidian 的密钥存储中管理；插件仅保存密钥名称"), render: (setting) => {
					setting.addComponent((el) => new SecretComponent(this.app, el)
						.setValue(this.plugin.settings.llmApiKeyId)
						.onChange((id) => void this.setControlValue("llmApiKeyId", id ?? "")));
				} },
				{ name: t("模型名"), desc: t("如 deepseek-chat / gpt-4o-mini"), control: { type: "text", key: "llmModel", placeholder: "deepseek-chat" } },
				{ name: t("测试连接"), desc: t("发送一个最小请求验证上述配置"), render: (setting) => {
					const resultEl = setting.controlEl.createSpan({ cls: "pr-test-result" });
					setting.addButton((button) => button.setButtonText(t("测试")).onClick(async () => {
						button.setButtonText(t("测试中…")).setDisabled(true);
						resultEl.setText("");
						const client = new LlmClient(this.app, () => llmConfig(this.app, this.plugin.settings));
						this.testAbort?.abort();
						const abort = new AbortController(); this.testAbort = abort;
						const result = await client.testConnection(abort.signal);
						if (abort.signal.aborted) return;
						this.testAbort = null;
						button.setButtonText(t("测试")).setDisabled(false);
						resultEl.setText(result.ok ? t("✅ 连接成功") : `❌ ${result.error ?? t("未知错误")}`);
						resultEl.toggleClass("pr-test-error", !result.ok);
						if (!result.ok) new Notice(t("连接失败：{error}", { error: result.error ?? t("未知错误") }));
					}));
				} },
				{ name: t("翻译目标语言"), control: { type: "text", key: "translateTargetLang", placeholder: t("中文") } },
				{ name: t("AI 上下文级别"), desc: t("AI 解释/问答时携带的上下文范围"), control: { type: "dropdown", key: "aiContextLevel", options: {
					selection: t("仅选中文本"), page: t("选中文本 + 当前页全文"), full: t("选中文本 + 全文（超限截断）"),
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
		} else if ((key === "llmBaseUrl" || key === "llmModel" || key === "llmApiKeyId") && typeof value === "string") {
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
