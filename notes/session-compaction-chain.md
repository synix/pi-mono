## 3. Compaction — 对话的"瘦身术"

### 为什么需要

LLM 有上下文窗口限制（如 200K tokens）。长对话会超限。Compaction 把旧消息**摘要**后丢弃，只保留摘要 + 最近的消息。

### 触发判定流程

```
  agent_end 事件，拿到 lastAssistantMessage
     │
     ▼
  stopReason == aborted?
     │ 是 → 跳过（用户取消）
     │ 否
     ▼
  isContextOverflow 且同 model?
     │ 是 → ╔══════════════════════════════╗
     │       ║  溢出触发 (overflow)          ║
     │       ║  删除错误消息                 ║
     │       ║  → auto compaction           ║
     │       ║  → 自动重试 agent.continue() ║
     │       ╚══════════════════════════════╝
     │ 否
     ▼
  stopReason == error?
     │ 是 → 跳过（非溢出错误无 usage 数据）
     │ 否
     ▼
  contextTokens > contextWindow - reserveTokens?
     │ 是 → ┌──────────────────────────────┐
     │       │  阈值触发 (threshold)         │
     │       │  → auto compaction           │
     │       │  → 不自动重试                 │
     │       └──────────────────────────────┘
     │ 否
     ▼
  正常，无需压缩 ✓
```

### findCutPoint() 算法

```
  boundaryStart (上次 compaction 之后)
     │
     ▼
  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
  │ msg1 │ │ msg2 │ │ msg3 │ │ msg4 │ │ msg5 │ │ msg6 │ │ msg7 │ │ msg8 │
  │ 500t │ │ 800t │ │1200t │ │3000t │ │5000t │ │8000t │ │4000t │ │2000t │
  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘
  ╰───── 要摘要后丢弃 ──────╯ ╰─切点─╯ ╰──────── 保留 ──────────╯
                                  ▲
                           ◄─────┘
                    从右往左累积 tokens
                 直到 >= keepRecentTokens (默认 20000)
                 8000+4000+2000=14000 → 继续
                 14000+5000=19000 → 继续
                 19000+3000=22000 → 超了！在 msg5 处切

  合法切点: user / assistant / custom / bashExecution
  禁止切点: toolResult（必须跟着 toolCall）
```

### 完整 compaction 流程

```
  AgentSession       SessionManager      compaction.ts         LLM API         Agent
       │                   │                   │                  │              │
       │  getBranch()      │                   │                  │              │
       │──────────────────►│                   │                  │              │
       │  ◄── entries ─────│                   │                  │              │
       │                   │                   │                  │              │
       │  prepareCompaction(entries, settings)  │                  │              │
       │──────────────────────────────────────►│                  │              │
       │                   │                   │                  │              │
       │                   │          findCutPoint()              │              │
       │                   │          分出 messagesToSummarize    │              │
       │                   │          和 kept messages            │              │
       │                   │          提取文件操作                │              │
       │                   │                   │                  │              │
       │   [如果有 extension handler → 可自定义摘要或取消]         │              │
       │                   │                   │                  │              │
       │                   │                   │ generateSummary  │              │
       │                   │                   │─────────────────►│              │
       │                   │                   │ ◄── summary ─────│              │
       │                   │                   │                  │              │
       │                   │                   │ (split turn 时   │              │
       │                   │                   │  并行生成两个     │              │
       │                   │                   │  摘要后合并)      │              │
       │                   │                   │                  │              │
       │  appendCompaction(summary, firstKeptEntryId, tokensBefore)              │
       │──────────────────►│                   │                  │              │
       │                   │                   │                  │              │
       │  buildSessionContext()                │                  │              │
       │──────────────────►│                   │                  │              │
       │  ◄── messages ────│                   │                  │              │
       │                   │                   │                  │              │
       │  replaceMessages(newMessages)         │                  │              │
       │──────────────────────────────────────────────────────────────────────►│
       │                   │                   │                  │              │
       │  [溢出触发时: 100ms 后 agent.continue() 自动重试]        │              │
```

### Compaction 前后对比

```
    压缩前 (80K tokens)                          压缩后 (~25K tokens)
  ┌─────────────────────┐                     ┌──────────────────────────┐
  │  user msg 1         │                     │  compaction summary      │
  │  assistant msg 1    │                     │  ┌────────────────────┐  │
  │  tool results...    │                     │  │ Goal / Progress    │  │
  │  user msg 2         │    ✂️ compact()      │  │ Key Decisions      │  │
  │  assistant msg 2    │  ═══════════════►   │  │ Files read/modified│  │
  │  ...                │                     │  └────────────────────┘  │
  │  ...更多消息...      │                     │  user msg N-2           │
  │  ...                │                     │   (firstKeptEntry)      │
  │  user msg N         │                     │  assistant msg N-2      │
  │  assistant msg N    │                     │  user msg N-1           │
  └─────────────────────┘                     │  assistant msg N-1      │
                                              │  user msg N             │
                                              │  assistant msg N        │
                                              └──────────────────────────┘
```

