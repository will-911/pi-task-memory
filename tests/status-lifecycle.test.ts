import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import taskMemoryExtension from "../src/index.ts";
import { atomicWrite, clearEvents } from "../src/storage.ts";
import type { TaskPaths } from "../src/types.ts";

const { merge } = vi.hoisted(() => ({ merge: vi.fn() }));
vi.mock("../src/checkpoint.ts", () => ({ checkpoint: merge }));

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  merge.mockReset();
});

it("refreshes the above-editor widget on start, recording, checkpoint, and stop", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "task-memory-footer-"));
  const handlers = new Map<string, Function>();
  let command: any;
  let tool: any;
  let tools: string[] = [];
  const setWidget = vi.fn();
  const setStatus = vi.fn();
  const ctx = {
    cwd, hasUI: false,
    model: {},
    sessionManager: { getSessionId: () => "test" },
    ui: { setWidget, setStatus, notify: vi.fn() },
  } as unknown as ExtensionContext;
  const pi = {
    registerTool: (value: any) => { tool = value; },
    registerCommand: (_name: string, value: any) => { command = value; },
    on: (event: string, handler: Function) => { handlers.set(event, handler); },
    getActiveTools: () => tools,
    setActiveTools: (value: string[]) => { tools = value; },
    getThinkingLevel: () => "off",
    appendEntry: vi.fn(),
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  } as unknown as ExtensionAPI;
  taskMemoryExtension(pi);
  cleanup = async () => {
    await handlers.get("session_shutdown")?.({ reason: "exit" }, ctx);
    await rm(cwd, { recursive: true, force: true });
  };
  const status = () => setWidget.mock.calls.at(-1)?.[1]?.[0];

  await command.handler("start demo", ctx);
  await vi.waitFor(() => expect(status()).toMatch(/task:.*demo · pending 0$/));
  const record = () => tool.execute("call", {
    category: "decision", key: "choice", summary: "Confirmed choice",
  }, undefined, undefined, ctx);
  await record();
  expect(status()).toMatch(/ · pending 1 \[decision 1\]$/);

  let finishMerge!: () => void;
  merge.mockImplementation(async (paths: TaskPaths) => {
    await new Promise<void>((resolve) => { finishMerge = resolve; });
    await atomicWrite(paths.document, "# Updated task\n");
    await clearEvents(paths.events);
    return { merged: 1 };
  });
  const manual = command.handler("checkpoint", ctx);
  await vi.waitFor(() => expect(status()).toContain(" · merging"));
  await vi.waitFor(() => expect(finishMerge).toBeTypeOf("function"));
  finishMerge();
  await manual;
  expect(status()).toMatch(/ · pending 0$/);

  await record();
  finishMerge = undefined as any;
  handlers.get("session_before_compact")?.({}, ctx);
  await vi.waitFor(() => expect(status()).toContain(" · merging"));
  await vi.waitFor(() => expect(finishMerge).toBeTypeOf("function"));
  finishMerge();
  await vi.waitFor(() => expect(status()).toMatch(/ · pending 0$/));

  await command.handler("stop keep", ctx);
  expect(status()).toBeUndefined();
  expect(setWidget.mock.calls.at(-1)?.[1]).toBeUndefined();
  expect(setWidget.mock.calls.every(([key, , options]) =>
    key === "task-memory" && options?.placement === "aboveEditor",
  )).toBe(true);
  expect(setStatus).not.toHaveBeenCalled();
});
