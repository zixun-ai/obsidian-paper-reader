import { App, Component, MarkdownRenderer, Notice, setIcon } from "obsidian";
import { ChatMessage, LlmClient, LlmError } from "../llm/client";
import {
	buildAskSystem,
	buildExplainMessages,
	buildTranslateMessages,
} from "../llm/prompts";
import type { SelectionPayload } from "../pdfview/selection";

export type PanelMode = "translate" | "explain" | "ask";

const MODE_TITLES: Record<PanelMode, string> = {
	translate: "翻译",
	explain: "AI 解释",
	ask: "AI 问答",
};

export interface NotesInsertEntry {
	title: string;
	page: number;
	quote: string;
	content: string;
}

export interface AnswerPanelCallbacks {
	/** fired once per completed answer (used to record translation annotations) */
	onAnswered: (mode: PanelMode, payload: SelectionPayload, answer: string) => void;
	onInsertNotes: (entry: NotesInsertEntry) => Promise<void>;
}

/**
 * Right-side answer drawer: quote block, streaming markdown answers,
 * multi-turn follow-up input, and footer actions
 * (copy / insert into notes / regenerate / clear).
 */
export class AnswerPanel {
	readonly el: HTMLElement;
	private titleEl: HTMLElement;
	private bodyEl: HTMLElement;
	private inputEl: HTMLTextAreaElement;

	private mode: PanelMode = "translate";
	private payload: SelectionPayload | null = null;
	private contextText = "";
	private history: ChatMessage[] = [];
	private lastAnswer = "";
	private streaming = false;
	private generation = 0;

