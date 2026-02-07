import { clearApiProviders, registerApiProvider } from "../api-registry.js";
import { streamBedrock, streamSimpleBedrock } from "./amazon-bedrock.js";
import { streamAnthropic, streamSimpleAnthropic } from "./anthropic.js";
import { streamAzureOpenAIResponses, streamSimpleAzureOpenAIResponses } from "./azure-openai-responses.js";
import { streamGoogle, streamSimpleGoogle } from "./google.js";
import { streamGoogleGeminiCli, streamSimpleGoogleGeminiCli } from "./google-gemini-cli.js";
import { streamGoogleVertex, streamSimpleGoogleVertex } from "./google-vertex.js";
import { streamOpenAICodexResponses, streamSimpleOpenAICodexResponses } from "./openai-codex-responses.js";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "./openai-completions.js";
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from "./openai-responses.js";

/**
	registerBuiltInApiProviders 的作用是注册所有内置的 API 类型，建立 api 类型到具体实现函数的映射。
	当调用 packages/ai/src/stream.ts 里的 streamSimple(model, context, options) 时，代码根据 model.api 查找对应的实现函数并调用。
 */
export function registerBuiltInApiProviders(): void {
	registerApiProvider({
		api: "anthropic-messages",
		stream: streamAnthropic,
		streamSimple: streamSimpleAnthropic,
	});

	registerApiProvider({
		api: "openai-completions",
		stream: streamOpenAICompletions,
		streamSimple: streamSimpleOpenAICompletions,
	});

	registerApiProvider({
		api: "openai-responses",
		stream: streamOpenAIResponses,
		streamSimple: streamSimpleOpenAIResponses,
	});

	registerApiProvider({
		api: "azure-openai-responses",
		stream: streamAzureOpenAIResponses,
		streamSimple: streamSimpleAzureOpenAIResponses,
	});

	registerApiProvider({
		api: "openai-codex-responses",
		stream: streamOpenAICodexResponses,
		streamSimple: streamSimpleOpenAICodexResponses,
	});

	registerApiProvider({
		api: "google-generative-ai",
		stream: streamGoogle,
		streamSimple: streamSimpleGoogle,
	});

	registerApiProvider({
		api: "google-gemini-cli",
		stream: streamGoogleGeminiCli,
		streamSimple: streamSimpleGoogleGeminiCli,
	});

	registerApiProvider({
		api: "google-vertex",
		stream: streamGoogleVertex,
		streamSimple: streamSimpleGoogleVertex,
	});

	registerApiProvider({
		api: "bedrock-converse-stream",
		stream: streamBedrock,
		streamSimple: streamSimpleBedrock,
	});
}

export function resetApiProviders(): void {
	clearApiProviders();
	registerBuiltInApiProviders();
}

registerBuiltInApiProviders();
