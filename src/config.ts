import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CHECKPOINT_AFTER_EVENTS,
  DEFAULT_MAX_PENDING_AGE_MINUTES,
} from "./auto-checkpoint.ts";

export const CONFIG_FILE_NAME = "task-memory.json";

export interface ConfiguredCheckpointModel {
  provider: string;
  id: string;
}

export interface TaskMemoryConfig {
  checkpointAfterEvents: number;
  maxPendingAgeMinutes: number;
  model?: ConfiguredCheckpointModel;
}

export const DEFAULT_CONFIG: TaskMemoryConfig = {
  checkpointAfterEvents: DEFAULT_CHECKPOINT_AFTER_EVENTS,
  maxPendingAgeMinutes: DEFAULT_MAX_PENDING_AGE_MINUTES,
};

export function loadConfig(cwd: string, agentDir = getAgentDir()): TaskMemoryConfig {
  return {
    ...DEFAULT_CONFIG,
    ...readConfig(join(agentDir, CONFIG_FILE_NAME)),
    ...readConfig(join(cwd, ".pi", CONFIG_FILE_NAME)),
  };
}

function readConfig(path: string): Partial<TaskMemoryConfig> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed) ? normalizeConfig(parsed) : {};
  } catch {
    return {};
  }
}

function normalizeConfig(value: Record<string, unknown>): Partial<TaskMemoryConfig> {
  const normalized: Partial<TaskMemoryConfig> = {};
  if (isPositiveInteger(value.checkpointAfterEvents)) {
    normalized.checkpointAfterEvents = value.checkpointAfterEvents;
  }
  if (isPositiveNumber(value.maxPendingAgeMinutes)) {
    normalized.maxPendingAgeMinutes = value.maxPendingAgeMinutes;
  }
  if (isRecord(value.model)) {
    const provider = typeof value.model.provider === "string" ? value.model.provider.trim() : "";
    const id = typeof value.model.id === "string" ? value.model.id.trim() : "";
    if (provider && id) normalized.model = { provider, id };
  }
  return normalized;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
