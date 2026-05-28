// ── Adamas LLM Client ──
// 原生 fetch 实现，零外部 AI SDK 依赖
// 兼容 OpenAI / Anthropic / DeepSeek API

import type { ModelConfig, ToolCall } from "./types";

export interface GenerateInput {
  messages: { role: string; content: string; toolCalls?: ToolCall[]; toolCallId?: string }[];
  tools?: { name: string; description: string; parameters: unknown }[];
}

export interface GenerateOutput {
  content: string;
  toolCalls?: ToolCall[];
}

export class AdamasLLM {
  private config: ModelConfig;

  constructor(config: ModelConfig) {
    this.config = config;
  }

  async generate(input: GenerateInput): Promise<GenerateOutput> {
    const { baseUrl, headers } = this.getEndpoint();

    const body: any = {
      model: this.config.model,
      messages: input.messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
    };

    if (input.tools?.length) {
      body.tools = input.tools.map(t => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }

    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`LLM error ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    const choice = data.choices?.[0];
    const msg = choice?.message;

    return {
      content: msg?.content || "",
      toolCalls: msg?.tool_calls?.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments),
      })),
    };
  }

  private getEndpoint(): { baseUrl: string; headers: Record<string, string> } {
    switch (this.config.provider) {
      case "anthropic":
        return {
          baseUrl: "https://api.anthropic.com",
          headers: {
            "x-api-key": this.config.apiKey,
            "anthropic-version": "2023-06-01",
          },
        };
      case "deepseek":
        return {
          baseUrl: "https://api.deepseek.com",
          headers: { Authorization: `Bearer ${this.config.apiKey}` },
        };
      case "openai":
      default:
        return {
          baseUrl: "https://api.openai.com",
          headers: { Authorization: `Bearer ${this.config.apiKey}` },
        };
    }
  }
}
