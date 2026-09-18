export const TASK_SECTIONS = [
  "Task Description",
  "Repositories",
  "Design",
  "Decisions",
  "Interfaces / Contracts",
  "Verification",
  "Current State",
  "Open Questions / Blockers",
] as const;

export type EventCategory =
  | "task_description"
  | "repository_context"
  | "design"
  | "decision"
  | "interface_contract"
  | "verification"
  | "current_state"
  | "open_question"
  | "blocker";

export type EventStatus = "accepted" | "provisional" | "rejected" | "superseded";

export interface TaskEvent {
  id: string;
  recordedAt: string;
  sessionId: string;
  source: "assistant";
  category: EventCategory;
  /** Stable semantic identity. Reusing it updates/replaces the prior fact. */
  key: string;
  summary: string;
  details?: string;
  rationale?: string;
  evidence?: string[];
  status: EventStatus;
  operation?: "upsert" | "delete";
  repository?: {
    name: string;
    baselineBranch?: string;
    baselineCommit?: string;
    workingBranch?: string;
    worktree?: string;
  };
}

export interface LockRecord {
  version: 1;
  taskSlug: string;
  sessionId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export interface TaskBinding {
  version: 1;
  active: boolean;
  taskSlug?: string;
  taskDir?: string;
}

export interface RepositoryContext {
  name: string;
  baselineBranch: string;
  baselineCommit: string;
  workingBranch: string;
  worktree: string;
}

export interface TaskPaths {
  dir: string;
  document: string;
  internalDir: string;
  events: string;
  lock: string;
}
