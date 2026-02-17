import type {
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	streamSimple,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";

/** Stream function - can return sync or Promise for async config lookup */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

/**
 * Configuration for the agent loop.
 */
export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/*
		convertToLlm(必需配置项): 过滤自定义消息类型
		- 通过 `CustomAgentMessages` 声明合并（declaration merging）注入的 app 专属消息类型不会发给 LLM
		- 只保留 user/assistant/toolResult message
	 */

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/*
		transformContext(可选配置项): 用于上下文裁剪/摘要/注入, 控制 token 消耗
		- 消息裁剪/截断（长对话场景）
		- 中间消息摘要压缩
		- 外部上下文注入(RAG、知识库)
		- 消息去重
	*/

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	// 下面两者都用于在 Agent 运行过程中注入额外消息, 但时机和用途不同:
	/*
		对比
		┌──────────┬─────────────────────┬─────────────────────┐
		│          │ getSteeringMessages │ getFollowUpMessages │
		├──────────┼─────────────────────┼─────────────────────┤
		│ 调用时机  │ 工具执行后            │ Agent 准备停止时      │
		├──────────┼─────────────────────┼─────────────────────┤
		│ 用途      │ 中途打断/转向         │ 追加后续任务          │
		├──────────┼─────────────────────┼─────────────────────┤
		│ 优先级    │ 高（跳过剩余工具）     │ 低（等 Agent 空闲）   │
		├──────────┼─────────────────────┼─────────────────────┤
		│ 典型场景  │ 用户紧急干预          │ 消息队列处理           │
		└──────────┴─────────────────────┴─────────────────────┘
		流程图

		Agent 循环:
			LLM 调用 → 返回工具调用
				↓
			执行工具1
				↓
			getSteeringMessages() → 有消息? → 跳过剩余工具，开始新 LLM 调用
				↓ (无消息)
			执行工具2
				↓
			getSteeringMessages() → ...
				↓
			所有工具执行完
				↓
			getSteeringMessages() → 有消息? → 新 LLM 调用
				↓ (无消息)
			getFollowUpMessages() → 有消息? → 新 LLM 调用
				↓ (无消息)
      		Agent 停止
	*/

	// 👇 中途打断
	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after each tool execution to check for user interruptions.
	 * If messages are returned, remaining tool calls are skipped and
	 * these messages are added to the context before the next LLM call.
	 *
	 * Use this for "steering" the agent while it's working.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	// 👇 追加后续
	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 *
	 * Use this for follow-up messages that should wait until the agent finishes.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;
}

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh" is only supported by OpenAI gpt-5.1-codex-max, gpt-5.2, gpt-5.2-codex, gpt-5.3, and gpt-5.3-codex models.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// 应用层可以通过 declaration merging 扩展消息类型
// 自定义消息类型会出现在 `AgentState.messages` 中(面向UI) 但会被 `convertToLlm()` 过滤掉(不发给 LLM)

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// 应用在这里添加自定义消息类型
	// Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Agent state containing all configuration and conversation data.
 */
export interface AgentState {
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool<any>[];
	messages: AgentMessage[]; // Can include attachments + custom message types
	/**
	 *  isStreaming 表示 Agent 当前是否正在从 LLM 接收流式响应。
		┌───────┬──────────────────────────────────────────────┐
		│  值   │                     含义                     │
		├───────┼──────────────────────────────────────────────┤
		│ true  │ Agent 正在调用 LLM，响应正在流式传输中       │
		├───────┼──────────────────────────────────────────────┤
		│ false │ Agent 空闲（初始状态、执行工具中、或已完成） │
		└───────┴──────────────────────────────────────────────┘
		isStreaming 只表示"正在接收 LLM 响应"，不包括工具执行阶段。
		执行工具时 isStreaming 是 false，但 Agent仍在工作。完整的"忙碌"判断需要结合 pendingToolCalls 等其他状态。
	 */
	isStreaming: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: Set<string>;
	error?: string;
}

export interface AgentToolResult<T> {
	// Content blocks supporting text and images
	content: (TextContent | ImageContent)[]; // 发回给 LLM 的内容
	// Details to be displayed in a UI or logged
	details: T; // 给 UI 展示的额外信息（不发给 LLM）
}

// Callback for streaming tool execution updates
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

// TDetails 控制工具调用的附加输出类型, 流经整个结果链:
// 比如一个文件搜索工具, content 是搜索结果文本 (LLM 看到),details 可以是 { matchCount: number, files: string[] } 这种结构化数据(UI 渲染用)
// onUpdate 回调也用同样的 TDetails 类型，支持流式更新进度

// AgentTool extends Tool but adds the execute function
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	// A human-readable label for the tool to be displayed in UI
	label: string; // 面向UI
	execute: (
		toolCallId: string, // LLM 返回的 toolcall id, 用于关联 LLM工具调用 和 实际工具代码执行 的结果
		params: Static<TParameters>, // ← 关键：TypeBox 把 Schema 变成了类型安全的 TS 对象
		signal?: AbortSignal, // 用于工具执行过程中被外部中断（如用户取消）
		onUpdate?: AgentToolUpdateCallback<TDetails>, // 流式进度回调
	) => Promise<AgentToolResult<TDetails>>;
}

// AgentContext is like Context but uses AgentTool
export interface AgentContext {
	systemPrompt: string;
	messages: AgentMessage[];
	tools?: AgentTool<any>[];
}

/**
 * AgentEvent 是 Agent运行过程中发出来的面向UI的事件
 * 分为4大类型(agent/turn/message/tool), 10大事件
 */

/**
 * Events emitted by the Agent for UI updates.
 * These events provide fine-grained lifecycle information for messages, turns, and tool executions.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
