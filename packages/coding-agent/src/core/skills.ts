import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import ignore from "ignore"; // .gitignore 风格的路径匹配库，用于排除不需要扫描的文件/目录
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js"; // CONFIG_DIR_NAME = ".pi"，getAgentDir() 返回 ~/.pi/agent
import { parseFrontmatter } from "../utils/frontmatter.js"; // 解析 Markdown 文件头部的 YAML frontmatter
import type { ResourceDiagnostic } from "./diagnostics.js"; // 诊断信息类型（warning / collision 等）

/** Max name length per spec */
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

// 需要检查的忽略文件列表，用于决定哪些路径不扫描
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

/**
 * 将系统路径转换为 POSIX 风格（用 / 分隔）
 * 因为 ignore 库内部使用 POSIX 路径格式，Windows 上的 \ 需要转换
 */
function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

/**
 * 给 .gitignore 中的一行规则加上目录前缀，使其相对于根目录生效。
 * 例如：prefix="src/skills/"，规则 "*.tmp" → "src/skills/*.tmp"
 * 这样子目录中的 .gitignore 规则就能在根目录的 ignore 匹配器中正确工作。
 *
 * @returns 加了前缀的规则，或 null（空行/注释行）
 */
function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null; // 跳过空行
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null; // 跳过注释行（\# 是转义的 #，不是注释）

	let pattern = line;
	let negated = false; // 是否是取反规则（以 ! 开头）

	if (pattern.startsWith("!")) {
		negated = true; // 标记为取反
		pattern = pattern.slice(1); // 去掉 !
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1); // \! 是转义的 !，不是取反，只去掉反斜杠
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1); // 去掉开头的 /（表示锚定到目录根，加了 prefix 后不再需要）
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed; // 如果原来是取反规则，恢复 ! 前缀
}

/**
 * 读取指定目录下的所有忽略文件（.gitignore / .ignore / .fdignore），
 * 将其中的规则加上相对路径前缀后添加到 ignore 匹配器中。
 *
 * @param ig - 全局共享的 ignore 匹配器实例
 * @param dir - 当前要读取忽略文件的目录
 * @param rootDir - 扫描的根目录（用于计算相对路径前缀）
 */
function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir); // 当前目录相对于根目录的路径
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : ""; // 转为 POSIX 格式前缀

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/) // 按行分割（兼容 \r\n）
				.map((line) => prefixIgnorePattern(line, prefix)) // 每行加前缀
				.filter((line): line is string => Boolean(line)); // 过滤掉 null（空行/注释行）
			if (patterns.length > 0) {
				ig.add(patterns); // 批量添加到匹配器
			}
		} catch {} // 读取失败静默跳过
	}
}

/**
 * Skill 文件的 YAML frontmatter 结构
 * 对应 SKILL.md 头部的 YAML 块，例如：
 * ---
 * name: my-skill
 * description: A useful skill
 * disable-model-invocation: true
 * ---
 */
export interface SkillFrontmatter {
	name?: string; // 技能名称（可选，不填则用父目录名）
	description?: string; // 技能描述（必填，缺失则不加载该技能）
	"disable-model-invocation"?: boolean; // 是否禁止模型自动调用（true = 只能通过 /skill:name 手动调用）
	[key: string]: unknown; // 允许其他自定义字段（如 license、metadata 等）
}

/** 加载后的 Skill 对象，包含完整的元数据 */
export interface Skill {
	name: string; // 技能名称（用于 /skill:name 命令和系统提示中的标识）
	description: string; // 技能描述（告诉 agent 何时使用这个技能）
	filePath: string; // SKILL.md 文件的绝对路径
	baseDir: string; // 技能所在目录（用于解析技能文件中的相对路径引用）
	source: string; // 来源标识："user"（全局）、"project"（项目级）、"path"（显式指定）
	disableModelInvocation: boolean; // 是否禁止模型自动调用
}

/** 技能加载结果：包含成功加载的技能列表和诊断信息 */
export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[]; // 警告、冲突等诊断信息
}

/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 *
 * 验证规则：
 *   - 必须与父目录名匹配
 *   - 最长 64 个字符
 *   - 只允许小写字母、数字、连字符
 *   - 不能以连字符开头或结尾
 *   - 不能包含连续连字符
 */
function validateName(name: string, parentDirName: string): string[] {
	const errors: string[] = [];

	if (name !== parentDirName) {
		errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
	}

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

/**
 * Validate description per Agent Skills spec.
 */
function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];

	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
}

/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - direct .md children in the root
 * - recursive SKILL.md under subdirectories
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir, source } = options;
	// includeRootFiles=true 表示根目录下扫描 *.md 文件
	return loadSkillsFromDirInternal(dir, source, true);
}

