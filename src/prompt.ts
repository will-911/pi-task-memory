const TASK_MEMORY_SECTION = (taskDir: string): string =>
  `- current task: \`${taskDir}\`.\n- Call \`task_memory_event\` as soon as a fact becomes stable and worth carrying across sessions or AIs, such as a confirmed design, architecture or flowchart, decision with rationale, exact interface contract, repository context, required verification point, current state, or genuine open question or blocker.\n- Do not modify Task Memory files directly; persist facts through \`task_memory_event\`.`;

export function buildTaskMemoryAddPrompt(guidance: string): string {
  return [
    "The user explicitly requested one semantic event for the active Task Memory.",
    "Use the user's guidance and established conversation facts to call task_memory_event once. Choose the appropriate category and stable semantic key; reuse an existing key when updating the same fact. Preserve supplied diagrams and exact contracts in details.",
    "Do not invent missing facts. If the request is insufficient or ambiguous, ask for clarification instead of recording an unsupported event. Do not modify Task Memory files directly or run a checkpoint. Briefly confirm only after the tool succeeds.",
    "User guidance:",
    guidance,
  ].join("\n\n");
}

export function buildTaskMemorySystemPromptSection(taskDir: string): string {
  return TASK_MEMORY_SECTION(taskDir);
}

/**
 * Legacy full-prompt form retained for callers that need to render the complete text.
 * Pi 0.86+ extensions should prefer the structured section form above.
 */
export function buildTaskMemorySystemPrompt(basePrompt: string, taskDir: string): string {
  return `${basePrompt}\n\n${TASK_MEMORY_SECTION(taskDir)}`;
}
