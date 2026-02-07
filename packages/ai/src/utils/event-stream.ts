import type { AssistantMessage, AssistantMessageEvent } from "../types.js";

/**
   完整视角:
  ┌──────────────────────────┬────────┬──────────────┐
  │           方法           │ 调用方   │     作用     │
  ├──────────────────────────┼────────┼──────────────┤
  │ push()                   │ 生产者  │ 推送事件      │
  ├──────────────────────────┼────────┼──────────────┤
  │ end()                    │ 生产者  │ 强制结束流     │
  ├──────────────────────────┼────────┼──────────────┤
  │ [Symbol.asyncIterator]() │ 消费者  │ 逐个消费事件   │
  ├──────────────────────────┼────────┼──────────────┤
  │ result()                 │ 消费者  │ 获取最终结果   │
  └──────────────────────────┴────────┴──────────────┘
 */

// Generic event stream class for async iteration
// T 和 R 分别代表流中每个事件(event)的类型和最终结果(result)的类型
// 实际例子参考下面 AssistantMessageEventStream 的定义
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;

	constructor(
		// 判断某个事件是否表示流结束。当 push() 收到满足条件的事件时，流会被标记为完成。
		private isComplete: (event: T) => boolean,
		// 从终止事件中提取最终结果。这个结果会通过 result() 方法返回的 Promise 暴露出去。
		private extractResult: (event: T) => R,
	) {
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	/**
	    时序图:

		消费者                              生产者
			│                                   │
			├─ 请求事件 (queue 空)                │
			├─ 把 resolve 放入 waiting           │
			├─ await... (挂起)                   │
			│                                   │
			│                    push(event) ───┤
			│                    ↓              │
			│              waiting 有人？        │
			│              ↓ 是                 │
			│         waiter({ value: event }) ─┤
			│                                   │
			├─ Promise resolve ←────────────────┤
			├─ yield event                      │
			│                                   │

	 */

	// 生产者侧 (push)
	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.shift(); // 取出一个等待者
		if (waiter) {
			waiter({ value: event, done: false }); // 直接交付给它
		} else {
			this.queue.push(event); // 没人等，放入队列
		}
	}

	// 生产者侧, 用于强制结束流
	// 用于异常情况或提前终止（正常结束通常通过 push() 一个满足 isComplete 条件的事件）。
	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	// 消费者侧 (asyncIterator)
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!; // 队列有事件，直接返回
			} else if (this.done) {
				return; // 流结束
			} else {
				// 队列空了，挂起等待
				const result = await new Promise<IteratorResult<T>>(
					(resolve) => this.waiting.push(resolve), // ← 把自己放入等待队列
				);
				if (result.done) return;
				yield result.value;
			}
		}
	}

	/** 
		👆 总结
		┌─────────┬──────────────────────────────────────────────┐
		│  队列    │                     作用                     │
		├─────────┼──────────────────────────────────────────────┤
		│ queue   │ 存放已产生但未消费的事件（生产者快于消费者） │
		├─────────┼──────────────────────────────────────────────┤
		│ waiting │ 存放正在等待的消费者（消费者快于生产者）     │
		└─────────┴──────────────────────────────────────────────┘
		这是经典的异步队列实现模式，确保生产者和消费者可以以不同速度运行而不阻塞。
	 */

	// 消费者侧调用，用于获取最终结果
	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

// AssistantMessageEventStream 是 EventStream 的一个具体实现
// 专门用于处理 AssistantMessageEvent 类型的事件流，并从中提取最终的 AssistantMessage 结果。
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
