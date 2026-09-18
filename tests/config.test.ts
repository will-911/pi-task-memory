import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_FILE_NAME, DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-task-memory-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeConfig(root: string, value: unknown, project = false): void {
  const directory = project ? join(root, ".pi") : root;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, CONFIG_FILE_NAME), JSON.stringify(value));
}

describe("task memory configuration", () => {
  it("uses defaults when no configuration exists", () => {
    expect(loadConfig(temporaryDirectory(), temporaryDirectory())).toEqual(DEFAULT_CONFIG);
  });

  it("loads a dedicated checkpoint model and project threshold overrides", () => {
    const cwd = temporaryDirectory();
    const agentDir = temporaryDirectory();
    writeConfig(agentDir, {
      checkpointAfterEvents: 12,
      maxPendingAgeMinutes: 20,
      model: { provider: "anthropic", id: "global-model" },
    });
    writeConfig(
      cwd,
      {
        checkpointAfterEvents: 6,
        maxPendingAgeMinutes: 10,
        model: { provider: "openai", id: "checkpoint-model", thinking: "low" },
      },
      true,
    );

    expect(loadConfig(cwd, agentDir)).toEqual({
      checkpointAfterEvents: 6,
      maxPendingAgeMinutes: 10,
      model: { provider: "openai", id: "checkpoint-model", thinking: "low" },
    });
  });

  it("ignores an invalid checkpoint thinking level", () => {
    const cwd = temporaryDirectory();
    const agentDir = temporaryDirectory();
    writeConfig(agentDir, {
      model: { provider: "openai", id: "checkpoint-model", thinking: "turbo" },
    });

    expect(loadConfig(cwd, agentDir)).toEqual({
      ...DEFAULT_CONFIG,
      model: { provider: "openai", id: "checkpoint-model" },
    });
  });

  it("ignores invalid values", () => {
    const cwd = temporaryDirectory();
    const agentDir = temporaryDirectory();
    writeConfig(agentDir, {
      checkpointAfterEvents: 0,
      maxPendingAgeMinutes: "10",
      model: { provider: "", id: "missing-provider" },
    });

    expect(loadConfig(cwd, agentDir)).toEqual(DEFAULT_CONFIG);
  });
});
