# pi-mono 源码阅读笔记

## 项目结构

monorepo，核心包：
- `packages/ai` — LLM 调用层：多 provider 适配、流式请求、消息转换
- `packages/agent` — Agent 框架层：agent loop、状态管理、工具执行
- `packages/coding-agent` — 应用层：CLI 工具，基于上面两个包构建

---

## packages/ai — LLM 调用层

### Provider 注册机制

`src/api-registry.ts` 定义了 `ApiProvider` 接口：

```
ApiProvider {
  api: "anthropic-messages" | "openai-completions" | ...
  stream: StreamFunction      // 底层，需了解 SDK 调用细节（如 AnthropicOptions）
  streamSimple: StreamFunction // 高层封装，跨 provider 统一接口（SimpleStreamOptions）
}
```

`src/providers/register-builtins.ts` 的 `registerBuiltInApiProviders()` 注册所有内置 API 类型，建立 api 类型 → 实现函数的映射。调用 `streamSimple(model, context, options)` 时，代码根据 `model.api` 查找对应实现。

### 流式架构 — EventStream

`src/utils/event-stream.ts` 实现了生产者-消费者异步队列：

```
┌─────────┬──────────────────────────────────────────────┐
│  队列    │                     作用                     │
├─────────┼──────────────────────────────────────────────┤
│ queue   │ 存放已产生但未消费的事件（生产者快于消费者） │
├─────────┼──────────────────────────────────────────────┤
│ waiting │ 存放正在等待的消费者（消费者快于生产者）     │
└─────────┴──────────────────────────────────────────────┘
```

方法角色：
- `push()` — 生产者侧，推送事件
- `end()` — 生产者侧，强制结束流
- `[Symbol.asyncIterator]()` — 消费者侧，逐个消费事件
- `result()` — 消费者侧，获取最终结果

`AssistantMessageEventStream` 是具体实例：`EventStream<AssistantMessageEvent, AssistantMessage>`。

### Anthropic Provider（以 anthropic.ts 为例）

`streamAnthropic()` 中，`client.messages.stream()` 是最终调用 Anthropic SDK 的地方。Anthropic 返回的事件流结构：

```
message_start
├── content_block_start (index 0)
│   ├── content_block_delta (text_delta)
│   └── content_block_stop
├── content_block_start (index 1, tool_use)
│   ├── content_block_delta (input_json_delta)
│   └── content_block_stop
├── message_delta (stop_reason, usage)
└── message_stop
```

注意 `event.index`（Anthropic 原始编号，可能不连续）与 `blocks` 数组下标（本地连续编号）是两个不同索引体系，用 `findIndex` 桥接。

### 跨模型消息兼容 — transform-messages.ts

核心问题：多模型切换时的消息兼容性。对话历史中混有不同 LLM 产生的消息，发给当前模型前需要清理和标准化。

分两遍处理：
1. **第一遍 — 逐条转换**：
   - `user` 消息：原样通过
   - `assistant` 消息：判断是否同模型（比对 provider + api + model id）
     - thinking block：同模型+有签名→保留；空→丢弃；不同模型→降级为 text
     - text block：不同模型→剥离 textSignature
     - toolCall：不同模型→删 thoughtSignature、标准化 ID（OpenAI 450+ 字符 ID 不符合 Anthropic 限制）
   - `toolResult` 消息：查映射表替换标准化后的 toolCallId
2. **第二遍 — 补全孤儿 tool call**：LLM API 要求每个 tool call 必须有对应 result，但中途中断可能产生"孤儿"，需要补合成空 result

### 参数验证 — validation.ts

使用 `@sinclair/typebox` + `AJV`：
- TypeBox 让同一份定义既是 runtime 的 JSON Schema（给 LLM）又是 compile-time 的 TypeScript 类型
- AJV 配置了 `coerceTypes: true`，validate 时会就地修改对象（如字符串 "42" → 数字 42），所以先 `structuredClone` 再验证
- AJV 在 Chrome 扩展环境下无法工作（CSP 限制 `new Function()`），会跳过验证

### 模型数据 — generate-models.ts

从 models.dev API + OpenRouter + Vercel AI Gateway 三个来源拉取模型列表：
- 只纳入支持 `tool_call` 的模型
- 排除不支持 streaming 或 system messages 的模型
- 有临时补丁修正上游数据错误（如 Claude Opus 4.5 的 cache pricing）
- `calculateCost()` 单位是美元，公式：`(model.cost.input / 1_000_000) * usage.input`

---

## packages/agent — Agent 框架层

### Agent 类（agent.ts）

核心状态：
```typescript
AgentState {
  systemPrompt, model, thinkingLevel, tools,
  messages: AgentMessage[],  // 包含自定义消息类型
  isStreaming: boolean,      // 仅表示"正在接收 LLM 响应"，不含工具执行阶段
  streamMessage,             // 当前正在流式传输的消息（partial）
  pendingToolCalls: Set,     // 正在执行的工具集合
  error,
}
```

调用链：`agent.prompt()` / `agent.continue()` → `_runLoop()` → `agentLoop()` / `agentLoopContinue()` → stream of `AgentEvent`

