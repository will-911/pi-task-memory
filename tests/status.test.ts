import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatTaskMemoryStatus, readTaskMemoryStats } from "../src/status.ts";
import { appendEvent, atomicWrite, clearEvents, createTask, pathsFor } from "../src/storage.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-memory-status-"));
  roots.push(root);
  return createTask(root, "test", "中文任务");
}

describe("task memory status", () => {
  it("formats category counts in stable order, omitting zero categories", () => {
    expect(formatTaskMemoryStatus("test", {
      pending: 3, categories: { design: 1, decision: 2, blocker: 0 },
    })).toBe("task:test · pending 3 [decision 2, design 1]");
    expect(formatTaskMemoryStatus("test", { pending: 0, categories: {} }, true))
      .toBe("task:test · pending 0 · merging");
    expect(formatTaskMemoryStatus("test", { pending: 0, categories: {} }))
      .toBe("task:test · pending 0");
    expect(formatTaskMemoryStatus("test", undefined, true))
      .toBe("task:test · merging");
  });

  it("counts queued events by category, including repeated keys and deletes", async () => {
    const paths = await fixture();
    await atomicWrite(paths.lock, "large lock metadata".repeat(100));
    await appendEvent(paths.events, {
      id: "1", recordedAt: new Date().toISOString(), sessionId: "test",
      source: "assistant", category: "decision", key: "design",
      summary: "确认设计", status: "accepted",
    });
    await appendEvent(paths.events, {
      id: "2", recordedAt: new Date().toISOString(), sessionId: "test",
      source: "assistant", category: "decision", key: "design",
      summary: "删除设计", status: "accepted", operation: "delete",
    });
    await appendEvent(paths.events, {
      id: "3", recordedAt: new Date().toISOString(), sessionId: "test",
      source: "assistant", category: "design", key: "architecture",
      summary: "确认架构", status: "accepted",
    });
    expect(await readTaskMemoryStats(paths)).toEqual({
      pending: 3, categories: { decision: 2, design: 1 },
    });
    await atomicWrite(paths.document, "# Task\n\n## Decisions\n\n确认设计\n");
    await clearEvents(paths.events);
    expect(await readTaskMemoryStats(paths)).toEqual({ pending: 0, categories: {} });
  });

  it("handles missing storage files", async () => {
    const paths = await fixture();
    expect(await readTaskMemoryStats(pathsFor(paths.dir, "missing")))
      .toEqual({ pending: 0, categories: {} });
    await rm(paths.events);
    expect(await readTaskMemoryStats(paths))
      .toEqual({ pending: 0, categories: {} });
  });

  it("does not report misleading counts for a corrupt queue", async () => {
    const paths = await fixture();
    await atomicWrite(paths.events, "invalid json\n");
    await expect(readTaskMemoryStats(paths)).rejects.toThrow("Invalid pending event JSON");
  });
});
