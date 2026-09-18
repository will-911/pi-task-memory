import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHECKPOINT_AFTER_EVENTS,
  DEFAULT_MAX_PENDING_AGE_MINUTES,
  planAutoCheckpoint,
} from "../src/auto-checkpoint.ts";
import type { TaskEvent } from "../src/types.ts";

const now = Date.parse("2026-09-18T12:00:00.000Z");

function eventsAt(...times: number[]): TaskEvent[] {
  return times.map((time, index) => ({
    id: String(index),
    recordedAt: new Date(time).toISOString(),
    sessionId: "session-a",
    source: "assistant",
    category: "decision",
    key: `decision-${index}`,
    summary: `Decision ${index}`,
    status: "accepted",
  }));
}

describe("automatic checkpoint planning", () => {
  it("does not schedule without pending events", () => {
    expect(planAutoCheckpoint([], now)).toBeUndefined();
  });

  it("triggers at the event threshold when the agent is settled", () => {
    const events = eventsAt(...Array.from({ length: DEFAULT_CHECKPOINT_AFTER_EVENTS }, () => now));
    expect(planAutoCheckpoint(events, now, true)).toEqual({ reason: "event-threshold", delayMs: 0 });
  });

  it("can defer the threshold until agent_settled while retaining the maximum-age deadline", () => {
    const events = eventsAt(...Array.from({ length: DEFAULT_CHECKPOINT_AFTER_EVENTS }, () => now));
    expect(planAutoCheckpoint(events, now, false)).toEqual({
      reason: "max-age",
      delayMs: DEFAULT_MAX_PENDING_AGE_MINUTES * 60_000,
    });
  });

  it("uses maximum pending age when it occurs first", () => {
    const maxAgeMs = DEFAULT_MAX_PENDING_AGE_MINUTES * 60_000;
    const events = eventsAt(now - maxAgeMs + 5_000, now);
    expect(planAutoCheckpoint(events, now)).toEqual({ reason: "max-age", delayMs: 5_000 });
  });

  it("runs immediately once maximum pending age has elapsed", () => {
    const maxAgeMs = DEFAULT_MAX_PENDING_AGE_MINUTES * 60_000;
    expect(planAutoCheckpoint(eventsAt(now - maxAgeMs), now)).toEqual({
      reason: "max-age",
      delayMs: 0,
    });
  });

  it("uses configured event and age thresholds", () => {
    const events = eventsAt(now - 2 * 60_000, now, now);
    expect(planAutoCheckpoint(events, now, true, 3, 30)).toEqual({
      reason: "event-threshold",
      delayMs: 0,
    });
    expect(planAutoCheckpoint(events.slice(0, 2), now, true, 3, 5)).toEqual({
      reason: "max-age",
      delayMs: 3 * 60_000,
    });
  });
});
