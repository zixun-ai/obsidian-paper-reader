import { requestUrl } from "obsidian";

export interface LlmConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export class LlmError extends Error {
	constructor(
		readonly code: "config" | "http" | "network" | "timeout" | "parse",
		message: string
	) {
		super(message);
		this.name = "LlmError";
	}
}

const REQUEST_TIMEOUT_MS = 120_000;

function chatCompletionsUrl(baseUrl: string): string {
	let url: URL;
	try { url = new URL(baseUrl); } catch {
		throw new LlmError("config", "接口地址无效，请填写完整的 HTTPS URL");
	}
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
		url.username || url.password || url.search || url.hash) {
		throw new LlmError("config", "远程接口必须使用 HTTPS；仅本机地址允许 HTTP。地址不能包含账号、密码、查询参数或片段。");
	}
	url.pathname = url.pathname.replace(/\/+$/, "") + "/chat/completions";
	return url.href;
}

async function httpError(status: number, body: string): Promise<LlmError> {
	if (status === 401 || status === 403) {
		return new LlmError("http", `API Key 无效或已过期（HTTP ${status}）`);
	}
	if (status === 404) {
		return new LlmError("http", "接口地址不存在（HTTP 404），请检查 Base URL 是否以 /v1 结尾");
	}
	if (status === 429) {
		return new LlmError("http", "请求被限流（HTTP 429），请稍后重试");
	}
	const detail = body.slice(0, 200);
	return new LlmError("http", `请求失败（HTTP ${status}）${detail ? `: ${detail}` : ""}`);
}

/**
 * OpenAI-compatible chat completions client.
 * Primary path: fetch with SSE streaming. Fallback (CORS etc.):
 * Obsidian requestUrl with a non-streaming request, delivered as one chunk.
 */
export class LlmClient {
	private approvedEndpoint = "";
	constructor(private getConfig: () => LlmConfig) {}

	private confirmSending(config: LlmConfig): void {
		const endpoint = chatCompletionsUrl(config.baseUrl);
		if (this.approvedEndpoint === endpoint) return;
		if (!window.confirm(
			`允许向以下 AI 接口发送数据吗？\n${endpoint}\n\n` +
			"AI 操作会发送选中文字、所选上下文（可能含页面或更多论文内容）、问题和对话历史，以及 API Key。连接测试仅发送测试文字和密钥。\n" +
			"数据直接交给该接口服务商，不经过 Paper Reader 开发者服务器；服务商的数据政策和费用适用。请勿发送无权分享的敏感内容。\n\n" +
			"密钥明文保存在插件 data.json，同步或分享配置可能带出密钥。允许后，本阅读窗口内同一接口不再提示。"
		)) throw new LlmError("config", "已取消 AI 数据发送");
		this.approvedEndpoint = endpoint;
	}

	private ensureConfig(): LlmConfig {
		const c = this.getConfig();
		if (!c.baseUrl.trim() || !c.apiKey.trim() || !c.model.trim()) {
			throw new LlmError(
				"config",
				"请先在 设置 → Paper Reader 中填写 Base URL / API Key / 模型名"
			);
		}
		chatCompletionsUrl(c.baseUrl);
		return { ...c };
	}

	async *streamChat(messages: ChatMessage[]): AsyncGenerator<string> {
		const config = this.ensureConfig();
		this.confirmSending(config);
		let yielded = false;
		try {
			for await (const chunk of this.streamViaFetch(config, messages)) {
				yielded = true;
				yield chunk;
			}
			return;
		} catch (e) {
			// only fall back when nothing was streamed yet
			if (yielded || !(e instanceof TypeError)) throw e;
		}
		yield await this.viaRequestUrl(config, messages);
	}

	private async *streamViaFetch(
		config: LlmConfig,
		messages: ChatMessage[]
	): AsyncGenerator<string> {
		const ctrl = new AbortController();
		const timer = window.setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
		try {
			const resp = await fetch(chatCompletionsUrl(config.baseUrl), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.apiKey}`,
				},
				body: JSON.stringify({ model: config.model, messages, stream: true }),
				signal: ctrl.signal,
				redirect: "error",
			});
			if (!resp.ok) {
				throw await httpError(resp.status, await resp.text());
			}
			if (!resp.body) {
				throw new LlmError("network", "响应不可读（无响应体）");
			}
			const reader = resp.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith("data:")) continue;
					const data = trimmed.slice(5).trim();
					if (data === "[DONE]") return;
					try {
						const json = JSON.parse(data);
						const delta = json.choices?.[0]?.delta?.content;
						if (typeof delta === "string" && delta) yield delta;
					} catch {
						// skip malformed SSE chunks
					}
				}
			}
		} catch (e) {
			if (e instanceof LlmError) throw e;
			if (e instanceof DOMException && e.name === "AbortError") {
				throw new LlmError("timeout", "请求超时（120 秒），请检查网络或更换模型");
			}
			throw e; // TypeError (CORS / network) handled by caller fallback
		} finally {
			window.clearTimeout(timer);
		}
	}

	private async viaRequestUrl(
		config: LlmConfig,
		messages: ChatMessage[]
	): Promise<string> {
		const resp = await requestUrl({
			url: chatCompletionsUrl(config.baseUrl),
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify({ model: config.model, messages, stream: false }),
			throw: false,
		});
		if (resp.status < 200 || resp.status >= 300) {
			throw await httpError(resp.status, resp.text);
		}
		const content = resp.json?.choices?.[0]?.message?.content;
		if (typeof content !== "string") {
			throw new LlmError("parse", "响应格式无法解析");
		}
		return content;
	}

	/** Minimal non-streaming request to validate the configuration. */
	async testConnection(): Promise<{ ok: boolean; error?: string }> {
		let config: LlmConfig;
		try {
			config = this.ensureConfig();
			this.confirmSending(config);
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
		try {
			const resp = await requestUrl({
				url: chatCompletionsUrl(config.baseUrl),
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.apiKey}`,
				},
				body: JSON.stringify({
					model: config.model,
					messages: [{ role: "user", content: "hi" }],
					max_tokens: 1,
					stream: false,
				}),
				throw: false,
			});
			if (resp.status >= 200 && resp.status < 300) {
				return { ok: true };
			}
			const err = await httpError(resp.status, resp.text);
			return { ok: false, error: err.message };
		} catch (e) {
			return {
				ok: false,
				error: `网络错误：${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}
}