/**
 * 递归扫描目录加载技能（内部实现）
 *
 * @param includeRootFiles - 是否扫描当前目录下的 .md 文件
 *   - true：扫描目录根的 *.md 文件（只在最顶层调用时为 true）
 *   - false：只查找 SKILL.md（递归进入子目录时为 false）
 *   这两种模式对应两种技能组织方式：
 *   根目录直属 .md 适合简单的单文件技能；子目录 SKILL.md 适合包含多个文件的复杂技能。
 * @param ignoreMatcher - 共享的 ignore 匹配器（递归传递，避免重复创建）
 * @param rootDir - 最初的扫描根目录（用于计算相对路径）
 */
function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { skills, diagnostics };
	}

	const root = rootDir ?? dir; // 首次调用时，root 就是 dir 自身
	const ig = ignoreMatcher ?? ignore(); // 首次调用时创建新的匹配器
	addIgnoreRules(ig, dir, root); // 读取当前目录的忽略规则

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.name.startsWith(".")) {
				continue;
			}

			// Skip node_modules to avoid scanning dependencies
			if (entry.name === "node_modules") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			// For symlinks, check if they point to a directory and follow them
			// 处理符号链接：解析其真实类型（目录 or 文件）
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath); // 跟随符号链接获取真实信息
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					// Broken symlink, skip it
					continue;
				}
			}

			// 检查 ignore 规则（目录路径末尾加 /，这是 .gitignore 的惯例）
			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDirectory ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) {
				continue;
			}

			// 递归扫描子目录（includeRootFiles=false，子目录只查找 SKILL.md）
			if (isDirectory) {
				const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root);
				skills.push(...subResult.skills);
				diagnostics.push(...subResult.diagnostics);
				continue;
			}

			if (!isFile) {
				continue;
			}

			// 判断文件是否符合发现规则：
			//   - 根目录层级：任何 .md 文件都是候选（includeRootFiles=true）
			//   - 子目录层级：只有名为 SKILL.md 的文件才是候选（includeRootFiles=false）
			const isRootMd = includeRootFiles && entry.name.endsWith(".md");
			const isSkillMd = !includeRootFiles && entry.name === "SKILL.md";
			if (!isRootMd && !isSkillMd) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
		}
	} catch {}

	return { skills, diagnostics };
}

/**
 * 从单个 Markdown 文件加载技能
 *
 * 流程：
 *   1. 读取文件内容，解析 YAML frontmatter（提取 name、description 等）
 *   2. 验证 name 和 description
 *   3. description 缺失 → 不加载（返回 null）；其他验证错误只产生警告，仍会加载
 */
function loadSkillFromFile(
	filePath: string,
	source: string,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];

	try {
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent); // 解析 YAML 头
		const skillDir = dirname(filePath); // 技能所在目录
		const parentDirName = basename(skillDir); // 父目录名（用于验证 name 是否匹配）

		// Validate description
		const descErrors = validateDescription(frontmatter.description);
		for (const error of descErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// Use name from frontmatter, or fall back to parent directory name
		// 技能名称：优先使用 frontmatter 中的 name，否则用父目录名作为回退
		const name = frontmatter.name || parentDirName;

		// Validate name
		const nameErrors = validateName(name, parentDirName);
		for (const error of nameErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// Still load the skill even with warnings (unless description is completely missing)
		// 关键：description 缺失是致命错误，直接放弃加载；其他验证错误（如 name 格式不对）只是警告
		if (!frontmatter.description || frontmatter.description.trim() === "") {
			return { skill: null, diagnostics };
		}

		return {
			skill: {
				name,
				description: frontmatter.description,
				filePath,
				baseDir: skillDir, // 技能中的相对路径引用会基于此目录解析
				source,
				disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			},
			diagnostics,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse skill file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { skill: null, diagnostics };
	}
}

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 *
 * 这是一种"渐进式披露"设计 —— 提示词中只放名称和描述，
 * agent 需要时再用 read tool 读取完整的 SKILL.md 内容。
 *
 * "渐进式披露"的实现分为两条路径：
 *
 * 路径一: Agent 自主读取 (read tool)
 * 这条路径没有专门的代码来处理技能读取 —— 它就是普通的文件读取。关键在于 system prompt 中的指令引导 agent 自己决定去读。
 * 1. 系统提示词注入指令 — packages/coding-agent/src/core/system-prompt.ts:178-181
 * 	只有当 agent 拥有 read 工具时，才把技能列表放进系统提示词
 * 	- "Use the read tool to load a skill's file when the task matches its description."
 * 	- 每个技能的 <location> 标签（即 SKILL.md 的绝对路径）
 * 2. Agent 调用 read tool 读取文件 — packages/coding-agent/src/core/tools/read.ts
 *  这就是一个通用的文件读取工具，agent 看到系统提示里的 <location>/path/to/SKILL.md</location> 后，自己决定调用 read(path: "/path/to/SKILL.md") 来获取完整内容。没有任何技能专属逻辑。
 *  所以这条路径本质上是 prompt engineering：通过系统提示的指令 + location 路径，让 agent 自主决定何时用通用 read tool 去加载技能文件。
 *
 * 路径二：用户手动触发（/skill:name 命令）
 * 这条路径有专门的代码，直接读文件并注入到对话中。
 * packages/coding-agent/src/core/agent-session.ts:_expandSkillCommand
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
	// 过滤掉禁止模型自动调用的技能
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	if (visibleSkills.length === 0) {
		return "";
	}

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");

	return lines.join("\n");
}

