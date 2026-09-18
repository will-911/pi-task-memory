# pi-task-memory

Pi 的可选 Task 知识记录扩展。它保存设计、决策、接口契约、需要验证的关键点和当前事实，供长任务跨 Session、跨 AI 继续；它不是计划、TODO、测试报告或工作流水工具。

## 特性

- 默认关闭；仅在用户显式 `start` 或 `resume` 后启用记录工具。
- Semantic Event 立即持久化，正式 `TASK.md` 仅在 checkpoint 时低频更新。
- 自动 checkpoint 支持事件数量阈值和 pending 最大年龄；这些触发在后台异步执行，不阻塞主对话。
- 上下文压缩前会发起后台 checkpoint，但不等待模型合并完成，不阻塞 Pi 压缩。
- Checkpoint 按 Semantic Event 只发送和返回受影响章节，由扩展在本地组装完整文档，避免重复生成整个 Markdown。
- 启用期间通过 system prompt 注入何时使用 `task_memory_event` 的简短指导；正式 `TASK.md` 和 pending event 队列均仅由扩展内部管理，不进入工作模型上下文。
- 相同 semantic key 会在文档中更新同一事实，而不是形成时间线。
- `Verification` 只记录需要验证的关键点及条件；测试命令、执行过程和结果保存在其他测试系统中。
- 每个 Session 同时绑定一个 Task；同一 Task 使用单写者锁。
- 启动时记录当前 Git 仓库、分支、HEAD 和工作树；可通过语义事件补充多个仓库。

## 安装

在本仓库上一级目录执行：

```bash
pi install ./pi-task-memory
```

开发时也可以临时加载：

```bash
pi -e ./pi-task-memory
```

> Pi package 扩展拥有完整系统权限，安装前应审查源码。

## 使用

```text
/task-memory start <slug>
/task-memory resume <slug>
/task-memory status
/task-memory list
/task-memory checkpoint
/task-memory stop
```

- `start`：自动添加本地日期前缀，并在当前 Git 根目录（非 Git 目录则为当前目录）的 `tasks/<YYYYMMDD>-<slug>/` 原子创建 Task；已经带有 8 位日期前缀时不会重复添加。
- `resume`：使用包含日期前缀的完整 slug 显式恢复已有 Task；有效锁会拒绝并发写入，失效锁需确认后接管。
- `checkpoint`：使用配置的 checkpoint 模型（未配置时使用当前 Session 模型）只合并受影响章节，再由扩展本地组装 `TASK.md`。
- `stop`：有 pending events 时选择合并、保留、丢弃或取消。
- 非交互模式下可使用 `stop merge`、`stop keep` 或 `stop discard`。

启用后，AI 获得 `task_memory_event` 工具。你可以直接告诉 AI：

```text
把刚才确认的幂等约束记录到 task memory。
修正之前的 repository baseline。
删除已经失效的接口结论。
```

## 自动 Checkpoint

启用 Task Memory 后，以下条件会自动尝试合并 pending events：

- pending events 达到 `checkpointAfterEvents` 条：在当前 Agent 完全结束后立即后台执行。
- 最早的 pending event 已等待 `maxPendingAgeMinutes` 分钟：后台执行。
- 上下文即将压缩：发起后台 checkpoint。

三种方式都不会被 Pi 的事件处理器 `await`，因此不会阻塞主对话或上下文压缩。后台 checkpoint 仍通过事件存储队列与 Event 写入串行化；失败时保留 pending events，并在至少等待 60 秒后重试。

`/task-memory status` 会显示自动 checkpoint 当前是 `idle`、`scheduled`、`waiting for trigger` 或 `running`。

## 配置

配置使用独立文件：全局 `~/.pi/agent/task-memory.json` 或项目级 `.pi/task-memory.json`；项目级配置覆盖全局配置：

```json
{
  "model": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-5"
  },
  "checkpointAfterEvents": 6,
  "maxPendingAgeMinutes": 10
}
```

- `model`：checkpoint 专用模型。省略时使用当前 Session 模型；配置的模型不可用时 checkpoint 失败并保留 pending events。
- `checkpointAfterEvents`：事件数触发阈值，默认 `6`。
- `maxPendingAgeMinutes`：最早 pending event 的最大等待分钟数，默认 `10`。
- 不使用 token 数作为 checkpoint 触发条件。

## 文件布局

```text
<project-root>/tasks/<YYYYMMDD>-<slug>/
├── TASK.md
└── .task-memory/
    ├── events.jsonl
    └── lock.json       # Task 活跃期间存在
```

`TASK.md` 只表达当前有效知识，允许的章节为：

- Task Description
- Repositories
- Design
- Decisions
- Interfaces / Contracts
- Verification
- Current State
- Open Questions / Blockers

没有内容的章节不会生成；不会生成 Timeline、Next Steps、TODO、实现日志或工具调用流水。

## 开发验证

```bash
npm install
npm run typecheck
npm test
```
