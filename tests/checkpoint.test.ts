import { describe, expect, it } from "vitest";
import {
  applySectionPatches,
  buildPrompt,
  impactedSections,
  parseSectionPatchResponse,
  validateDocument,
} from "../src/checkpoint.ts";
import type { TaskEvent } from "../src/types.ts";

const existing = `# Task: api-contract

## Task Description

Repair the API contract.

## Repositories

### service
- Baseline: \`main\` @ \`abc123\`

## Design

- Keep transport independent.

## Decisions

- Use JSON.

## Interfaces / Contracts

- POST /records accepts requestId.
`;

function event(category: TaskEvent["category"], key: string = category): TaskEvent {
  return {
    id: key,
    recordedAt: "2026-09-18T00:00:00.000Z",
    sessionId: "session-a",
    source: "assistant",
    category,
    key,
    summary: `Update ${key}`,
    status: "accepted",
  };
}

describe("section patch checkpoint", () => {
  it("maps and deduplicates event categories in canonical section order", () => {
    expect(impactedSections([event("blocker"), event("decision"), event("open_question")])).toEqual([
      "Decisions",
      "Open Questions / Blockers",
    ]);
  });

  it("maps architecture and flowchart events in canonical order", () => {
    expect(impactedSections([
      event("decision"), event("architecture_and_flowcharts", "system-flow"),
      event("design"), event("architecture_and_flowcharts", "components"),
    ])).toEqual(["Design", "Architecture and Flowcharts", "Decisions"]);
  });

  it("round-trips Mermaid diagrams through targeted patches", () => {
    const diagram = "```mermaid\nflowchart TD\n  Agent --> EventStore\n  EventStore --> Checkpoint\n```";
    const architectureEvent = {
      ...event("architecture_and_flowcharts", "system-flow"),
      details: diagram,
    };
    const prompt = buildPrompt(existing, [architectureEvent]);
    expect(prompt).toContain('"targetSections": [\n    "Architecture and Flowcharts"');
    expect(prompt).toContain(JSON.stringify(diagram));
    expect(prompt).not.toContain("Keep transport independent");

    const patches = parseSectionPatchResponse(JSON.stringify({
      sections: { "Architecture and Flowcharts": diagram },
    }), impactedSections([architectureEvent]));
    const updated = applySectionPatches(existing, patches);
    validateDocument(updated, existing);
    expect(updated).toContain(`## Architecture and Flowcharts\n\n${diagram}`);
    expect(updated.indexOf("## Design")).toBeLessThan(updated.indexOf("## Architecture and Flowcharts"));
    expect(updated.indexOf("## Architecture and Flowcharts")).toBeLessThan(updated.indexOf("## Decisions"));
    expect(updated).toContain("## Design\n\n- Keep transport independent.");
    expect(updated).toContain("## Decisions\n\n- Use JSON.");

    const nextPrompt = buildPrompt(updated, [architectureEvent]);
    expect(nextPrompt).toContain('"Architecture and Flowcharts":');
    expect(nextPrompt).toContain(JSON.stringify(diagram));
    expect(applySectionPatches(updated, { Decisions: "- Use MessagePack." })).toContain(diagram);
    expect(applySectionPatches(updated, { "Architecture and Flowcharts": null })).toBe(existing);
  });

  it("sends only task context and affected sections", () => {
    const prompt = buildPrompt(existing, [event("decision", "wire-format")]);
    expect(prompt).toContain("<checkpoint_input_json>");
    expect(prompt).toContain('"targetSections": [\n    "Decisions"');
    expect(prompt).toContain('"Task Description": "Repair the API contract."');
    expect(prompt).toContain('"Repositories":');
    expect(prompt).toContain('"Decisions": "- Use JSON."');
    expect(prompt).not.toContain("Keep transport independent");
    expect(prompt).not.toContain("POST /records accepts requestId");
    expect(prompt).toContain('"key": "wire-format"');
  });

  it("parses a strict JSON section patch with an optional JSON fence", () => {
    const patch = parseSectionPatchResponse(
      '```json\n{"sections":{"Decisions":"- Use MessagePack."}}\n```',
      ["Decisions"],
    );
    expect(patch).toEqual({ Decisions: "- Use MessagePack." });
  });

  it("rejects malformed, missing, extra, and heading-bearing patches", () => {
    expect(() => parseSectionPatchResponse("not json", ["Decisions"])).toThrow(/invalid JSON/);
    expect(() => parseSectionPatchResponse('{"sections":{}}', ["Decisions"])).toThrow(/omitted target/);
    expect(() =>
      parseSectionPatchResponse('{"sections":{"Decisions":"A","Design":"B"}}', ["Decisions"]),
    ).toThrow(/non-target/);
    expect(() =>
      parseSectionPatchResponse('{"sections":{"Decisions":"## Decisions\\nA"}}', ["Decisions"]),
    ).toThrow(/top-level heading/);
  });

  it("updates only target sections and preserves unaffected content", () => {
    const updated = applySectionPatches(existing, { Decisions: "- Use MessagePack." });
    expect(updated).toContain("## Design\n\n- Keep transport independent.");
    expect(updated).toContain("## Decisions\n\n- Use MessagePack.");
    expect(updated).toContain("## Interfaces / Contracts\n\n- POST /records accepts requestId.");
    expect(updated).not.toContain("- Use JSON.");
  });

  it("adds and removes sections in canonical order", () => {
    const added = applySectionPatches(existing, {
      Verification: "- Verify retries cannot create duplicate records.",
      Decisions: null,
    });
    expect(added).not.toContain("## Decisions");
    expect(added.indexOf("## Interfaces / Contracts")).toBeLessThan(added.indexOf("## Verification"));
  });

  it("rejects title changes, forbidden sections, duplicates and bad order", () => {
    expect(() => validateDocument("# Task: other\n", existing)).toThrow(/title/);
    expect(() => validateDocument("# Task: api-contract\n\n## Timeline\n\n- edit\n", existing)).toThrow(/forbidden/);
    expect(() =>
      validateDocument("# Task: api-contract\n\n## Decisions\n\nA\n\n## Decisions\n\nB\n", existing),
    ).toThrow(/duplicated/);
    expect(() =>
      validateDocument("# Task: api-contract\n\n## Verification\n\nA\n\n## Design\n\nB\n", existing),
    ).toThrow(/out of order/);
  });
});
