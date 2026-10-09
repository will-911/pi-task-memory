import { readEvents } from "./storage.ts";
import type { EventCategory, TaskPaths } from "./types.ts";

export interface TaskMemoryStats {
  pending: number;
  categories: Partial<Record<EventCategory, number>>;
}

/** Count queued events by category, including updates and deletes (not unique facts). */
export async function readTaskMemoryStats(paths: TaskPaths): Promise<TaskMemoryStats> {
  const events = await readEvents(paths.events);
  const categories: TaskMemoryStats["categories"] = {};
  for (const event of events) {
    categories[event.category] = (categories[event.category] ?? 0) + 1;
  }
  return { pending: events.length, categories };
}

export function formatTaskMemoryStatus(
  slug: string,
  stats?: TaskMemoryStats,
  checkpointing = false,
): string {
  const categories = stats
    ? Object.entries(stats.categories)
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, count]) => `${category} ${count}`)
    : [];
  return [
    `task:${slug}`,
    stats ? `pending ${stats.pending}${categories.length ? ` [${categories.join(", ")}]` : ""}` : undefined,
    checkpointing ? "merging" : undefined,
  ].filter(Boolean).join(" · ");
}
