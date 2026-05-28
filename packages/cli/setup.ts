// ── Setup wizard ──
import * as fs from "fs";
import * as path from "path";

export async function runSetup() {
  const home = process.env.HOME || "/tmp";
  const dir = `${home}/.adamas`;

  console.log(`\n⚙  Adamas Setup\n`);
  console.log(`Creating ${dir}/ ...`);

  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(`${dir}/config.yaml`)) {
    fs.writeFileSync(`${dir}/config.yaml`, defaultConfig());
    console.log("  ✅ config.yaml created");
  } else {
    console.log("  ⏭  config.yaml exists");
  }

  if (!fs.existsSync(`${dir}/SOUL.md`)) {
    fs.writeFileSync(`${dir}/SOUL.md`, defaultSoul());
    console.log("  ✅ SOUL.md created");
  } else {
    console.log("  ⏭  SOUL.md exists");
  }

  // Shell alias
  const bashrc = `${home}/.bashrc`;
  const aliasLine = `alias adamas="cd ${home}/adamas && npx tsx packages/cli/index.ts"`;
  if (fs.existsSync(bashrc)) {
    const content = fs.readFileSync(bashrc, "utf-8");
    if (!content.includes("alias adamas=")) {
      fs.appendFileSync(bashrc, `\n${aliasLine}\n`);
      console.log("  ✅ shell alias added (~/.bashrc)");
    }
  }

  console.log(`\n✅ Setup complete!`);
  console.log(`   Config: ${dir}/config.yaml`);
  console.log(`   Soul:   ${dir}/SOUL.md`);
  console.log(`\n   Run \`source ~/.bashrc\` then \`adamas chat\` to start.\n`);
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
