import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { LockRecord, RepositoryContext, TaskEvent, TaskPaths } from "./types.ts";

const mutationQueues = new Map<string, Promise<unknown>>();

export function validateSlug(value: string): string {
  const slug = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(slug)) {
    throw new Error("Task slug must be 1-80 lowercase letters, digits, '.', '_' or '-' and start with a letter/digit.");
  }
  return slug;
}

export function taskSlugFromReference(value: string): string {
  const reference = value.trim().replace(/[\\/]+$/, "");
  const slug = reference.split(/[\\/]/).at(-1) ?? "";
  return validateSlug(slug);
}

export function withDatePrefix(value: string, now = new Date()): string {
  const slug = validateSlug(value);
  if (/^\d{8}-/.test(slug)) return slug;
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return validateSlug(`${year}${month}${day}-${slug}`);
}

export function taskRoot(cwd: string, gitRoot?: string): string {
  return join(gitRoot ?? resolve(cwd), "tasks");
}

export function pathsFor(root: string, slug: string): TaskPaths {
  const dir = join(root, validateSlug(slug));
  const internalDir = join(dir, ".task-memory");
  return {
    dir,
    document: join(dir, "TASK.md"),
    internalDir,
    events: join(internalDir, "events.jsonl"),
    lock: join(internalDir, "lock.json"),
  };
}

export function pathsFromDir(taskDir: string): TaskPaths {
  const dir = resolve(taskDir);
  const internalDir = join(dir, ".task-memory");
  return {
    dir,
    document: join(dir, "TASK.md"),
    internalDir,
    events: join(internalDir, "events.jsonl"),
    lock: join(internalDir, "lock.json"),
  };
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

export async function createTask(
  root: string,
  slug: string,
  description: string,
  repository?: RepositoryContext,
): Promise<TaskPaths> {
  const paths = pathsFor(root, slug);
  await mkdir(root, { recursive: true });
  await mkdir(paths.dir); // Deliberately non-recursive: duplicate task creation fails atomically.
  try {
    await mkdir(paths.internalDir);
    await atomicWrite(paths.events, "");
    const lines = [`# Task: ${slug}`, ""];
    if (description.trim()) lines.push("## Task Description", "", description.trim(), "");
    if (repository) {
      lines.push(
        "## Repositories",
        "",
        `### ${repository.name}`,
        `- Baseline: \`${repository.baselineBranch}\` @ \`${repository.baselineCommit}\``,
        `- Working branch: \`${repository.workingBranch}\``,
        `- Worktree: \`${repository.worktree}\``,
        "",
      );
    }
    await atomicWrite(paths.document, `${lines.join("\n").trimEnd()}\n`);
    return paths;
  } catch (error) {
    await rm(paths.dir, { recursive: true, force: true });
    throw error;
  }
}

export async function listTasks(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const tasks: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const doc = join(root, entry.name, "TASK.md");
      if (await exists(doc)) tasks.push(entry.name);
    }
    return tasks.sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}


/** Serialize a checkpoint with event appends. Events are cleared only after the operation succeeds. */
export async function consumeEvents<T>(
  path: string,
  operation: (events: TaskEvent[]) => Promise<T>,
): Promise<{ events: TaskEvent[]; result?: T }> {
  return enqueue(path, async () => {
    const events = await readEvents(path);
    if (events.length === 0) return { events };
    const result = await operation(events);
    await atomicWrite(path, "");
    return { events, result };
  });
}
export async function appendEvent(path: string, event: TaskEvent): Promise<void> {
  await enqueue(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

export async function readEvents(path: string): Promise<TaskEvent[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line) as TaskEvent;
      } catch {
        throw new Error(`Invalid pending event JSON at line ${index + 1}; refusing to discard data.`);
      }
    });
}

export async function clearEvents(path: string): Promise<void> {
  await enqueue(path, () => atomicWrite(path, ""));
}

async function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  mutationQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (mutationQueues.get(key) === current) mutationQueues.delete(key);
  }
}

export async function readLock(path: string): Promise<LockRecord | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LockRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function isLockProcessAlive(lock: LockRecord): boolean {
  if (lock.hostname !== hostname()) return true; // A remote process cannot be checked safely.
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function acquireLock(
  path: string,
  taskSlug: string,
  sessionId: string,
  forceStale = false,
): Promise<LockRecord> {
  await mkdir(dirname(path), { recursive: true });
  const existing = await readLock(path);
  if (existing) {
    const ours = existing.sessionId === sessionId && existing.pid === process.pid && existing.hostname === hostname();
    if (ours) return existing;
    if (isLockProcessAlive(existing)) {
      throw new Error(`Task is locked by session ${existing.sessionId} (pid ${existing.pid} on ${existing.hostname}).`);
    }
    if (!forceStale) throw new Error("Task has a stale lock; takeover confirmation is required.");
    await rm(path, { force: true });
  } else if (await exists(path)) {
    if (!forceStale) throw new Error("Task has an unreadable lock; takeover confirmation is required.");
    await rm(path, { force: true });
  }

  const record: LockRecord = {
    version: 1,
    taskSlug,
    sessionId,
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
  };
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return record;
}

export async function releaseLock(path: string, sessionId: string): Promise<boolean> {
  const lock = await readLock(path);
  if (!lock) return false;
  if (lock.sessionId !== sessionId || lock.pid !== process.pid || lock.hostname !== hostname()) return false;
  await rm(path);
  return true;
}

export async function readDocument(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export function formatRepository(repo: RepositoryContext): string {
  return `${repo.name}:${repo.baselineBranch}@${repo.baselineCommit}:${repo.workingBranch}:${repo.worktree}`;
}

export function fallbackRepoName(root: string): string {
  return basename(root);
}
