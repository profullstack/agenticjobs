/**
 * Terminal formatting.
 *
 * The escape byte is built rather than written literally, so the source stays
 * plain ASCII and nothing here can be mangled by a tool that strips control
 * characters on the way through.
 *
 * Colour is applied only when someone is looking at it: piping to a file or
 * into jq gets clean text, which is what makes `--json` and plain output both
 * usable in a script.
 */

const ESC = String.fromCharCode(27);

function paint(code: string, value: string): string {
  if (process.stdout.isTTY !== true) return value;
  if (process.env['NO_COLOR'] !== undefined) return value;
  return `${ESC}[${code}m${value}${ESC}[0m`;
}

export const dim = (value: string): string => paint('2', value);
export const bold = (value: string): string => paint('1', value);
export const green = (value: string): string => paint('32', value);
export const red = (value: string): string => paint('31', value);