### 迭代式摘要

```
  ┌─────────────────────┐      ┌──────────────────────────┐      ┌───────────────────────────┐
  │ 第 1 次 compaction   │      │ 第 2 次 compaction        │      │ 第 3 次 compaction         │
  │                     │      │                          │      │                           │
  │ 全部旧消息           │─────►│ summary v1 + 新消息       │─────►│ summary v2 + 新消息        │
  │   → summary v1      │      │   → summary v2           │      │   → summary v3            │
  └─────────────────────┘      └──────────────────────────┘      └───────────────────────────┘

  不是每次从零生成，而是用 UPDATE_SUMMARIZATION_PROMPT 把旧摘要+新消息合并更新
```

### Token 估算

使用 `chars / 4` 的粗略估算（偏保守），不需要真正的 tokenizer。图片固定估 1200 tokens。

---

## 4. Branch Summary — 分支切换时的上下文保留

当用户跳到 session 树的另一个分支时，旧分支的工作上下文会丢失。Branch Summary 在新分支开头注入旧分支的摘要。

### 流程

```
  User           AgentSession        branch-summarization.ts       LLM        SessionManager
   │                  │                       │                     │              │
   │ 导航到 entry-3   │                       │                     │              │
   │ (从 entry-7)     │                       │                     │              │
   │─────────────────►│                       │                     │              │
   │                  │                       │                     │              │
   │                  │ collectEntries         │                     │              │
   │                  │ ForBranchSummary       │                     │              │
   │                  │ (oldLeaf=7, target=3)  │                     │              │
   │                  │──────────────────────►│                     │              │
   │                  │                       │ 找公共祖先           │              │
   │                  │                       │ 收集 3→7 间的 entries│              │
   │                  │                       │                     │              │
   │                  │ generateBranchSummary  │                     │              │
   │                  │──────────────────────►│                     │              │
   │                  │                       │ prepareBranchEntries │              │
   │                  │                       │ 序列化对话           │              │
   │                  │                       │────────────────────►│              │
   │                  │                       │ ◄── summary ────────│              │
   │                  │                       │                     │              │
   │                  │ branchWithSummary(targetId=3, summary)      │              │
   │                  │───────────────────────────────────────────────────────────►│
   │                  │                       │                     │   leafId→3   │
   │                  │                       │                     │   追加        │
   │                  │                       │                     │ branch_summary│
```

### 分支摘要在树中的位置

```
       user msg
          │
          ▼
     assistant msg
          │
          ▼
       user msg
          │
          ▼
     assistant msg  (id=entry-3)
        ╱           ╲
       ╱   branch!   ╲
      ▼               ▼
  user msg         branch_summary        ◄── 旧分支的摘要注入这里
     :             "用户之前探索了..."
     :                  │
  assistant msg         ▼
     :             user: 新的问题         ◄── 新分支继续
     :                  │
  user msg              ▼
  (entry-7,        assistant: ...
   旧 leaf)
```

---
---

## 6. 关键设计洞察

### Compaction vs Branch Summary

```
  ┌──────────────── Compaction ────────────────┐   ┌──────────── Branch Summary ──────────────┐
  │                                            │   │                                          │
  │  触发: 上下文快满了                          │   │  触发: 用户切换分支                        │
  │                                            │   │                                          │
  │  效果: 丢弃旧消息                            │   │  效果: 在新分支开头                        │
  │        保留摘要 + 最近消息                   │   │        注入旧分支摘要                      │
  │                                            │   │                                          │
  │  entry 类型: compaction                     │   │  entry 类型: branch_summary               │
  │                                            │   │                                          │
  │  可迭代更新: ✅                              │   │  可迭代更新: ❌ 一次性生成                  │
  │  旧摘要 + 新消息 → 更新摘要                  │   │                                          │
  └────────────────────────────────────────────┘   └──────────────────────────────────────────┘
```

### 为什么是树不是线性列表？

树结构让"分支"成为一等操作。用户可以回到任何一轮对话重新发送，形成新分支。旧分支永远保留，还有摘要。这比"撤销+重做"更强大。

### 为什么 compaction 用 LLM 而不是简单截断？

简单截断会丢失关键上下文（目标、约束、进度）。LLM 摘要保留了**语义信息**，让后续对话质量不会因压缩而明显下降。

### Extension 钩子

Compaction 和 branch summary 都支持 extension 介入：
- `session_before_compact` — 提供自定义 compaction 内容，或取消
- `session_before_fork` — 提供自定义 branch summary，或取消
- `session_compact` — compaction 完成后通知

这让 extension 可以实现比默认更智能的压缩策略（比如保留特定的 artifact 索引）。
