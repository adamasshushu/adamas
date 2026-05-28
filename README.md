# Adamas

**Hybrid AI Agent — TypeScript + Rust**

```
adamas chat          # 交互式对话
adamas run "prompt"  # 单次执行
adamas serve         # 启动网关
adamas setup         # 初始化
```

## 架构

```
TypeScript (Agent 层)          Rust (性能层)
├── Agent 核心循环              ├── 终端执行 (napi-rs)
├── LLM 调用 (Vercel AI SDK)    ├── 文件操作
├── Camoufox 原生集成           └── 内存安全
├── 消息网关
└── CLI
```

运行时: Bun
