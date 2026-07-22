import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";

// Drive parseChunkUsage through a fake OpenAI stream whose final chunk carries an OpenAI-compatible
// reasoning usage shape: completion_tokens ALREADY includes reasoning_tokens (per the OpenAI spec),
// and completion_tokens_details.reasoning_tokens reports the reasoning portion.
const mockState = vi.hoisted(() => ({
	usage: undefined as
		| {
				prompt_tokens: number;
				completion_tokens: number;
				prompt_tokens_details: { cached_tokens: number };
				completion_tokens_details?: { reasoning_tokens?: number };
		  }
		| undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: async () => ({
					async *[Symbol.asyncIterator]() {
						yield {
							choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
							usage: mockState.usage,
						};
					},
				}),
			},
		};
	}
	return { default: FakeOpenAI };
});

async function usageFor(completionTokens: number, reasoningTokens?: number) {
	mockState.usage = {
		prompt_tokens: 10,
		completion_tokens: completionTokens,
		prompt_tokens_details: { cached_tokens: 0 },
		// Omit completion_tokens_details entirely when reasoningTokens is undefined — mirrors providers
		// that don't emit the detailed breakdown.
		...(reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: reasoningTokens } }),
	};
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
	const model = { ...baseModel, api: "openai-completions" } as const;
	const message = await streamSimple(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{ apiKey: "test" },
	).result();
	return message.usage;
}

describe("openai-completions usage.reasoning", () => {
	beforeEach(() => {
		mockState.usage = undefined;
	});

	// A thinking turn: completion_tokens (100) already includes reasoning (40), and `output` re-adds
	// reasoning on top (= 140). `reasoning` must be surfaced so a biller can recover the provider's real
	// completion count as `output - reasoning` (= 100) instead of over-charging on the inflated `output`.
	it("exposes reasoning tokens and keeps output = completion + reasoning", async () => {
		const usage = await usageFor(100, 40);
		expect(usage.reasoning).toBe(40);
		expect(usage.output).toBe(140);
		expect(usage.output - (usage.reasoning ?? 0)).toBe(100);
	});

	// Breakdown present with zero reasoning → a *reported* 0 (distinct from "not reported" below);
	// `output - reasoning` is a no-op (== completion).
	it("reports reasoning 0 when the breakdown is present but the model did not think", async () => {
		const usage = await usageFor(100, 0);
		expect(usage.reasoning).toBe(0);
		expect(usage.output).toBe(100);
	});

	// Provider omits completion_tokens_details entirely (common) → reasoning stays undefined, NOT 0, so a
	// consumer can tell "not reported" from a reported 0; output is just completion.
	it("leaves reasoning undefined when the provider omits completion_tokens_details", async () => {
		const usage = await usageFor(100);
		expect(usage.reasoning).toBeUndefined();
		expect(usage.output).toBe(100);
	});
});
