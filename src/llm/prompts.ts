import type { ChatMessage } from "./client";

/** System+user messages for academic translation. */
export function buildTranslateMessages(
	text: string,
	targetLang: string
): ChatMessage[] {
	return [
		{
			role: "system",
			content:
				`你是学术论文翻译助手。把用户给出的内容翻译成${targetLang}。` +
				"要求：专业术语准确；公式、变量与 LaTeX 代码保持原样不翻译；只输出译文，不要加任何解释或前后缀。",
		},
		{ role: "user", content: text },
	];
}

/** System+user messages for explaining a selection with context. */
export function buildExplainMessages(
	selection: string,
	context: string
): ChatMessage[] {
	return [
		{
			role: "system",
			content:
				"你是学术论文阅读助手。用中文简明解释用户选中的内容：术语含义、公式中各符号的意义、方法的关键思路。" +
				"结合提供的上下文作答，不要复述原文。回答使用 Markdown 排版。行内公式使用 $...$，独立公式使用 $$...$$。",
		},
		{
			role: "user",
			content: `【选中内容】\n${selection}\n\n【上下文】\n${context}`,
		},
	];
}

/** System message carrying the selection + context for free-form QA. */
export function buildAskSystem(selection: string, context: string): ChatMessage {
	return {
		role: "system",
		content:
			"你是学术论文问答助手。用户正在精读一篇论文并选中了部分内容，" +
			"请基于选中内容与上下文用中文回答用户的问题，回答使用 Markdown 排版。行内公式使用 $...$，独立公式使用 $$...$$。\n\n" +
			`【选中内容】\n${selection}\n\n【上下文】\n${context}`,
	};
}
