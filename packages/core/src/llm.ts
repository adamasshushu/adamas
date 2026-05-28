// ── Adamas LLM Client ──
//
// 对接 Vercel AI SDK，统一 20+ 模型提供商接口

import { generateText, type CoreMessage, type CoreTool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
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
    // Vercel AI SDK — 自动处理 tool calling
    const provider = this.createProvider();
    const model = provider(this.config.model);

    const messages: CoreMessage[] = input.messages.map(m => ({
      role: m.role as CoreMessage["role"],
      content: m.content,
      ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    }));

    const tools: Record<string, CoreTool> = {};
    if (input.tools) {
      for (const t of input.tools) {
        tools[t.name] = {
          description: t.description,
          parameters: t.parameters as any,
        };
      }
    }

    const result = await generateText({
      model,
      messages,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
    });

    return {
      content: result.text,
      toolCalls: result.toolCalls?.map(tc => ({
        id: tc.toolCallId,
        name: tc.toolName,
        args: tc.args as Record<string, unknown>,
      })),
    };
  }

  private createProvider() {
    switch (this.config.provider) {
      case "openai":
        return createOpenAI({ apiKey: this.config.apiKey });
      case "anthropic":
        return createAnthropic({ apiKey: this.config.apiKey });
      case "deepseek":
        // DeepSeek uses OpenAI-compatible API
        return createOpenAI({ apiKey: this.config.apiKey, baseURL: "https://api.deepseek.com" });
      default:
        return createOpenAI({ apiKey: this.config.apiKey });
    }
  }
}
