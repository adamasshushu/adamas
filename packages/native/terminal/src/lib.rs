// ── Adamas Native — Rust 性能核心 ──
//
// 编译为 Node.js addon，通过 napi-rs 暴露给 TypeScript
// 功能：终端执行 + 文件操作 + rtk 集成

use napi_derive::napi;
use tokio::process::Command;
use std::time::Duration;

#[napi(object)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub truncated: bool,
}

/// 执行 shell 命令（RTK 智能前缀在 TS 层处理）
#[napi]
pub async fn exec(
    command: String,
    workdir: Option<String>,
    timeout_secs: Option<u32>,
) -> napi::Result<ExecResult> {
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(180) as u64);
    let cwd = workdir.unwrap_or_else(|| ".".to_string());

    let mut child = Command::new("sh")
        .arg("-c")
        .arg("--")
        .arg(&command)
        .current_dir(&cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| napi::Error::from_reason(format!("spawn: {}", e)))?;

    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| napi::Error::from_reason("timeout"))?
        .map_err(|e| napi::Error::from_reason(format!("wait: {}", e)))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let max = 50000;
    let (stdout, truncated) = if stdout.len() > max {
        (format!("{}\n... [truncated, {} bytes]", &stdout[..max], stdout.len()), true)
    } else {
        (stdout, false)
    };

    Ok(ExecResult {
        stdout,
        stderr,
        exit_code: output.status.code().unwrap_or(-1),
        truncated,
    })
}

/// 读文件（带行号）
#[napi]
pub fn read_file(path: String, offset: Option<u32>, limit: Option<u32>) -> napi::Result<String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| napi::Error::from_reason(format!("read: {}", e)))?;

    let lines: Vec<&str> = content.lines().collect();
    let start = offset.unwrap_or(1).max(1) as usize - 1;
    let end = (start + limit.unwrap_or(500) as usize).min(lines.len());

    if start >= lines.len() {
        return Ok("(file empty or offset beyond end)".into());
    }

    let output: String = lines[start..end]
        .iter()
        .enumerate()
        .map(|(i, line)| format!("{:>5}|{}", start + i + 1, line))
        .collect::<Vec<_>>()
        .join("\n");

    Ok(format!("{output}\n(total_lines: {})", lines.len()))
}

/// 写文件
#[napi]
pub fn write_file(path: String, content: String) -> napi::Result<String> {
    std::fs::write(&path, &content)
        .map_err(|e| napi::Error::from_reason(format!("write: {}", e)))?;
    Ok(format!("Written {} bytes to {}", content.len(), path))
}

// ── 内存管理 ──
// Bun 的 JSC 垃圾回收器 + Rust RAII → 无内存泄漏
// napi-rs 在 Rust 侧使用 Box::leak 转为静态生命周期时
// 自动注册 GC finalizer，JS 侧 GC 时回收 Rust 内存