	constructor(
		private app: App,
		private component: Component,
		private llm: LlmClient,
		private getTargetLang: () => string,
		private getSourcePath: () => string,
		private callbacks: AnswerPanelCallbacks
	) {
		this.el = createDiv({ cls: "pr-panel pr-hidden" });

		const header = this.el.createDiv({ cls: "pr-panel-header" });
		this.titleEl = header.createSpan({ cls: "pr-panel-title" });
		const closeBtn = header.createEl("button", { cls: "clickable-icon" });
		setIcon(closeBtn, "x");
		closeBtn.setAttr("aria-label", "关闭面板");
		closeBtn.addEventListener("click", () => this.close());

		this.bodyEl = this.el.createDiv({ cls: "pr-panel-body" });

		const inputWrap = this.el.createDiv({ cls: "pr-panel-input" });
		this.inputEl = inputWrap.createEl("textarea", {
			cls: "pr-panel-textarea",
			attr: { placeholder: "追问 / 提问…（Enter 发送，Shift+Enter 换行）", rows: "2" },
		});
		const sendBtn = inputWrap.createEl("button", { cls: "clickable-icon" });
		setIcon(sendBtn, "send-horizontal");
		sendBtn.setAttr("aria-label", "发送");
		sendBtn.addEventListener("click", () => void this.sendFollowUp());
		this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.sendFollowUp();
			}
			e.stopPropagation();
		});

		const footer = this.el.createDiv({ cls: "pr-panel-footer" });
		const mkFooterBtn = (icon: string, tooltip: string, onClick: () => void) => {
			const btn = footer.createEl("button", { cls: "clickable-icon" });
			setIcon(btn, icon);
			btn.setAttr("aria-label", tooltip);
			btn.addEventListener("click", onClick);
		};
		mkFooterBtn("copy", "复制回答", () => void this.copyAnswer());
		mkFooterBtn("file-plus-2", "插入标注笔记", () => void this.insertNotes());
		mkFooterBtn("refresh-ccw", "重新生成", () => this.regenerate());
		mkFooterBtn("trash-2", "清空对话", () => this.clearConversation());
	}

	get isOpen(): boolean {
		return !this.el.hasClass("pr-hidden");
	}

	openTranslate(payload: SelectionPayload, contextText: string): void {
		this.start("translate", payload, contextText);
		void this.run(buildTranslateMessages(payload.text, this.getTargetLang()));
	}

	openExplain(payload: SelectionPayload, contextText: string): void {
		this.start("explain", payload, contextText);
		void this.run(buildExplainMessages(payload.text, contextText));
	}

	openAsk(payload: SelectionPayload, contextText: string): void {
		this.start("ask", payload, contextText);
		this.history = [buildAskSystem(payload.text, contextText)];
		this.inputEl.focus();
	}

	close(): void {
		this.generation++;
		this.streaming = false;
		this.el.addClass("pr-hidden");
		this.history = [];
		this.lastAnswer = "";
	}

	private start(mode: PanelMode, payload: SelectionPayload, contextText: string): void {
		this.generation++;
		this.streaming = false;
		this.mode = mode;
		this.payload = payload;
		this.contextText = contextText;
		this.history = [];
		this.lastAnswer = "";
		this.titleEl.setText(MODE_TITLES[mode]);
		this.bodyEl.empty();
		const quote = this.bodyEl.createDiv({ cls: "pr-panel-quote" });
		quote.createSpan({ cls: "pr-panel-quote-page", text: `p.${payload.page}` });
		quote.createDiv({ cls: "pr-panel-quote-text", text: payload.text });
		this.el.removeClass("pr-hidden");
	}

	// ---- conversation ----

	private async sendFollowUp(): Promise<void> {
		const question = this.inputEl.value.trim();
		if (!question || this.streaming || !this.payload) return;
		if (this.history.length === 0) {
			// no initial request yet (ask mode): start with system + question
			this.history = [buildAskSystem(this.payload.text, this.contextText)];
		}
		this.inputEl.value = "";
		const bubble = this.bodyEl.createDiv({ cls: "pr-msg pr-msg-user" });
		bubble.setText(question);
		this.scrollToBottom();
		const messages = [...this.history, { role: "user", content: question } as ChatMessage];
		await this.run(messages);
	}

	private async run(messages: ChatMessage[]): Promise<void> {
		if (this.streaming) return;
		this.streaming = true;
		const generation = this.generation;
		const payload = this.payload;
		const mode = this.mode;
		this.history = messages;
		const live = this.bodyEl.createDiv({ cls: "pr-msg pr-msg-assistant pr-streaming" });
		let answer = "";
		let renderedAnswer = "";
		let lastRenderAt = 0;
		let renderedComponent: Component | null = null;
		const sourcePath = this.getSourcePath();
		const render = async () => {
			const snapshot = answer;
			const target = createDiv();
			const renderComponent = this.component.addChild(new Component());
			try {
				await MarkdownRenderer.render(this.app, snapshot, target, sourcePath, renderComponent);
			} catch { target.setText(snapshot); }
			if (generation !== this.generation) {
				this.component.removeChild(renderComponent);
				return;
			}
			if (renderedComponent) this.component.removeChild(renderedComponent);
			renderedComponent = renderComponent;
			live.replaceChildren(target);
			renderedAnswer = snapshot;
			lastRenderAt = Date.now();
			this.scrollToBottom();
		};
		try {
			for await (const chunk of this.llm.streamChat(messages)) {
				if (generation !== this.generation) return;
				answer += chunk;
				if (!renderedAnswer || Date.now() - lastRenderAt >= 100) await render();
			}
		} catch (e) {
			if (generation !== this.generation) return;
			const msg =
				e instanceof LlmError ? e.message : `请求出错：${(e as Error).message}`;
			live.setText(msg);
			live.addClass("pr-msg-error");
			new Notice(msg);
			this.streaming = false;
			return;
		}
		if (generation !== this.generation) return;
		if (renderedAnswer !== answer) await render();
		if (generation !== this.generation) return;
		this.streaming = false;
		this.history = [...messages, { role: "assistant", content: answer }];
		this.lastAnswer = answer;
		live.removeClass("pr-streaming");

		if (generation === this.generation && payload) {
			this.callbacks.onAnswered(mode, payload, answer);
		}
	}

	private regenerate(): void {
		if (this.streaming || this.history.length === 0) return;
		let messages = this.history;
		if (messages[messages.length - 1].role === "assistant") {
			messages = messages.slice(0, -1);
			const bubbles = this.bodyEl.querySelectorAll(".pr-msg-assistant");
			bubbles[bubbles.length - 1]?.remove();
		}
		void this.run(messages);
	}

	private clearConversation(): void {
		if (this.streaming) return;
		this.bodyEl.querySelectorAll(".pr-msg").forEach((el) => el.remove());
		if (this.mode === "ask") {
			this.history = this.payload
				? [buildAskSystem(this.payload.text, this.contextText)]
				: [];
		} else {
			this.history = [];
		}
		this.lastAnswer = "";
	}

	private async copyAnswer(): Promise<void> {
		if (!this.lastAnswer) {
			new Notice("暂无回答可复制");
			return;
		}
		await navigator.clipboard.writeText(this.lastAnswer);
		new Notice("已复制回答");
	}

	private async insertNotes(): Promise<void> {
		if (!this.payload || !this.lastAnswer) {
			new Notice("暂无回答可插入");
			return;
		}
		await this.callbacks.onInsertNotes({
			title: MODE_TITLES[this.mode],
			page: this.payload.page,
			quote: this.payload.text,
			content: this.lastAnswer,
		});
	}

	private scrollToBottom(): void {
		this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
	}
}
