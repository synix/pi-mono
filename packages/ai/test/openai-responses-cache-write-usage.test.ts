import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

const MODEL: Model<"openai-responses"> = {
	id: "gpt-5.6-terra",
	name: "GPT-5.6 Terra",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	// 1 per 1M keeps the arithmetic readable: cost equals tokens / 1e6 per bucket.
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 1050000,
	maxTokens: 128000,
};

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Emits only response.completed — enough to exercise the usage mapping. */
async function* completedWith(details: {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	cached_tokens?: number;
	cache_write_tokens?: number;
}): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		response: {
			id: "resp_test",
			status: "completed",
			usage: {
				input_tokens: details.input_tokens,
				output_tokens: details.output_tokens,
				total_tokens: details.total_tokens,
				input_tokens_details: {
					cached_tokens: details.cached_tokens ?? 0,
					cache_write_tokens: details.cache_write_tokens ?? 0,
				},
				output_tokens_details: { reasoning_tokens: 0 },
			},
		},
	} as unknown as ResponseStreamEvent;
}

async function run(details: Parameters<typeof completedWith>[0]): Promise<AssistantMessage> {
	const output = createOutput(MODEL);
	await processResponsesStream(completedWith(details), output, new AssistantMessageEventStream(), MODEL);
	return output;
}

describe("openai responses cache-write usage", () => {
	// The three details are disjoint slices of input_tokens, each billed at its own rate. Verified
	// against the live API: the same 4812-token prompt reports (cached 0, written 4809) on the cold
	// call and (cached 4809, written 0) once warm, leaving the same 3 uncached tokens both times.
	it("reports cache writes and excludes them from input (cold call)", async () => {
		const output = await run({
			input_tokens: 4812,
			output_tokens: 10,
			total_tokens: 4822,
			cached_tokens: 0,
			cache_write_tokens: 4809,
		});

		expect(output.usage.cacheWrite).toBe(4809);
		expect(output.usage.cacheRead).toBe(0);
		expect(output.usage.input).toBe(3);
		// Every prompt token is accounted for exactly once.
		expect(output.usage.input + output.usage.cacheRead + output.usage.cacheWrite).toBe(4812);
	});

	it("reports cache reads and excludes them from input (warm call)", async () => {
		const output = await run({
			input_tokens: 4812,
			output_tokens: 10,
			total_tokens: 4822,
			cached_tokens: 4809,
			cache_write_tokens: 0,
		});

		expect(output.usage.cacheRead).toBe(4809);
		expect(output.usage.cacheWrite).toBe(0);
		expect(output.usage.input).toBe(3);
		expect(output.usage.input + output.usage.cacheRead + output.usage.cacheWrite).toBe(4812);
	});

	it("does not bill written tokens twice", async () => {
		const output = await run({
			input_tokens: 1000,
			output_tokens: 0,
			total_tokens: 1000,
			cached_tokens: 0,
			cache_write_tokens: 900,
		});

		// Leaving cache writes inside `input` would charge those 900 tokens at both the input and the
		// cache-write rate, i.e. cost.input would be 1000/1e6 rather than 100/1e6.
		expect(output.usage.input).toBe(100);
		expect(output.usage.cost.input).toBeCloseTo(100 / 1e6, 12);
		expect(output.usage.cost.cacheWrite).toBeCloseTo(900 / 1e6, 12);
		expect(output.usage.cost.total).toBeCloseTo(1000 / 1e6, 12);
	});

	it("keeps pre-5.6 behaviour when the provider omits cache_write_tokens", async () => {
		const output = await run({
			input_tokens: 500,
			output_tokens: 20,
			total_tokens: 520,
			cached_tokens: 128,
		});

		expect(output.usage.cacheWrite).toBe(0);
		expect(output.usage.cacheRead).toBe(128);
		expect(output.usage.input).toBe(372);
	});

	it("never reports negative input if the details exceed input_tokens", async () => {
		const output = await run({
			input_tokens: 100,
			output_tokens: 0,
			total_tokens: 100,
			cached_tokens: 80,
			cache_write_tokens: 80,
		});

		expect(output.usage.input).toBe(0);
	});
});
