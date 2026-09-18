import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  appendEvent,
  consumeEvents,
  createTask,
  pathsFor,
  readEvents,
  releaseLock,
  taskRoot,
  validateSlug,
  withDatePrefix,
} from "../src/storage.ts";
import type { TaskEvent } from "../src/types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-task-memory-"));
  temporaryDirectories.push(path);
  return path;
}

function event(key: string): TaskEvent {
  return {
    id: key,
    recordedAt: "2026-09-18T00:00:00.000Z",
    sessionId: "session-a",
    source: "assistant",
    category: "decision",
    key,
    summary: `Decision ${key}`,
    status: "accepted",
    operation: "upsert",
  };
}

describe("task storage", () => {
  it("validates safe slugs", () => {
    expect(validateSlug("20260918-api-contract")).toBe("20260918-api-contract");
    expect(() => validateSlug("../escape")).toThrow(/Task slug/);
    expect(() => validateSlug("Has Caps")).toThrow(/Task slug/);
  });

  it("adds a local date prefix without duplicating an existing one", () => {
    const date = new Date(2026, 7, 10);
    expect(withDatePrefix("interpreter-record", date)).toBe("20260810-interpreter-record");
    expect(withDatePrefix("20260809-existing", date)).toBe("20260809-existing");
  });

  it("places tasks directly under the project tasks directory", () => {
    expect(taskRoot("/workspace/project")).toBe(join("/workspace/project", "tasks"));
    expect(taskRoot("/workspace/subdirectory", "/workspace/project")).toBe(join("/workspace/project", "tasks"));
  });
  it("creates a task without placeholder sections", async () => {
    const root = await temporaryRoot();
    const paths = await createTask(root, "contract-fix", "", {
      name: "service",
      baselineBranch: "main",
      baselineCommit: "abc123",
      workingBranch: "feature/contract",
      worktree: "/work/service",
    });
    const document = await readFile(paths.document, "utf8");
    expect(document).toContain("# Task: contract-fix");
    expect(document).toContain("## Repositories");
    expect(document).not.toContain("TBD");
    await expect(createTask(root, "contract-fix", "")).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("persists events and keeps concurrent events after a checkpoint transaction", async () => {
    const root = await temporaryRoot();
    const paths = pathsFor(root, "task-a");
    await appendEvent(paths.events, event("old"));

    let releaseOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const consume = consumeEvents(paths.events, async (events) => {
      expect(events.map((item) => item.key)).toEqual(["old"]);
      await operationGate;
    });
    const append = appendEvent(paths.events, event("new"));
    releaseOperation();
    await Promise.all([consume, append]);

    expect((await readEvents(paths.events)).map((item) => item.key)).toEqual(["new"]);
  });

  it("does not clear pending events when checkpoint processing fails", async () => {
    const root = await temporaryRoot();
    const paths = pathsFor(root, "task-a");
    await appendEvent(paths.events, event("keep"));
    await expect(
      consumeEvents(paths.events, async () => {
        throw new Error("model failed");
      }),
    ).rejects.toThrow("model failed");
    expect((await readEvents(paths.events)).map((item) => item.key)).toEqual(["keep"]);
  });

  it("only releases a lock owned by the current session", async () => {
    const root = await temporaryRoot();
    const paths = pathsFor(root, "task-a");
    await acquireLock(paths.lock, "task-a", "session-a");
    expect(await releaseLock(paths.lock, "session-b")).toBe(false);
    expect(await releaseLock(paths.lock, "session-a")).toBe(true);
  });

  it("refuses malformed JSONL instead of silently losing it", async () => {
    const root = await temporaryRoot();
    const paths = pathsFor(root, "task-a");
    await appendEvent(paths.events, event("seed"));
    await writeFile(paths.events, "not-json\n", "utf8");
    await expect(readEvents(paths.events)).rejects.toThrow(/line 1/);
  });
});
