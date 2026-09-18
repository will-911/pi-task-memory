import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  AUTO_CHECKPOINT_RETRY_MS,
  planAutoCheckpoint,
  type AutoCheckpointReason,
} from "./auto-checkpoint.ts";
import { checkpoint } from "./checkpoint.ts";
import { DEFAULT_CONFIG, loadConfig, type TaskMemoryConfig } from "./config.ts";
import { buildTaskMemorySystemPrompt } from "./prompt.ts";
import {
  acquireLock,
  appendEvent,
  clearEvents,
  createTask,
  exists,
  fallbackRepoName,
  isLockProcessAlive,
  listTasks,
  pathsFor,
  pathsFromDir,
  readEvents,
  readLock,
  releaseLock,
  taskRoot,
  taskSlugFromReference,
  withDatePrefix,
} from "./storage.ts";
import type { EventCategory, EventStatus, RepositoryContext, TaskBinding, TaskEvent, TaskPaths } from "./types.ts";

const TOOL_NAME = "task_memory_event";
const BINDING_ENTRY = "pi-task-memory-binding";
const STATUS_KEY = "task-memory";

const EventParams = Type.Object({
  category: StringEnum(
    [
      "task_description",
      "repository_context",
      "design",
      "decision",
      "interface_contract",
      "verification",
      "current_state",
      "open_question",
      "blocker",
    ] as const,
    {
      description:
        "Choose the fact type: task_description=task scope, objective, or non-goal; repository_context=repository, branch, commit, or worktree context; design=confirmed architecture or behavior; decision=chosen option with rationale; interface_contract=exact API, schema, protocol, or compatibility contract; verification=condition, assumption, or risk that still needs verification, not a test result; current_state=current durable implementation truth, not a progress update; open_question=unresolved question; blocker=issue currently preventing completion.",
    },
  ),
  key: Type.String({
    minLength: 1,
    maxLength: 160,
    description: "Stable semantic key. Reuse it to update, replace, or delete the same fact.",
  }),
  summary: Type.String({
    minLength: 1,
    maxLength: 1000,
    description: "Concise statement of current truth. For delete, identify the claim being removed.",
  }),
  details: Type.Optional(Type.String({
    maxLength: 12_000,
    description: "Constraints or details needed to preserve the fact's meaning.",
  })),
  rationale: Type.Optional(Type.String({
    maxLength: 6000,
    description: "Why the fact or decision is correct.",
  })),
  evidence: Type.Optional(Type.Array(
    Type.String({ maxLength: 4000 }),
    { maxItems: 20, description: "References supporting the fact." },
  )),
  status: Type.Optional(StringEnum(
    ["accepted", "provisional", "rejected", "superseded"] as const,
    { description: "Fact status. Defaults to accepted." },
  )),
  operation: Type.Optional(StringEnum(
    ["upsert", "delete"] as const,
    { description: "Upsert records or updates the fact; delete removes it. Defaults to upsert." },
  )),
  repository: Type.Optional(
    Type.Object({
      name: Type.String({ minLength: 1, maxLength: 200, description: "Repository name." }),
      baselineBranch: Type.Optional(Type.String({ maxLength: 500, description: "Baseline branch." })),
      baselineCommit: Type.Optional(Type.String({ maxLength: 100, description: "Baseline commit." })),
      workingBranch: Type.Optional(Type.String({ maxLength: 500, description: "Working branch." })),
      worktree: Type.Optional(Type.String({ maxLength: 2000, description: "Worktree path." })),
    }, { description: "Structured repository context; required for repository_context upserts." }),
  ),
});

type EventParamsValue = {
  category: EventCategory;
  key: string;
  summary: string;
  details?: string;
  rationale?: string;
  evidence?: string[];
  status?: EventStatus;
  operation?: "upsert" | "delete";
  repository?: TaskEvent["repository"];
};

