const TASK_MEMORY_SECTION = (taskDir: string): string =>
  `- current task: \`${taskDir}\`.\n- Call \`task_memory_event\` as soon as a fact becomes stable and worth carrying across sessions or AIs, such as a confirmed design, decision with rationale, exact interface contract, repository context, required verification point, current state, or genuine open question or blocker.\n- Do not modify Task Memory files directly; persist facts through \`task_memory_event\`.`;

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
