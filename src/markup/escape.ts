/**
 * The markup pipeline is safe by construction: source text is escaped as it is
 * emitted, and the only tags that can appear in the output are ones this
 * module writes literally. Raw HTML in a job description, a cover letter or a
 * resume is content, not markup.
 *
 * Do not "improve" this by adding a sanitiser or a raw-HTML passthrough. A
 * sanitiser is a denylist with a long history of bypasses; this is an
 * allowlist that cannot be bypassed, because there is no path from input to a
 * tag at all.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** Only these schemes ever reach an href or a src. Everything else is dropped. */
const SAFE_SCHEME = /^(https?:|mailto:|\/|#)/i;

export function safeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  // A control character in the middle of a URL is how `javascript:` gets past
  // a scheme check: `java\nscript:` fails a naive test and is still executed
  // by the parser.
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  if (!SAFE_SCHEME.test(trimmed)) return null;
  return trimmed;
}

/**
 * Anything interpolated into a <script> element goes through this. A bare
 * JSON.stringify of text containing `</script>` closes the element and the
 * rest of the document parses as markup, which is stored XSS on a field as
 * ordinary as a job title.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(String.fromCharCode(0x2028))
    .join('\\u2028')
    .split(String.fromCharCode(0x2029))
    .join('\\u2029');
}
