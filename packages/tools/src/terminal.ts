// ── Adamas Terminal — Rust 原生 addon 包装 ──
//
// 使用 Rust 编译的 Node addon（napi-rs），零序列化开销
// rtk 输出压缩自动集成

export class AdamasTerminal {
  private native: any;

  constructor() {
    try {
      // 尝试加载 Rust addon
      this.native = require("../../native/terminal/adamas-native.linux-x64-gnu.node");
    } catch {
      // 降级到 child_process
      console.warn("[adamas] Rust native addon not found, using child_process fallback");
    }
  }

  async exec(command: string, workdir?: string, timeout?: number): Promise<string> {
    // RTK 智能前缀
    const cmd = this.rtkWrap(command);

    if (this.native) {
      // Rust 原生路径 — 零开销
      return this.native.exec(cmd, workdir || process.cwd(), timeout || 180);
    }

    // 降级路径 — child_process
    const { execSync } = await import("child_process");
    try {
      const result = execSync(cmd, {
        cwd: workdir || process.cwd(),
        timeout: (timeout || 180) * 1000,
        maxBuffer: 50 * 1024 * 1024,
        encoding: "utf-8",
      });
      return result;
    } catch (err: any) {
      return `exit_code=${err.status}
${err.stdout || ""}
${err.stderr || ""}`;
    }
  }

  /** 智能 RTK 前缀 */
  private rtkWrap(cmd: string): string {
    if (cmd.startsWith("rtk ")) return cmd;
    const builtins = ["cd ", "export ", "alias ", "echo ", "pwd", "true", "false"];
    if (builtins.some(b => cmd.startsWith(b) || cmd === b.trim())) return cmd;
    try {
      execSync("which rtk", { stdio: "ignore" });
      return `rtk ${cmd}`;
    } catch {
      return cmd;
    }
  }
}

function execSync(cmd: string, opts: any): string {
  return require("child_process").execSync(cmd, opts);
}
