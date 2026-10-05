/**
 * How Buzz messages appear to the model. Each message names its author so the
 * model can tell people apart, and the body is escaped so a message cannot
 * close its own envelope and pose as Keeper's instructions.
 */

export type RenderableMessage = {
  readonly eventId: string;
  readonly authorName: string;
  readonly authorPubkey: string;
  readonly createdAt: number;
  readonly content: string;
};

export function renderMessage(message: RenderableMessage): string {
  const at = new Date(message.createdAt * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  return [
    `<message from="${attribute(message.authorName)}" pubkey="${message.authorPubkey}" id="${message.eventId}" at="${at}">`,
    body(message.content),
    "</message>",
  ].join("\n");
}

function attribute(value: string): string {
  return value.replace(/[&"<>\n]/g, (char) =>
    char === "\n"
      ? " "
      : `&${{ "&": "amp", '"': "quot", "<": "lt", ">": "gt" }[char]};`,
  );
}

function body(value: string): string {
  return value.replace(/<\/?message\b/gi, (match) =>
    match.replace("<", "&lt;"),
  );
}

/** Text of an assistant message: its text blocks, without thinking or tool calls. */
export function assistantText(
  content: readonly { readonly type: string; readonly text?: string }[],
): string {
  return content
    .flatMap((block) =>
      block.type === "text" && block.text !== undefined ? [block.text] : [],
    )
    .join("")
    .trim();
}

/**
 * Split a long answer into parts a Buzz message can hold. The relay caps a
 * frame at 64 KiB; parts stay well below that and break on paragraphs.
 */
export function chunkText(text: string, limit = 12_000): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    const candidate = current === "" ? paragraph : `${current}\n\n${paragraph}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current !== "") parts.push(current);
    current = paragraph;
    while (current.length > limit) {
      parts.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current !== "") parts.push(current);
  return parts;
}
