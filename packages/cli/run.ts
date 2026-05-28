// ── Oneshot mode ──
import { AdamasAgent } from "@adamas/core";
import { ToolRegistry } from "@adamas/tools";
import { loadConfig, loadSoul } from "./config";

export async function runOneshot(prompt: string, opts: any) {
  const config = await loadConfig(opts);
  const tools = await ToolRegistry.createDefault();

  const agent = new AdamasAgent(config);
  for (const tool of tools.getAll()) {
    agent.register(tool);
  }

  agent.setSystemPrompt(await loadSoul());
  const result = await agent.chat(prompt);
  console.log(result);
}
