import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import taskMemoryExtension from "../src/index.ts";
import { buildTaskMemoryAddPrompt } from "../src/prompt.ts";
import { pathsFromDir, readDocument, readEvents } from "../src/storage.ts";
import type { TaskBinding } from "../src/types.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-add-"));
  const handlers = new Map<string, Function>();
  let command: any;
  let tool: any;
  let tools: string[] = [];
  const sendUserMessage = vi.fn();
  const appendEntry = vi.fn();
  const notify = vi.fn();
  const isIdle = vi.fn(() => true);
  const ctx = {
    cwd, hasUI: false, isIdle,
    sessionManager: { getSessionId: () => "test-add" },
    ui: { setWidget: vi.fn(), notify },
  } as unknown as ExtensionContext;
  const pi = {
    registerTool: (value: any) => { tool = value; },
    registerCommand: (_name: string, value: any) => { command = value; },
    on: (event: string, handler: Function) => { handlers.set(event, handler); },
    getActiveTools: () => tools,
    setActiveTools: (value: string[]) => { tools = value; },
    appendEntry, sendUserMessage,
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  } as unknown as ExtensionAPI;
  taskMemoryExtension(pi);
  cleanups.push(async () => {
    await handlers.get("session_shutdown")?.({ reason: "exit" }, ctx);
    await rm(cwd, { recursive: true, force: true });
  });
  return {
    command, tool, ctx, sendUserMessage, notify, isIdle,
    start: async () => {
      await command.handler("start demo", ctx);
      const binding = appendEntry.mock.calls.at(-1)?.[1] as TaskBinding;
      expect(binding.active).toBe(true);
      return pathsFromDir(binding.taskDir!);
    },
  };
}

describe("task-memory add", () => {
  it("rejects requests when inactive or missing guidance", async () => {
    const { command, ctx, sendUserMessage, notify, start } = await fixture();
    await command.handler("add 记录刚才的决策", ctx);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("inactive"), "error");
    expect(sendUserMessage).not.toHaveBeenCalled();

    await start();
    await command.handler("add   \n", ctx);
    expect(notify).toHaveBeenLastCalledWith("Usage: /task-memory add <guidance>", "error");
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("prompts the idle agent without directly recording or checkpointing", async () => {
    const { command, tool, ctx, sendUserMessage, start } = await fixture();
    const paths = await start();
    const original = await readDocument(paths.document);
    const guidance = "记录 architecture_and_flowcharts 事件：\n```mermaid\nflowchart TD\n  Agent --> EventStore\n```";
    await command.handler(`add ${guidance}`, ctx);
    expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith(buildTaskMemoryAddPrompt(guidance));
    expect(sendUserMessage.mock.calls[0][0]).toContain(guidance);
    expect(await readEvents(paths.events)).toEqual([]);
    expect(await readDocument(paths.document)).toBe(original);

    // Persistence still goes through the agent-facing tool, not the command.
    await tool.execute("event", {
      category: "architecture_and_flowcharts", key: "event-flow",
      summary: "Agent persists events to the event store", details: guidance,
    }, undefined, undefined, ctx);
    expect(await readEvents(paths.events)).toHaveLength(1);
    expect(await readDocument(paths.document)).toBe(original);
  });

  it("queues a follow-up when the agent is busy", async () => {
    const { command, ctx, sendUserMessage, notify, isIdle, start } = await fixture();
    const paths = await start();
    isIdle.mockReturnValue(false);
    await command.handler("add 记录刚才确认的幂等约束", ctx);
    expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith(
      buildTaskMemoryAddPrompt("记录刚才确认的幂等约束"), { deliverAs: "followUp" },
    );
    expect(notify).toHaveBeenLastCalledWith("Task memory event request queued for the agent.", "info");
    expect(await readEvents(paths.events)).toEqual([]);
  });

  it("includes add in completion and usage help", async () => {
    const { command, ctx, notify } = await fixture();
    expect(await command.getArgumentCompletions("a")).toEqual([{ value: "add", label: "add" }]);
    expect(await command.getArgumentCompletions("add ")).toBeNull();
    await command.handler("unknown", ctx);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("add <guidance>"), "error");
  });

  it("guides one tool call with clarification and no direct file edits", () => {
    const prompt = buildTaskMemoryAddPrompt("更新已有设计");
    expect(prompt).toContain("call task_memory_event once");
    expect(prompt).toContain("reuse an existing key");
    expect(prompt).toContain("ask for clarification");
    expect(prompt).toContain("Do not modify Task Memory files directly or run a checkpoint");
    expect(prompt).toContain("Briefly confirm only after the tool succeeds");
    expect(prompt).toContain("User guidance:\n\n更新已有设计");
  });
});
