/**
 * Recovering JSON from free-form model output.
 *
 * This is the fallback path for providers or models that cannot honour a
 * response schema. It is deliberately narrow: find the outermost balanced
 * `{...}` or `[...]`, ignoring braces inside string literals. Anything cleverer
 * (repairing trailing commas, closing unbalanced braces) risks turning a
 * truncated response into plausible-looking wrong data.
 */
export function extractJson(text: string): unknown {
  const trimmed = stripCodeFence(text.trim());

  // The common case: the whole response is the document.
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to scanning
  }

  const span = findBalancedSpan(trimmed);
  if (!span) {
    throw new Error('No JSON object or array found in the model response');
  }

  try {
    return JSON.parse(trimmed.slice(span.start, span.end + 1));
  } catch (err) {
    throw new Error(
      `Found a JSON-looking span but could not parse it: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function stripCodeFence(text: string): string {
  const fence = /^```(?:json|jsonc)?\s*\n([\s\S]*?)\n?```$/i.exec(text);
  return fence?.[1] ?? text;
}

function findBalancedSpan(text: string): { start: number; end: number } | undefined {
  const openIdx = firstIndexOfAny(text, ['{', '[']);
  if (openIdx < 0) return undefined;

  const open = text[openIdx] as '{' | '[';
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { start: openIdx, end: i };
    }
  }

  return undefined;
}

function firstIndexOfAny(text: string, chars: string[]): number {
  let best = -1;
  for (const ch of chars) {
    const idx = text.indexOf(ch);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  return best;
}