export default function taskMemoryExtension(pi: ExtensionAPI) {
  let activePaths: TaskPaths | undefined;
  let activeSlug: string | undefined;
  let config: TaskMemoryConfig = DEFAULT_CONFIG;

  let autoCheckpointTimer: ReturnType<typeof setTimeout> | undefined;
  let backgroundCheckpoint: Promise<void> | undefined;
  let backgroundCheckpointAbort: AbortController | undefined;
  let autoCheckpointGeneration = 0;
  let autoCheckpointScheduleRequest = 0;
  let autoCheckpointNotBefore = 0;
  let rerunAutoCheckpoint: AutoCheckpointReason | undefined;
  function sessionId(ctx: ExtensionContext): string {
    return ctx.sessionManager.getSessionId();
  }

  function checkpointModel(ctx: ExtensionContext): Model<any> | undefined {
    if (!config.model) return ctx.model;
    const model = ctx.modelRegistry.find(config.model.provider, config.model.id);
    if (!model) {
      throw new Error(
        `Configured checkpoint model '${config.model.provider}/${config.model.id}' is not available; pending events were kept.`,
      );
    }
    return model;
  }

  function setToolActive(active: boolean): void {
    const tools = pi.getActiveTools().filter((name) => name !== TOOL_NAME);
    if (active) tools.push(TOOL_NAME);
    pi.setActiveTools(tools);
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (activePaths && activeSlug) ctx.ui.setStatus(STATUS_KEY, `task:${activeSlug}`);
    else ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  function clearAutoCheckpointTimer(): void {
    if (autoCheckpointTimer) clearTimeout(autoCheckpointTimer);
    autoCheckpointTimer = undefined;
  }

  function requestAutoCheckpointSchedule(
    ctx: ExtensionContext,
    includeThreshold = false,
    minimumDelayMs = 0,
  ): void {
    const paths = activePaths;
    const generation = autoCheckpointGeneration;
    const scheduleRequest = ++autoCheckpointScheduleRequest;
    if (!paths) return;

    void readEvents(paths.events)
      .then((events) => {
        if (
          activePaths !== paths ||
          autoCheckpointGeneration !== generation ||
          autoCheckpointScheduleRequest !== scheduleRequest
        ) return;
        const plan = planAutoCheckpoint(
          events,
          Date.now(),
          includeThreshold,
          config.checkpointAfterEvents,
          config.maxPendingAgeMinutes,
        );
        clearAutoCheckpointTimer();
        if (!plan) return;
        const retryDelay = Math.max(0, autoCheckpointNotBefore - Date.now());
        const delay = Math.max(plan.delayMs, minimumDelayMs, retryDelay);
        autoCheckpointTimer = setTimeout(() => {
          autoCheckpointTimer = undefined;
          startBackgroundCheckpoint(ctx, plan.reason);
        }, delay);
        autoCheckpointTimer.unref();
      })
      .catch((error) => {
        if (activePaths === paths) {
          ctx.ui.notify(`Task memory could not schedule an automatic checkpoint: ${(error as Error).message}`, "warning");
        }
      });
  }

  function startBackgroundCheckpoint(ctx: ExtensionContext, reason: AutoCheckpointReason): void {
    const paths = activePaths;
    const slug = activeSlug;
    const generation = autoCheckpointGeneration;
    if (!paths || !slug) return;
    if (backgroundCheckpoint) {
      rerunAutoCheckpoint = reason;
      return;
    }

    clearAutoCheckpointTimer();
    const controller = new AbortController();
    backgroundCheckpointAbort = controller;
    ctx.ui.setStatus(STATUS_KEY, `task:${slug} checkpointing`);
    let failed = false;

    const tracked = Promise.resolve()
      .then(() => checkpoint(paths, ctx, { model: checkpointModel(ctx), signal: controller.signal }))
      .then(() => {
        if (activePaths === paths && autoCheckpointGeneration === generation) autoCheckpointNotBefore = 0;
      })
      .catch((error) => {
        failed = true;
        if (activePaths === paths && autoCheckpointGeneration === generation) {
          autoCheckpointNotBefore = Date.now() + AUTO_CHECKPOINT_RETRY_MS;
        }
        if (!controller.signal.aborted && activePaths === paths) {
          ctx.ui.notify(`Task memory automatic checkpoint (${reason}) failed: ${(error as Error).message}`, "warning");
        }
      })
      .finally(() => {
        if (backgroundCheckpoint === tracked) backgroundCheckpoint = undefined;
        if (backgroundCheckpointAbort === controller) backgroundCheckpointAbort = undefined;
        updateStatus(ctx);
        if (activePaths !== paths || autoCheckpointGeneration !== generation) return;
        const rerunReason = rerunAutoCheckpoint;
        rerunAutoCheckpoint = undefined;
        if (rerunReason && !failed) {
          startBackgroundCheckpoint(ctx, rerunReason);
          return;
        }
        requestAutoCheckpointSchedule(ctx, !failed, failed ? AUTO_CHECKPOINT_RETRY_MS : 0);
      });

    backgroundCheckpoint = tracked;
  }

  async function pauseAutoCheckpoint(abortRunning: boolean): Promise<void> {
    autoCheckpointGeneration += 1;
    autoCheckpointScheduleRequest += 1;
    rerunAutoCheckpoint = undefined;
    clearAutoCheckpointTimer();
    if (abortRunning) backgroundCheckpointAbort?.abort();
    const running = backgroundCheckpoint;
    if (running) await running;
    clearAutoCheckpointTimer();
  }

  function bind(paths: TaskPaths, slug: string, ctx: ExtensionContext, persist = true): void {
    autoCheckpointNotBefore = 0;
    activePaths = paths;
    activeSlug = slug;
    setToolActive(true);
    updateStatus(ctx);
    if (persist) {
      pi.appendEntry<TaskBinding>(BINDING_ENTRY, { version: 1, active: true, taskSlug: slug, taskDir: paths.dir });
    }
    requestAutoCheckpointSchedule(ctx);
  }

  function unbind(ctx: ExtensionContext, persist = true): void {
    autoCheckpointGeneration += 1;
    autoCheckpointScheduleRequest += 1;
    rerunAutoCheckpoint = undefined;
    clearAutoCheckpointTimer();
    backgroundCheckpointAbort?.abort();
    activePaths = undefined;
    activeSlug = undefined;
    setToolActive(false);
    updateStatus(ctx);
    if (persist) pi.appendEntry<TaskBinding>(BINDING_ENTRY, { version: 1, active: false });
  }

  async function detectRepository(cwd: string): Promise<RepositoryContext | undefined> {
    const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
    if (rootResult.code !== 0) return undefined;
    const root = rootResult.stdout.trim();
    const [branchResult, commitResult] = await Promise.all([
      pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, timeout: 5000 }),
      pi.exec("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5000 }),
    ]);
    if (commitResult.code !== 0) return undefined;
    const branch = branchResult.code === 0 ? branchResult.stdout.trim() : "HEAD";
    return {
      name: fallbackRepoName(root),
      baselineBranch: branch,
      baselineCommit: commitResult.stdout.trim(),
      workingBranch: branch,
      worktree: root,
    };
  }

  async function rootFor(cwd: string): Promise<{ root: string; repository?: RepositoryContext }> {
    const repository = await detectRepository(cwd);
    return { root: taskRoot(cwd, repository?.worktree), repository };
  }

  async function acquireWithConfirmation(paths: TaskPaths, slug: string, ctx: ExtensionContext): Promise<void> {
    const lock = await readLock(paths.lock);
    const lockFileExists = await exists(paths.lock);
    const ours = lock?.sessionId === sessionId(ctx) && lock.pid === process.pid;
    if (lock && !ours && isLockProcessAlive(lock)) {
      throw new Error(`Task '${slug}' is active in session ${lock.sessionId} (pid ${lock.pid} on ${lock.hostname}).`);
    }
    const stale = lockFileExists && !ours;
    if (stale) {
      if (!ctx.hasUI) throw new Error(`Task '${slug}' has a stale or unreadable lock; resume in an interactive UI to confirm takeover.`);
      const confirmed = await ctx.ui.confirm(
        "Take over stale task lock?",
        lock
          ? `The previous owner (session ${lock.sessionId}, pid ${lock.pid} on ${lock.hostname}) is no longer running.`
          : "The lock file is unreadable.",
      );
      if (!confirmed) throw new Error("Stale lock takeover cancelled.");
    }
    await acquireLock(paths.lock, slug, sessionId(ctx), stale);
  }

  async function runCheckpoint(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
    if (!activePaths) throw new Error("No task memory is active.");
    await pauseAutoCheckpoint(false);
    const paths = activePaths;
    try {
      const result = await checkpoint(paths, ctx, { model: checkpointModel(ctx), signal });
      autoCheckpointNotBefore = 0;
      if (result.merged === 0) ctx.ui.notify("Task memory: no pending events.", "info");
      else ctx.ui.notify(`Task memory: merged ${result.merged} event${result.merged === 1 ? "" : "s"}.`, "info");
    } finally {
      if (activePaths === paths) requestAutoCheckpointSchedule(ctx);
    }
  }

  async function stopTask(args: string, ctx: ExtensionContext): Promise<void> {
    if (!activePaths || !activeSlug) throw new Error("No task memory is active.");
    await pauseAutoCheckpoint(false);
    const pending = (await readEvents(activePaths.events)).length;
    let action = args.trim().toLowerCase();
    if (pending > 0 && !["merge", "keep", "discard"].includes(action)) {
      if (!ctx.hasUI) {
        requestAutoCheckpointSchedule(ctx);
        throw new Error("Pending events exist. Use '/task-memory stop merge', 'stop keep', or 'stop discard'.");
      }
      const selected = await ctx.ui.select(`Stop task '${activeSlug}' with ${pending} pending event(s)?`, [
        "Merge and stop",
        "Keep pending and stop",
        "Discard pending and stop",
        "Cancel",
      ]);
      if (!selected || selected === "Cancel") {
        requestAutoCheckpointSchedule(ctx);
        return;
      }
      action = selected.startsWith("Merge") ? "merge" : selected.startsWith("Keep") ? "keep" : "discard";
    }
    if (pending === 0) action = "keep";
    if (action === "merge") await runCheckpoint(ctx);
    if (action === "discard") await clearEvents(activePaths.events);

    const paths = activePaths;
    const slug = activeSlug;
    const released = await releaseLock(paths.lock, sessionId(ctx));
    unbind(ctx);
    ctx.ui.notify(
      `Task memory stopped: ${slug}${action === "keep" && pending > 0 ? ` (${pending} event(s) kept)` : ""}${released ? "" : " (lock was not owned)"}.`,
      released ? "info" : "warning",
    );
  }

  pi.registerTool({
    name: TOOL_NAME,
    label: "Task Memory Event",
    description: "Record, update, or delete one durable semantic fact for the active task. Reuse the same key for the same fact.",
    promptSnippet: "Record a durable task fact",
    parameters: EventParams,
    executionMode: "sequential",
    execute: async (_toolCallId, rawParams, _signal, _onUpdate, ctx) => {
      if (!activePaths || !activeSlug) {
        return {
          content: [{ type: "text", text: "Task memory is inactive. Ask the user to run /task-memory start <slug> or resume <slug>." }],
          details: undefined,
          isError: true,
        };
      }
      const params = rawParams as EventParamsValue;
      if (params.category === "repository_context" && params.operation !== "delete" && !params.repository) {
        return {
          content: [{ type: "text", text: "repository_context requires repository data unless operation=delete." }],
          details: undefined,
          isError: true,
        };
      }
      const event: TaskEvent = {
        id: randomUUID(),
        recordedAt: new Date().toISOString(),
        sessionId: sessionId(ctx),
        source: "assistant",
        category: params.category,
        key: params.category === "task_description" ? "task-description" : params.key.trim(),
        summary: params.summary.trim(),
        details: params.details?.trim() || undefined,
        rationale: params.rationale?.trim() || undefined,
        evidence: params.evidence?.map((item) => item.trim()).filter(Boolean),
        status: params.status ?? "accepted",
        operation: params.operation ?? "upsert",
        repository: params.repository,
      };
      await appendEvent(activePaths.events, event);
      requestAutoCheckpointSchedule(ctx);
      return {
        content: [{ type: "text", text: `Recorded ${event.category} '${event.key}' for task '${activeSlug}'.` }],
        details: { eventId: event.id, task: activeSlug, key: event.key },
      };
    },
  });

  pi.registerCommand("task-memory", {
    description: "Start, resume, checkpoint, inspect, or stop task memory",
    getArgumentCompletions: async (prefix) => {
      const commands = ["start", "resume", "checkpoint", "status", "list", "stop"];
      const tokens = prefix.trimStart().split(/\s+/);
      if (tokens.length <= 1) return commands.filter((item) => item.startsWith(tokens[0] ?? "")).map((item) => ({ value: item, label: item }));
      return null;
    },
    handler: async (args, ctx) => {
      config = loadConfig(ctx.cwd);
      try {
        const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const value = rest.join(" ");
        if (command === "start") {
          if (activePaths) throw new Error(`Task '${activeSlug}' is already active. Stop it first.`);
          const slug = withDatePrefix(value);
          const detected = await rootFor(ctx.cwd);
          const paths = await createTask(detected.root, slug, "", detected.repository);
          try {
            await acquireLock(paths.lock, slug, sessionId(ctx));
          } catch (error) {
            throw new Error(`Task was created but could not be locked: ${(error as Error).message}`);
          }
          bind(paths, slug, ctx);
          ctx.ui.notify(`Task memory started: ${slug}\n${paths.document}`, "info");
          return;
        }
        if (command === "resume") {
          if (activePaths) throw new Error(`Task '${activeSlug}' is already active. Stop it first.`);
          const slug = taskSlugFromReference(value);
          const detected = await rootFor(ctx.cwd);
          const paths = pathsFor(detected.root, slug);
          if (!(await exists(paths.document))) throw new Error(`Task '${slug}' does not exist under ${detected.root}.`);
          await acquireWithConfirmation(paths, slug, ctx);
          bind(paths, slug, ctx);
          ctx.ui.notify(`Task memory resumed: ${slug}`, "info");
          return;
        }
        if (command === "checkpoint") {
          await runCheckpoint(ctx);
          return;
        }
        if (command === "stop") {
          await stopTask(value, ctx);
          return;
        }
        if (command === "list") {
          const detected = await rootFor(ctx.cwd);
          const tasks = await listTasks(detected.root);
          ctx.ui.notify(tasks.length ? `Tasks under ${detected.root}:\n${tasks.map((task) => `- ${task}`).join("\n")}` : `No tasks under ${detected.root}.`, "info");
          return;
        }
        if (command === "status") {
          if (!activePaths || !activeSlug) {
            ctx.ui.notify("Task memory is inactive.", "info");
            return;
          }
          const [events, lock] = await Promise.all([readEvents(activePaths.events), readLock(activePaths.lock)]);
          ctx.ui.notify(
            [
              `Task: ${activeSlug}`,
              `Document: ${activePaths.document}`,
              `Pending events: ${events.length}`,
              `Checkpoint model: ${config.model ? `${config.model.provider}/${config.model.id}` : "session model"}`,
              `Automatic thresholds: ${config.checkpointAfterEvents} events / ${config.maxPendingAgeMinutes} minutes`,
              `Automatic checkpoint: ${backgroundCheckpoint ? "running" : autoCheckpointTimer ? "scheduled" : events.length ? "waiting for trigger" : "idle"}`,
              `Lock: ${lock ? `${lock.sessionId} / pid ${lock.pid}` : "missing"}`,
            ].join("\n"),
            "info",
          );
          return;
        }
        throw new Error("Usage: /task-memory start <slug> | resume <slug-or-path> | checkpoint | status | list | stop [merge|keep|discard]");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    unbind(ctx, false);
    // Reload/startup continue the same session. Session switches/forks require explicit /task-memory resume.
    if (_event.reason !== "reload" && _event.reason !== "startup") return;
    const branch = ctx.sessionManager.getBranch();
    let binding: TaskBinding | undefined;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type === "custom" && entry.customType === BINDING_ENTRY) {
        binding = entry.data as TaskBinding | undefined;
        break;
      }
    }
    if (!binding?.active || !binding.taskDir || !binding.taskSlug) return;
    const paths = pathsFromDir(binding.taskDir);
    if (!(await exists(paths.document))) {
      ctx.ui.notify(`Task memory binding is invalid; missing ${paths.document}.`, "warning");
      return;
    }
    try {
      const existingLock = await readLock(paths.lock);
      const sameSession = existingLock?.sessionId === sessionId(ctx);
      await acquireLock(paths.lock, binding.taskSlug, sessionId(ctx), sameSession);
      bind(paths, binding.taskSlug, ctx, false);
      ctx.ui.notify(`Task memory restored: ${binding.taskSlug}`, "info");
    } catch (error) {
      ctx.ui.notify(`Task memory not restored: ${(error as Error).message}`, "warning");
    }
  });


  pi.on("agent_settled", (_event, ctx) => {
    if (!activePaths) return;
    requestAutoCheckpointSchedule(ctx, true);
  });

  pi.on("before_agent_start", (event) => {
    if (!activeSlug) return;
    return { systemPrompt: buildTaskMemorySystemPrompt(event.systemPrompt, activeSlug) };
  });
  pi.on("session_before_compact", (_event, ctx) => {
    if (!activePaths) return;
    startBackgroundCheckpoint(ctx, "before-compaction");
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (!activePaths) return;
    await pauseAutoCheckpoint(true);
    if (event.reason === "reload") return;
    try {
      await releaseLock(activePaths.lock, sessionId(ctx));
    } finally {
      activePaths = undefined;
      activeSlug = undefined;
    }
  });
}
