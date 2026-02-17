/*
	Builtin Commands（内置command）
	硬编码在 BUILTIN_SLASH_COMMANDS 里的，由 TUI 的 interactive-mode.ts 直接处理。这些是 pi 自身的核心功能，逻辑写死在代码里。

	Extension Commands
	扩展通过 registerCommand() 动态注册的：

	ctx.registerCommand("my-cmd", {
		description: "Do something",
		execute: async (ctx) => { ... }
	});

	注册后用户可以 /my-cmd 调用。

	统一展示:
	两者在 TUI 的 / 补全菜单里混在一起显示，但通过 SlashCommandSource 类型区分来源:
		内置command没有 source 字段（用的是单独的 BuiltinSlashCommand 类型），
		extension command标记为"extension"，skill 注册的标记为 "skill"，prompt template 注册的标记为 "prompt"。

	总结：内置command是写死的核心功能，extension command 是第三方动态注册的。用户视角都是/xxx，但实现和来源不同。
*/

/*
	三种外部来源都能注册为 slash command:
		- extension — extension 通过 registerCommand() 注册
		- prompt — prompt template 文件自动注册为 /prompt:xxx
		- skill — skill 文件自动注册为 /skill:xxx (需要 enableSkillCommands: true)
	它们本质都是 slash command，只是来源不同。加上内置的 builtin commands，一共四种来源，在 /补全菜单里统一呈现给用户。
*/
export type SlashCommandSource = "extension" | "prompt" | "skill";

export type SlashCommandLocation = "user" | "project" | "path";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	location?: SlashCommandLocation;
	path?: string;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session to HTML file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous message" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Login with OAuth provider" },
	{ name: "logout", description: "Logout from OAuth provider" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload extensions, skills, prompts, and themes" },
	{ name: "quit", description: "Quit pi" },
];
