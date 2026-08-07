import { describe, expect, it } from "vitest";
import { getModel, supportsXhigh } from "../src/models.js";
import type { Model } from "../src/types.js";

/** Minimal model whose only meaningful field is the id supportsXhigh dispatches on. */
function modelWithId(id: string): Model<"openai-responses"> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

describe("supportsXhigh", () => {
	it("returns true for Anthropic Opus 4.6 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-6");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});

	it("returns false for non-Opus Anthropic models", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(false);
	});

	it("returns true for GPT-5.4 models", () => {
		const model = getModel("openai-codex", "gpt-5.4");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});

	// Probed against /v1/responses: every id in these families accepts reasoning.effort "xhigh" and
	// spends strictly more reasoning tokens at it than at "high". Without them clampReasoning
	// silently downgrades the request to "high", losing the top tier with no error.
	//
	// Built inline rather than via getModel: models.generated.ts is a build-time snapshot of
	// models.dev and does not yet carry the 5.5/5.6 ids, while supportsXhigh only ever reads
	// model.id. Going through the registry would tie this test to when the snapshot was refreshed.
	it.each(["gpt-5.5", "gpt-5.5-pro", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol"])("returns true for %s", (id) => {
		expect(supportsXhigh(modelWithId(id))).toBe(true);
	});

	it.each(["gpt-5.1", "gpt-5-mini", "gpt-4.1"])("returns false for %s", (id) => {
		expect(supportsXhigh(modelWithId(id))).toBe(false);
	});

	it("returns true for OpenRouter Opus 4.6 (openai-completions API)", () => {
		const model = getModel("openrouter", "anthropic/claude-opus-4.6");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});
});
