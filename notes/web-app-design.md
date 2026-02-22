# Web App 架构决策记录

## 产品概述

基于 chat 内容生成思维导图的 web app。服务端使用 pi-mono 的 agent 框架，需要实现 PM Skill、Creator Skill 等多种角色技能。

---

## 已确定的架构决策

### 1. 服务端直接使用 Agent 类

```typescript
import { Agent, getModel } from "@mariozechner/pi-agent";

const agent = new Agent({
  initialState: { model: getModel("anthropic", "claude-sonnet-4-5-20250929") },
});
agent.setSystemPrompt(systemPrompt);
agent.setTools(tools);
await agent.prompt(userInput);
```

不使用 proxy 模式，不使用 coding-agent 的 CLI 层。

### 2. Skill 系统：不依赖文件系统，应用层自行管理

pi-mono 的 skill 系统（`loadSkills`、`loadSkillsFromDir`、`formatSkillsForPrompt`）是为 CLI 设计的，依赖本地文件系统扫描 SKILL.md。Web app 不需要也不应该使用它。

Skill 的本质就是 **一段指令文本**，通过 tool 按需注入到对话中。

---

## Skill 实现方案

### 核心设计：渐进式披露 + 全部固定

> **关键决策**：system prompt 和 tools 在整个对话生命周期中保持不变，最大化 prompt caching。
>
> Anthropic prompt caching 是前缀匹配，API 请求顺序为 system → tools → messages。
> 任何对 system prompt 或 tools 的修改都会导致缓存失效。
>
> 因此：
> - system prompt 只放所有 skill 的 name + description（初始化时一次性写入）
> - tools 全局注册，不按 skill 动态切换
> - skill 的完整 instructions 通过 `load_skill` tool 按需加载，进入 messages 而非 system prompt
> - 切换 skill 不触碰 system prompt 和 tools，缓存始终命中

```
请求结构（整个对话过程中前缀不变）：

  system（固定）: base prompt + <available_skills> 所有 skill 的 name/description </available_skills>
  tools（固定）:  所有工具 + load_skill + load_reference
  messages:       用户对话 + tool results（skill instructions 在这里）
                  ↑ 只有这部分在增长，前缀始终命中缓存
```

### 核心类型定义

```typescript
interface WebSkill {
  name: string;
  description: string;     // 简短描述，放进 system prompt（固定不变）
  instructions: string;    // 完整指令，通过 load_skill tool 按需返回
  references: WebReference[]; // 参考资料，通过 load_reference tool 按需返回
}

interface WebReference {
  name: string;
  description: string;
  content: string | (() => Promise<string>);  // 支持懒加载
}
```

### 与 Agent Skills 标准的映射关系

| Agent Skills 标准 | pi-mono CLI 实现 | Web App 实现 |
|---|---|---|
| SKILL.md 指令 | agent 用 read tool 读文件 | agent 用 `load_skill` tool 从内存/数据库获取 |
| `scripts/` | agent 自主用 bash tool 执行（无框架支持） | **注册为 AgentTool**（类型安全、可控） |
| `references/` | agent 自主用 read tool 读取（无框架支持） | **`load_reference` tool 按需返回** |
| `assets/` | agent 自主用 read tool 读取 | **通过 API 获取** |
| `allowed-tools` | 未实现 | **instructions 中文字指引 agent 使用哪些工具** |

### 构建 System Prompt（初始化时一次性设置）

```typescript
function buildSystemPrompt(basePrompt: string, skills: WebSkill[]): string {
  if (skills.length === 0) return basePrompt;

  const skillsXml = skills.map(s => `  <skill>
    <name>${s.name}</name>
    <description>${s.description}</description>
  </skill>`).join("\n");

  return `${basePrompt}

你拥有以下专业技能。当用户的任务匹配某个技能时，先用 load_skill 工具加载该技能的完整指令，然后严格按指令执行。

<available_skills>
${skillsXml}
</available_skills>`;
}

// 初始化时设置，后续不再修改
agent.setSystemPrompt(buildSystemPrompt(BASE_PROMPT, ALL_SKILLS));
agent.setTools(ALL_TOOLS);
```

### 工具注册

