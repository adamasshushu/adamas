// ── Adamas Agent 类型系统 ──

import { z } from "zod";

// ── 消息 ──
export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

// ── 工具调用 ──
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// ── 工具定义 ──
export interface ToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  toolset: string;          // e.g. "terminal", "browser", "file"
  schema: z.ZodSchema<TArgs>;
  execute: (args: TArgs, ctx: ToolContext) => Promise<string>;
}

// ── 执行上下文 ──
export interface ToolContext {
  sessionId: string;
  workingDir: string;
  platform: "cli" | "wechat" | "telegram" | "discord";
}

// ── Agent 状态机 ──
export type AgentState =
  | { phase: "idle" }
  | { phase: "thinking"; thought: string }
  | { phase: "acting"; tool: string; args: unknown }
  | { phase: "observing"; result: string }
  | { phase: "done"; summary: string };

// ── Agent 配置 ──
export interface AdamasConfig {
  model: ModelConfig;
  terminal: { rtkEnabled: boolean; timeout: number };
  browser: { backend: "camoufox"; url: string };
  agents: { maxIterations: number; maxToolCallsPerTurn: number };
}

export interface ModelConfig {
  provider: "openai" | "anthropic" | "deepseek";
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
}

// ── 工具结果 ──
export interface ToolResult {
  toolCallId: string;
  name: string;
  output: string;
  error?: string;
}
