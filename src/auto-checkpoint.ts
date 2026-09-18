import type { TaskEvent } from "./types.ts";

export const DEFAULT_CHECKPOINT_AFTER_EVENTS = 6;
export const DEFAULT_MAX_PENDING_AGE_MINUTES = 10;
export const AUTO_CHECKPOINT_RETRY_MS = 60_000;

export type AutoCheckpointReason = "event-threshold" | "max-age" | "before-compaction";

export interface AutoCheckpointPlan {
  reason: AutoCheckpointReason;
  delayMs: number;
}

/**
 * Select the next automatic checkpoint trigger. Threshold checks can be held
 * until agent_settled so a tool call never makes the current agent turn wait.
 */
export function planAutoCheckpoint(
  events: readonly TaskEvent[],
  now = Date.now(),
  includeThreshold = true,
  checkpointAfterEvents = DEFAULT_CHECKPOINT_AFTER_EVENTS,
  maxPendingAgeMinutes = DEFAULT_MAX_PENDING_AGE_MINUTES,
): AutoCheckpointPlan | undefined {
  if (events.length === 0) return undefined;
  if (includeThreshold && events.length >= checkpointAfterEvents) {
    return { reason: "event-threshold", delayMs: 0 };
  }

  const times = events.map((event) => Date.parse(event.recordedAt)).filter(Number.isFinite);
  const oldest = times.length > 0 ? Math.min(...times) : now;
  const maxPendingAgeMs = maxPendingAgeMinutes * 60_000;
  return { reason: "max-age", delayMs: Math.max(0, oldest + maxPendingAgeMs - now) };
}
