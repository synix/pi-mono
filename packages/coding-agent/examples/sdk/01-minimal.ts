/**
 * Minimal SDK Usage
 *
 * Uses all defaults: discovers skills, extensions, tools, context files
 * from cwd and ~/.pi/agent. Model chosen from settings or first available.
 */

import { getModel } from "@mariozechner/pi-ai";
import { createAgentSession } from "@mariozechner/pi-coding-agent";

// 运行:
// OPENROUTER_API_KEY=sk-or-xxx npx tsx examples/sdk/01-minimal.ts

const model = getModel("openrouter", "anthropic/claude-sonnet-4");

const { session } = await createAgentSession({ model });

session.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await session.prompt("What files are in the current directory?");
session.state.messages.forEach((msg) => {
	console.log(msg);
});
console.log();
