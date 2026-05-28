// ── Adamas Agent 核心循环 ──
//
// 思考-行动-观察 循环（ReAct 模式）
//
// 1. LLM 思考 → 决定调哪个工具
// 2. 执行工具 → 获取结果
// 3. 观察结果 → 喂回 LLM
// 4. 重复直至 LLM 给出最终答案

import type { Message, ToolCall, ToolDefinition, ToolContext, ToolResult, AdamasConfig, AgentState } from "./types";
import { AdamasLLM } from "./llm";

/** Zod schema → OpenAI JSON Schema (minimal converter) */
function zodToJsonSchema(schema: any): Record<string, unknown> {
  const typeName: string = schema._def?.typeName || "";
  switch (typeName) {
    case "ZodString":   return { type: "string" };
    case "ZodNumber":   return { type: "number" };
    case "ZodBoolean":  return { type: "boolean" };
    case "ZodOptional":  return zodToJsonSchema(schema._def.innerType);
    case "ZodArray":     return { type: "array", items: zodToJsonSchema(schema._def.type) };
    case "ZodObject": {
      const shape = schema._def.shape();
      const required: string[] = [];
      const properties: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(shape)) {
        const inner: any = val as any;
        if (inner._def?.typeName === "ZodOptional") {
          properties[key] = { ...zodToJsonSchema(inner._def.innerType), description: inner._def.description };
        } else {
          properties[key] = { ...zodToJsonSchema(inner), description: inner._def?.description };
          required.push(key);
        }
      }
      const result: Record<string, unknown> = { type: "object", properties };
      if (required.length) result.required = required;
      return result;
    }
    default: return { type: "null" };
  }
}

export class AdamasAgent {
  private llm: AdamasLLM;
  private tools: Map<string, ToolDefinition>;
  private messages: Message[] = [];
  private state: AgentState = { phase: "idle" };
  private config: AdamasConfig;
  private iteration: number = 0;

  constructor(config: AdamasConfig) {
    this.config = config;
    this.llm = new AdamasLLM(config.model);
    this.tools = new Map();
  }

  /** 注册工具 */
  register(tool: ToolDefinition): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  /** 设置系统提示词（SOUL.md） */
  setSystemPrompt(prompt: string): void {
    this.messages = [{ role: "system", content: prompt }];
  }

  /** 执行一轮对话 */
  async chat(userMessage: string): Promise<string> {
    this.messages.push({ role: "user", content: userMessage });
    this.iteration = 0;

    while (this.iteration < this.config.agents.maxIterations) {
      this.iteration++;

      // Phase: THINK
      this.state = { phase: "thinking", thought: "Calling LLM..." };
      const response = await this.llm.generate({
        messages: this.messages,
        tools: Array.from(this.tools.values()).map(t => ({
          name: t.name,
          description: t.description,
          parameters: zodToJsonSchema(t.schema),
        })),
      });

      // No tool calls → final answer
      if (!response.toolCalls || response.toolCalls.length === 0) {
        this.state = { phase: "done", summary: response.content };
        this.messages.push({ role: "assistant", content: response.content });
        return response.content;
      }

      // Phase: ACT
      const results: ToolResult[] = [];
      for (const tc of response.toolCalls.slice(0, this.config.agents.maxToolCallsPerTurn)) {
        this.state = { phase: "acting", tool: tc.name, args: tc.args };
        const tool = this.tools.get(tc.name);
        if (!tool) {
          results.push({ toolCallId: tc.id, name: tc.name, output: "", error: `Tool not found: ${tc.name}` });
          continue;
        }

        try {
          const ctx: ToolContext = {
            sessionId: "default",
            workingDir: process.cwd(),
            platform: "cli",
          };
          const output = await tool.execute(tc.args, ctx);
          results.push({ toolCallId: tc.id, name: tc.name, output });
        } catch (err) {
          results.push({ toolCallId: tc.id, name: tc.name, output: "", error: String(err) });
        }
      }

      // Phase: OBSERVE
      this.state = { phase: "observing", result: `${results.length} tool results` };
      this.messages.push({
        role: "assistant",
        content: response.content || "",
        toolCalls: response.toolCalls,
      });
      for (const r of results) {
        this.messages.push({
          role: "tool",
          content: r.error ? `ERROR: ${r.error}` : r.output,
          toolCallId: r.toolCallId,
        });
      }
    }

    return "Max iterations reached. Task may be incomplete.";
  }

  /** 获取当前状态 */
  getState(): AgentState {
    return this.state;
  }

  /** 获取对话历史 */
  getMessages(): Message[] {
    return [...this.messages];
  }
}
