// ── Adamas Agent 核心循环 ──
//
// 思考-行动-观察 循环（ReAct 模式）
//
// 1. LLM 思考 → 决定调哪个工具
// 2. 执行工具 → 获取结果
// 3. 观察结果 → 喂回 LLM
// 4. 重复直至 LLM 给出最终答案

import type { Message, ToolCall, ToolDefinition, ToolContext, ToolResult, AdamasConfig, AgentState } from "./types";
import type { SkillManager, MemoryStore } from "./index";
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
  private tools: Map<string, ToolDefinition> = new Map();
  private messages: Message[] = [];
  private state: AgentState = { phase: "idle" };
  private config: AdamasConfig;
  private iteration: number = 0;
  private skillManager?: SkillManager;
  private memoryStore?: MemoryStore;
  private baseSoul: string = "";
  private debugMode: boolean = false;

  constructor(config: AdamasConfig) {
    this.config = config;
    this.llm = new AdamasLLM(config.model);
  }

  /** 设置 Skill Manager */
  setSkillManager(sm: SkillManager): this {
    this.skillManager = sm;
    return this;
  }

  /** 设置 Memory Store */
  setMemoryStore(ms: MemoryStore): this {
    this.memoryStore = ms;
    return this;
  }

  /** 切换 debug 模式 */
  setDebug(enabled: boolean): this {
    this.debugMode = enabled;
    return this;
  }

  get debug(): boolean { return this.debugMode; }

  /** 注册工具 */
  register(tool: ToolDefinition): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  /** 检查工具是否存在 */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /** 获取所有工具名 */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /** 设置系统提示词（SOUL.md） */
  setSystemPrompt(prompt: string): void {
    this.baseSoul = prompt;
    this.rebuildSystemPrompt();
  }

  /** 重建系统提示，注入 skill 和 memory 上下文 */
  private rebuildSystemPrompt() {
    let fullPrompt = this.baseSoul;

    // 注入记忆
    if (this.memoryStore) {
      const memCtx = this.memoryStore.getContextPrompt();
      if (memCtx) fullPrompt += `\n\n${memCtx}`;
    }

    // 注入已加载的 skills
    if (this.skillManager) {
      const skillCtx = this.skillManager.getContextPrompt();
      if (skillCtx) fullPrompt += `\n\n${skillCtx}`;
    }

    // 注入工具列表
    const toolNames = this.getToolNames();
    if (toolNames.length > 0) {
      fullPrompt += `\n\n## Available Tools\n${toolNames.map(t => `- ${t}`).join("\n")}`;
    }

    if (this.messages.length > 0 && this.messages[0].role === "system") {
      this.messages[0] = { role: "system", content: fullPrompt };
    } else {
      this.messages.unshift({ role: "system", content: fullPrompt });
    }
  }

  /** 刷新上下文（skill/memory 变更后调用） */
  refreshContext(): void {
    this.rebuildSystemPrompt();
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

  /** 清空对话历史（保留 system prompt） */
  clearHistory(): void {
    const sysMsg = this.messages.find(m => m.role === "system");
    this.messages = sysMsg ? [sysMsg] : [];
  }

  /** 获取消息数量 */
  getMessageCount(): number {
    return this.messages.length;
  }
}
