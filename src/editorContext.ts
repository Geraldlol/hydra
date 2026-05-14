export interface EditorContextAttachment {
  label: string;
  languageId: string;
  selected: boolean;
  startLine: number;
  endLine: number;
  text: string;
  originalChars: number;
  truncated: boolean;
}

export function truncateEditorContext(text: string, maxChars: number): { text: string; truncated: boolean; originalChars: number } {
  const originalChars = text.length;
  const safeMax = Math.max(0, maxChars);
  if (safeMax === 0 || originalChars <= safeMax) {
    return { text, truncated: false, originalChars };
  }
  return {
    text: text.slice(0, safeMax),
    truncated: true,
    originalChars,
  };
}

export function renderEditorContextAttachment(attachment: EditorContextAttachment): string {
  const source = attachment.selected ? "selected text" : "active file";
  const language = attachment.languageId || "text";
  const lineRange = attachment.startLine === attachment.endLine
    ? `line ${attachment.startLine}`
    : `lines ${attachment.startLine}-${attachment.endLine}`;
  return [
    "--- Active editor context ---",
    `Source: ${source}`,
    `File: ${attachment.label}`,
    `Range: ${lineRange}`,
    attachment.truncated
      ? `Truncated: yes (${attachment.text.length}/${attachment.originalChars} chars included)`
      : `Truncated: no (${attachment.originalChars} chars)`,
    "",
    `\`\`\`${language}`,
    attachment.text,
    "```",
  ].join("\n");
}
