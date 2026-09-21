const TASK_MEMORY_SECTION = (taskSlug: string): string =>
  `Task Memory:\n- Active task: \`${taskSlug}\`.\n- Call \`task_memory_event\` as soon as a fact becomes stable and worth carrying across sessions or AIs, such as a confirmed design, decision with rationale, exact interface contract, repository context, required verification point, current state, or genuine open question or blocker.\n- Do not modify Task Memory files directly; persist facts through \`task_memory_event\`.`;

export function buildTaskMemorySystemPromptSection(taskSlug: string): string {
  return TASK_MEMORY_SECTION(taskSlug);
}

/**
 * Legacy full-prompt form retained for callers that need to render the complete text.
 * Pi 0.86+ extensions should prefer the structured section form above.
 */
export function buildTaskMemorySystemPrompt(basePrompt: string, taskSlug: string): string {
  return `${basePrompt}\n\n${TASK_MEMORY_SECTION(taskSlug)}`;
}