中断机制：`abort()` → `abortController.abort()` → signal.aborted = true → 下游抛异常 → catch 中判断 signal.aborted 区分用户中断 vs 真正错误

### 消息队列：steering 和 followUp

```
┌──────────┬─────────────────────┬─────────────────────┐
│          │ getSteeringMessages │ getFollowUpMessages │
├──────────┼─────────────────────┼─────────────────────┤
│ 调用时机  │ 工具执行后            │ Agent 准备停止时      │
├──────────┼─────────────────────┼─────────────────────┤
│ 用途      │ 中途打断/转向         │ 追加后续任务          │
├──────────┼─────────────────────┼─────────────────────┤
│ 优先级    │ 高（跳过剩余工具）     │ 低（等 Agent 空闲）   │
└──────────┴─────────────────────┴─────────────────────┘
```

两种模式：`"one-at-a-time"`（默认，逐条处理） / `"all"`（一次清空队列）

### Agent Loop（agent-loop.ts）

双层循环结构：
- **外层循环**：处理 follow-up 消息（agent 本来要停了，但队列里有新任务）
- **内层循环**：处理 tool calls + steering 消息

`streamAssistantResponse()` 是核心：
1. `transformContext`（可选）— 上下文裁剪/摘要/注入
2. `convertToLlm`（必需）— 过滤自定义消息类型，只保留 user/assistant/toolResult
3. 调用 `streamFn`（默认 `streamSimple`）发起 LLM 请求
4. for-await 循环处理 `AssistantMessageEvent` 流，更新上下文并发出 `AgentEvent`

工具执行后检查 `getSteeringMessages()`，有消息则跳过剩余工具。被跳过的工具返回 `"Skipped due to queued user message"`。

### 自定义消息类型 — CustomAgentMessages

应用层通过 TypeScript declaration merging 扩展 `CustomAgentMessages` 接口，注入 app 专属消息类型。这些类型出现在 `AgentState.messages` 中（面向 UI）但被 `convertToLlm()` 过滤掉（不发给 LLM）。

### Proxy 模式（proxy.ts）

核心优化：去掉 `AssistantMessageEvent` 中的 `partial` 字段（累积的完整消息快照），节省带宽。

```
服务端                          网络                          客户端
AssistantMessageEvent    →   去掉 partial    →    ProxyAssistantMessageEvent
(带 partial 快照)             节省带宽              收到后本地重建 partial
                                                         ↓
                                                  processProxyEvent()
                                                  拼接 delta 到本地 partial
```

### AgentTool 类型

```typescript
AgentTool<TParameters, TDetails> extends Tool<TParameters> {
  label: string;          // 面向 UI
  execute: (
    toolCallId: string,   // LLM 返回的 ID，关联调用和结果
    params: Static<TParameters>,  // TypeBox 类型安全参数
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,  // 流式进度回调
  ) => Promise<AgentToolResult<TDetails>>;
}

AgentToolResult {
  content: (TextContent | ImageContent)[];  // 发回给 LLM
  details: TDetails;                         // 给 UI 展示（不发给 LLM）
}
```

---

## Skill 系统（packages/coding-agent）

### 核心文件

| 文件 | 作用 |
|------|------|
| `src/core/skills.ts` | 加载、验证、格式化（已加中文注释） |
| `src/core/system-prompt.ts` | 将 skill 注入 system prompt |
| `src/core/tools/read.ts` | 通用 read tool（agent 用来按需读取 SKILL.md） |
| `src/core/agent-session.ts` | `/skill:name` 命令展开、skill block 解析 |

### 加载流程

```
loadSkills()
  ├── 全局：~/.pi/agent/skills/     (source = "user")
  ├── 项目：<cwd>/.pi/skills/        (source = "project")
  └── 显式：--skill <path>           (source = "path")
```

发现规则：根目录直属 `*.md` + 子目录递归查找 `SKILL.md`。
去重：realpath 检测符号链接（静默）+ name 冲突检测（记录 collision 诊断，先到先得）。

### 渐进式披露

`formatSkillsForPrompt()` 只在 system prompt 中放 name + description + location（XML 格式），完整指令按需加载。两条路径：

1. **Agent 自主读取**：system prompt 指令 + 通用 read tool，纯 prompt engineering，无专属代码
2. **用户手动触发**：`/skill:name` → `_expandSkillCommand()` → `readFileSync` 读文件 → 包裹 `<skill>` XML 注入对话

### Agent Skills 标准实现程度

**已实现**：SKILL.md 发现、frontmatter 解析验证、渐进式披露、XML 提示格式、多来源加载、冲突检测、.gitignore 支持

**未实现**：
- `scripts/` — 无发现/验证/执行框架，靠 agent 自主用 bash tool 执行
- `references/` / `assets/` — 无特殊处理，靠 agent 自主用 read tool 读取
- `allowed-tools` — frontmatter 能解析但运行时从未使用
- 脚本安全沙箱 — 无

**结论**：本项目实现了 "SKILL.md-only" 模式，scripts/references/assets 完全依赖 agent 自主行为通过通用工具访问，没有框架级支持。
