import { describe, expect, it } from "vitest";
import { buildTaskMemorySystemPrompt } from "../src/prompt.ts";

describe("task memory system prompt", () => {
  it("appends concise tool-use guidance", () => {
    const result = buildTaskMemorySystemPrompt("Base system prompt", "20260918-test");

    expect(result).toBe(
      "Base system prompt\n\nTask Memory:\n" +
        "- Active task: `20260918-test`.\n" +
        "- Call `task_memory_event` as soon as a fact becomes stable and worth carrying across sessions or AIs, such as a confirmed design, decision with rationale, exact interface contract, repository context, required verification point, current state, or genuine open question or blocker.\n" +
        "- Do not modify Task Memory files directly; persist facts through `task_memory_event`.",
    );
  });

  it("does not expose the task document or pending event queue", () => {
    const result = buildTaskMemorySystemPrompt("base", "task");

    expect(result).not.toContain("# Task:");
    expect(result).not.toContain("Pending semantic events");
    expect(result).not.toContain("events.jsonl");
    expect(result).not.toContain("task_memory_document");
  });
});