```typescript
// 所有工具统一注册，整个对话过程不变
const ALL_TOOLS: AgentTool[] = [
  // 基础工具
  generateMindmapTool,

  // PM Skill 相关
  searchRequirementsTool,
  analyzePriorityTool,

  // Creator Skill 相关
  searchReferencesTool,
  generateOutlineTool,

  // 技能加载工具（替代 CLI 的 read tool 读 SKILL.md）
  loadSkillTool,
  loadReferenceTool,
];
```

### load_skill 工具（替代文件系统的 read tool）

```typescript
const skillRegistry = new Map<string, WebSkill>(
  ALL_SKILLS.map(s => [s.name, s])
);

const loadSkillTool: AgentTool = {
  name: "load_skill",
  label: "加载技能",
  description: "根据技能名称加载完整的技能指令。在执行匹配的任务前必须先加载对应技能。",
  parameters: Type.Object({
    name: Type.String({ description: "技能名称" }),
  }),
  execute: async (_id, { name }) => {
    const skill = skillRegistry.get(name);
    if (!skill) return { content: [{ type: "text", text: `未知技能: ${name}` }], details: {} };
    return {
      content: [{ type: "text", text: skill.instructions }],
      details: { skillName: name },
    };
  },
};
```

### load_reference 工具

```typescript
const loadReferenceTool: AgentTool = {
  name: "load_reference",
  label: "加载参考资料",
  description: "按名称加载某个技能的参考资料",
  parameters: Type.Object({
    skill: Type.String({ description: "技能名称" }),
    name: Type.String({ description: "参考资料名称" }),
  }),
  execute: async (_id, { skill: skillName, name }) => {
    const skill = skillRegistry.get(skillName);
    if (!skill) return { content: [{ type: "text", text: "未知技能" }], details: {} };
    const ref = skill.references.find(r => r.name === name);
    if (!ref) return { content: [{ type: "text", text: "未找到参考资料" }], details: {} };
    const content = typeof ref.content === 'function' ? await ref.content() : ref.content;
    return {
      content: [{ type: "text", text: content }],
      details: { skillName, refName: name },
    };
  },
};
```

### Skill 激活流程

```
用户: "帮我分析一下这个产品需求"
                ↓
agent 看到 system prompt 中 pm-skill 的描述匹配
                ↓
agent 调用 load_skill(name: "pm-skill")
                ↓
tool result 返回完整 instructions（进入 messages，不碰 system prompt）
                ↓
agent 按 instructions 执行，使用 search_requirements、generate_mindmap 等工具
                ↓
如需参考资料，调用 load_reference(skill: "pm-skill", name: "prd-template")
```

**整个过程 system prompt 和 tools 不变，prompt caching 始终命中。**

---

## PM Skill 示例

```typescript
const pmSkill: WebSkill = {
  name: "pm-skill",
  description: "产品需求分析和 PRD 撰写。当用户讨论产品需求、功能规划时使用。",
  instructions: `
你现在是一个资深产品经理。请按以下框架分析需求：
1. 用户场景分析
2. 核心问题定义
3. 功能拆解
4. 优先级排序（P0/P1/P2）
5. 输出思维导图节点结构（JSON 格式）

可用工具：
- search_requirements: 搜索已有需求库
- analyze_priority: 分析优先级矩阵
- generate_mindmap: 生成思维导图节点

输出的思维导图节点必须符合以下 JSON Schema:
{ "title": string, "children": [{ "title": string, "children": [...] }] }

如需参考模板，用 load_reference 加载 "prd-template"。
  `.trim(),

  references: [
    { name: "prd-template", description: "PRD 文档模板", content: "## 背景\n## 目标用户\n..." },
    { name: "past-prds", description: "历史 PRD 文档", content: () => db.prds.getRecent() },
  ],
};
```

---

## 存储方案

**当前建议：先硬编码在代码里**（如上面的常量），等需要动态管理时再迁移到数据库。Skill 的本质就是一段提示词文本，不需要过早引入复杂性。

未来如果需要数据库存储，skill 的 `instructions` 和 `references` 存为文本字段，`tools` 的 `execute` 函数无法序列化，保持代码注册。

---

## 待决策事项

- [ ] 思维导图输出格式（JSON Schema 具体定义）
- [ ] 多 skill 场景下的切换策略（用户手动选 vs agent 自动判断）
- [ ] skill 的 instructions 是否需要版本管理
- [ ] 前端如何展示 skill 激活状态
- [ ] 工具总数超过 15 个时是否需要按 skill 分组（牺牲缓存换准确性）
