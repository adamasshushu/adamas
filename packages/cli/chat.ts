// ── Chat mode ──
import { AdamasAgent } from "@adamas/core";
import { ToolRegistry } from "@adamas/tools";
import { loadConfig, loadSoul } from "./config";

export async function startChat(opts: any) {
  const config = await loadConfig(opts);
  const tools = await ToolRegistry.createDefault();

  const agent = new AdamasAgent(config);
  for (const tool of tools.getAll()) {
    agent.register(tool);
  }

  const soul = await loadSoul();
  agent.setSystemPrompt(soul);

  // 交互式循环
  const prompt = "adamas> ";
  process.stdout.write(prompt);

  for await (const line of console) {
    const input = line.trim();
    if (!input) { process.stdout.write(prompt); continue; }
    if (input === "/exit" || input === "/quit") break;
    if (input === "/help") {
      console.log("Commands: /exit, /help, /state");
      process.stdout.write(prompt);
      continue;
    }
    if (input === "/state") {
      console.log(agent.getState());
      process.stdout.write(prompt);
      continue;
    }

    const response = await agent.chat(input);
    console.log(`\n${response}\n`);
    process.stdout.write(prompt);
  }

  console.log("Goodbye!");
}