/** XML 特殊字符转义，防止技能名称/描述中的特殊字符破坏 XML 结构 */
function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. Default: process.cwd() */
	cwd?: string;
	/** Agent config directory for global skills. Default: ~/.pi/agent */
	agentDir?: string;
	/** Explicit skill paths (files or directories) */
	skillPaths?: string[];
	/** Include default skills directories. Default: true */
	includeDefaults?: boolean;
}

/** 路径标准化：处理 ~ 前缀（展开为用户主目录） */
function normalizePath(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return homedir(); // ~ → /Users/xxx
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2)); // ~/foo → /Users/xxx/foo
	if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1)); // ~foo → /Users/xxx/foo（非标准但兼容）
	return trimmed;
}

/** 解析技能路径：先标准化 ~，再转为绝对路径 */
function resolveSkillPath(p: string, cwd: string): string {
	const normalized = normalizePath(p);
	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 *
 * 加载顺序（先加载的优先，同名冲突时先到先得）：
 *   1. 全局技能目录：~/.pi/agent/skills/   （source = "user"）
 *   2. 项目技能目录：.pi/skills/            （source = "project"）
 *   3. 显式指定路径：--skill <path>          （source = "path"，或根据路径推断 "user"/"project"）
 *
 * 去重机制：
 *   - 通过 realpath 检测符号链接指向的同一文件（静默去重）
 *   - 通过 name 检测名称冲突（记录 collision 诊断信息，先加载的获胜）
 */
export function loadSkills(options: LoadSkillsOptions = {}): LoadSkillsResult {
	const { cwd = process.cwd(), agentDir, skillPaths = [], includeDefaults = true } = options;

	// Resolve agentDir - if not provided, use default from config
	const resolvedAgentDir = agentDir ?? getAgentDir();

	const skillMap = new Map<string, Skill>(); // name → Skill 映射（保证名称唯一）
	const realPathSet = new Set<string>(); // 已加载文件的真实路径集合（检测符号链接去重）
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = []; // 名称冲突诊断（放在最后输出）

	/**
	 * 将一批加载结果合并到全局 skillMap 中
	 * 处理两种去重：
	 *   1. realpath 去重：同一文件通过符号链接被发现两次 → 静默跳过
	 *   2. name 去重：不同文件但技能名相同 → 记录 collision 诊断，先来的获胜
	 */
	function addSkills(result: LoadSkillsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			// Resolve symlinks to detect duplicate files
			let realPath: string;
			try {
				realPath = realpathSync(skill.filePath);
			} catch {
				realPath = skill.filePath;
			}

			// Skip silently if we've already loaded this exact file (via symlink)
			if (realPathSet.has(realPath)) {
				continue;
			}

			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: {
						resourceType: "skill",
						name: skill.name,
						winnerPath: existing.filePath,
						loserPath: skill.filePath,
					},
				});
			} else {
				skillMap.set(skill.name, skill);
				realPathSet.add(realPath);
			}
		}
	}

	// ===== 第一步：加载默认目录中的技能 =====
	if (includeDefaults) {
		addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true)); // 全局：~/.pi/agent/skills/
		addSkills(loadSkillsFromDirInternal(resolve(cwd, CONFIG_DIR_NAME, "skills"), "project", true)); // 项目：<cwd>/.pi/skills/
	}

	// ===== 第二步：处理显式指定的技能路径（--skill <path>） =====

	// 预计算默认目录路径，用于判断显式路径的 source
	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(cwd, CONFIG_DIR_NAME, "skills");

	/** 判断 target 路径是否在 root 路径下 */
	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		// 确保前缀以路径分隔符结尾，避免 /foo/bar 匹配 /foo/barbaz
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	/**
	 * 推断显式路径的 source 标识
	 * 即使 --no-skills 禁用了默认目录，如果显式路径恰好在全局/项目目录下，
	 * 仍然标记为 "user" 或 "project"（而非 "path"），保持语义一致
	 */
	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
			if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of skillPaths) {
		const resolvedPath = resolveSkillPath(rawPath, cwd);
		if (!existsSync(resolvedPath)) {
			allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadSkillFromFile(resolvedPath, source);
				if (result.skill) {
					addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
				} else {
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				allDiagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read skill path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	// collision 诊断放在最后，方便用户查看
	return {
		skills: Array.from(skillMap.values()),
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}
