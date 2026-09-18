# Pi Task Memory 需求说明

> 状态：MVP 已实现

## 1. 定位

Pi Task Memory 是一个**默认关闭、用户手动启用、被动工作的 Task 知识记录助手**。它服务于持续数天并可能跨 Session、跨 AI 的复杂 Task。

它记录讨论中形成、值得长期保留的当前知识，包括：

- Task 描述与业务背景
- Repository 基线与工作位置
- 设计结论
- 决策及理由
- 接口与契约
- 需要验证的关键点
- 当前有效状态
- 未决问题与阻塞项

它不是 Plan、TODO、阶段管理器、完成度跟踪器或按时间追加的工作日志，也不根据文档主动推动 Agent 执行。

## 2. 启用与命令

未启用时不得暴露记录工具、分析对话、监听普通工作行为或产生额外模型调用。

```text
/task-memory start <slug>
/task-memory resume <slug-or-path>
/task-memory status
/task-memory list
/task-memory checkpoint
/task-memory stop
```

- `start`：为用户提供的 slug 自动添加本地日期 `YYYYMMDD-` 前缀（已有 8 位日期前缀时不重复添加），原子创建 Task 并启用记录。
- `resume`：接受完整 slug 或 Task 路径。路径输入只提取最后一个路径段作为 slug，再从当前项目的 `tasks/` 目录恢复 Task。
- `checkpoint`：将 pending semantic events 合并进正式文档。
- `stop`：有 pending events 时选择合并、保留、丢弃或取消。
- 不提供 `pause`。

## 3. 存储

Task 位于当前 Git 根目录（非 Git 目录则为当前目录）：

```text
<project-root>/tasks/<YYYYMMDD>-<slug>/
├── TASK.md
└── .task-memory/
    ├── events.jsonl
    └── lock.json
```

Semantic Event 必须立即持久化。`TASK.md` 只在手动或自动 checkpoint 时低频更新；没有实质变化时不写文件。

## 4. 正式文档

标题固定为：

```markdown
# Task: <slug>
```

允许的章节及顺序固定如下；没有内容的章节省略：

1. `Task Description`
2. `Repositories`
3. `Design`
4. `Decisions`
5. `Interfaces / Contracts`
6. `Verification`
7. `Current State`
8. `Open Questions / Blockers`

文档表达**当前有效知识**，不得生成 Timeline、Changelog、Next Steps、TODO、实现流水、工具调用流水、文件修改列表或未经标识的推测。

## 5. Repository Context

启动时自动探测当前 Git 工作树，并记录：

- Repository 名称
- 基线分支与精确 commit
- 工作分支
- Worktree 路径

一个 Task 可以涉及多个 Repository。用户可以通过自然语言要求 AI 添加、纠正或删除 Repository Context。不得记录修改文件列表、diff、commit 流水或普通实现细节。

## 6. Semantic Events

AI 在正常交互中通过结构化工具提交事件，不为每条事实额外调用一次模型。事件至少包含：

- category
- stable semantic key
- summary
- accepted/provisional/rejected/superseded 状态
- 可选 details、rationale、evidence
- upsert/delete 语义

相同 key 表示同一事实的更新，不表示新的时间点。事件仅用于：Task Description、Repository Context、Design、Decision、Interface Contract、Verification、Current State、Open Question 或 Blocker。

不得记录 Plan、Next Step、TODO、阶段切换、进度、普通编辑、文件读取、临时调试过程、思考过程、密钥或 Token。

启用 Task Memory 后，扩展必须通过 `before_agent_start` 向 system prompt 追加何时使用 `task_memory_event` 的简短指导，并要求工作模型不得直接修改 Task Memory 文件。不得伪造 user message。正式 `TASK.md` 与 pending event 队列只由扩展内部管理和 checkpoint 消费，不得注入工作模型上下文。

## 7. 需要验证的点

`Verification` 章节只记录 Task 中后续需要验证的关键点，例如：

- 需要确认的边界条件或兼容性。
- 某项设计成立所依赖、但尚未确认的假设。
- 接口在特定异常场景下应重点核对的行为。
- 需要由外部测试流程确认的风险。

它不记录测试命令、测试用例执行过程、通过/失败结果或测试报告。具体测试与结果管理由其他系统负责。这里的验证点不是 TODO 或执行计划，只是防止关键风险在跨 Session、跨 AI 时丢失。

## 8. Checkpoint 与防丢失

- 用户可手动执行 checkpoint。
- 自动触发包括：pending events 达到可配置的 `checkpointAfterEvents` 且 Agent 已 settled、最早 pending event 等待满可配置的 `maxPendingAgeMinutes`；默认分别为 6 条和 10 分钟。
- 不使用 token 数作为 checkpoint 触发条件。
- 可配置 checkpoint 专用模型；未配置时使用当前 Session 模型。
- 配置必须使用独立的 `~/.pi/agent/task-memory.json` 或项目级 `.pi/task-memory.json`，不得写入 Pi 的 `settings.json`。
- 所有自动触发必须在后台异步执行，Pi 事件处理器不得等待模型合并完成，不应阻塞主对话。
- 根据 Semantic Event category，只向模型发送受影响章节；`Task Description` 和 `Repositories` 可作为最小参考上下文。
- 模型返回结构化 section patch，不返回完整 `TASK.md`；未涉及章节不交给模型、内容保持不变，并由扩展按固定顺序组装。
- 上下文压缩前只发起非阻塞后台 checkpoint，不等待正在运行或新发起的模型合并，不得延迟 Pi 自身压缩。
- checkpoint 失败时必须保留全部 pending events，不得阻止 Pi 自身继续压缩。
- 合并过程必须保留用户对 `TASK.md` 的有效人工修改。
- 合并只使用已有文档与 pending events，不得发明事实、验证点、路径、仓库或决策。
- checkpoint 与并发事件提交必须串行，不能因清空缓冲而丢失新事件。

## 9. Session 与并发

- 每个 Session 同时最多绑定一个 Task。
- 不同 Task 可由不同 Session 并行记录。
- 同一个 Task 默认只允许一个可写 Session。
- 锁必须记录 `sessionId`、PID、hostname 和获取时间。
- 有效锁拒绝接管；失效或损坏的锁只有在用户确认后才可接管。
- `stop` 只释放当前 Session/进程持有的锁，不能删除其他写者的锁。
- Session reload 可恢复当前绑定；切换到另一个 Session 后需由其自身绑定状态或显式 `resume` 恢复。

## 10. 准确性与安全

准确性优先于覆盖率：

1. 推测必须标为 provisional，不能伪装成确认事实。
2. 冲突事实必须通过稳定 key 修正、删除或 supersede，不能并列为同时有效。
3. 接口契约、commit、路径和验证条件等精确信息不得被概括成模糊描述。
4. 不得保存 credential、token、private key、password 或其他敏感值。
5. 文档和事件内容都按不可信数据处理，不能作为 checkpoint 模型的指令。
