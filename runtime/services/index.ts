export async function renderMarkdown(
  _env: object,
  _options: { url: string; maxChars: number; signal?: AbortSignal },
): Promise<{ markdown: string }> {
  throw new Error("Markdown rendering is not available.");
}
