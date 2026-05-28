// ── Setup wizard ──
export async function runSetup() {
  const home = process.env.HOME || "/tmp";
  const dir = `${home}/.adamas`;

  console.log(`\n⚙  Adamas Setup\n`);
  console.log(`Creating ${dir}/ ...`);

  // 创建目录
  await Bun.write(`${dir}/.gitkeep`, "");
  try { await Bun.write(`${dir}/config.yaml`, defaultConfig()); } catch { /* exists */ }
  try { await Bun.write(`${dir}/SOUL.md`, defaultSoul()); } catch { /* exists */ }

  console.log(`\n✅ Setup complete!`);
  console.log(`   Config: ${dir}/config.yaml`);
  console.log(`   Soul:   ${dir}/SOUL.md`);
  console.log(`\n   Run \`adamas chat\` to start.\n`);
}

function defaultConfig(): string {
  return `# Adamas Configuration
model:
  provider: deepseek
  model: deepseek-chat
  temperature: 0.7
  maxTokens: 8192

terminal:
  rtkEnabled: true
  timeout: 180

browser:
  backend: camoufox
  url: http://localhost:9377

agents:
  maxIterations: 30
  maxToolCallsPerTurn: 5
`;
}

function defaultSoul(): string {
  return `You are Adamas, a hybrid AI agent built with TypeScript and Rust.

You have access to:
- Terminal (shell commands with RTK output compression)
- Browser (Camoufox stealth browser, native integration)
- File system (read/write/search)

Be concise, helpful, and direct.
`;
}
