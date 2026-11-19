export type InlineRun = { kind: "text" | "bold" | "code"; text: string };

export type TranscriptBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "bullet"; marker: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; lang: string; text: string; lines: number; isJson: boolean }
  | { kind: "paragraph"; text: string };

/** Split inline **bold** and `code` spans while leaving plain text intact. */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) runs.push({ kind: "text", text: text.slice(last, match.index) });
    const token = match[0];
    if (token.startsWith("`")) runs.push({ kind: "code", text: token.slice(1, -1) });
    else runs.push({ kind: "bold", text: token.slice(2, -2) });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ kind: "text", text: text.slice(last) });
  return runs.length ? runs : [{ kind: "text", text }];
}

function tryPrettyJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

function makeCodeBlock(langRaw: string, bodyRaw: string): TranscriptBlock {
  const normalizedLang = langRaw.trim().toLowerCase();
  const formattedJson = (normalizedLang === "json" || !normalizedLang) ? tryPrettyJson(bodyRaw) : null;
  const text = formattedJson ?? bodyRaw.replace(/\n+$/, "");
  const isJson = formattedJson !== null || normalizedLang === "json";
  return {
    kind: "code",
    lang: normalizedLang || (isJson ? "json" : ""),
    text,
    lines: text ? text.split("\n").length : 0,
    isJson,
  };
}

/** Parse markdown-ish agent output and raw JSON into headings, bullets, quotes, paragraphs, and code blocks. */
export function parseTranscriptBlocks(raw: string): TranscriptBlock[] {
  const clean = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  const wholeJson = tryPrettyJson(clean);
  if (wholeJson !== null) {
    return [{ kind: "code", lang: "json", text: wholeJson, lines: wholeJson.split("\n").length, isJson: true }];
  }

  const lines = clean.split("\n");
  const blocks: TranscriptBlock[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    blocks.push({ kind: "paragraph", text: para.join(" ") });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushPara();
      const lang = trimmed.slice(3).trim();
      const body: string[] = [];
      let closed = false;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim().startsWith("```")) {
          i = j;
          closed = true;
          break;
        }
        body.push(lines[j]);
      }
      if (!closed) i = lines.length;
      blocks.push(makeCodeBlock(lang, body.join("\n")));
      continue;
    }

    if (!trimmed) {
      flushPara();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushPara();
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, text: heading[2].trim() });
      continue;
    }

    const bullet = /^(\s*(?:[-*•]|\d+\.)\s+)(.+)$/.exec(line);
    if (bullet) {
      flushPara();
      const rawMarker = bullet[1].trim();
      const marker = /^\d+\.$/.test(rawMarker) ? rawMarker : "•";
      blocks.push({ kind: "bullet", marker, text: bullet[2].trim() });
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      flushPara();
      blocks.push({ kind: "quote", text: quote[1].trim() });
      continue;
    }

    para.push(trimmed);
  }

  flushPara();
  return blocks;
}

/** Split stage attempts into collapsed history plus the latest attempt with a concise summary line. */
export function groupAttempts<T extends { outcome: string; interrupted?: boolean }>(
  attempts: T[],
): { past: T[]; latest?: T; summary: string } {
  if (attempts.length === 0) return { past: [], summary: "" };
  if (attempts.length === 1) return { past: [], latest: attempts[0], summary: "" };

  const past = attempts.slice(0, -1);
  const latest = attempts[attempts.length - 1];
  let failed = 0;
  let sentBack = 0;
  let passed = 0;
  let interrupted = 0;

  for (const a of past) {
    if (a.interrupted) interrupted++;
    else if (/sent\s*back/i.test(a.outcome)) sentBack++;
    else if (/passed|done/i.test(a.outcome)) passed++;
    else failed++;
  }

  const parts = [
    failed ? `${failed} failed` : "",
    sentBack ? `${sentBack} sent back` : "",
    passed ? `${passed} passed` : "",
    interrupted ? `${interrupted} interrupted` : "",
  ].filter(Boolean);

  return {
    past,
    latest,
    summary: `${past.length} earlier attempt${past.length === 1 ? "" : "s"}${parts.length ? ` · ${parts.join(", ")}` : ""}`,
  };
}
