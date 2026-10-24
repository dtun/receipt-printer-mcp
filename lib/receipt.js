// Receipt formatting rules shared by every way of reaching the printer.
// Pure: no Node APIs, so the Cloudflare Worker can import it too.

export const PRINTER = "Rongta_RP820";
export const WIDTH = 48; // 80mm paper, Font A

export const PRINT_DESCRIPTION =
  `Print plain text on the ${PRINTER} thermal receipt printer (80mm paper). ` +
  `Every line must be at most ${WIDTH} characters; longer lines are rejected so ` +
  `ASCII art never wraps. Use ${"=".repeat(WIDTH)} as a full-width divider. ` +
  `The printer feeds and cuts automatically after the text.`;

export const STATUS_DESCRIPTION = `Show whether the ${PRINTER} is idle/enabled and list any pending jobs.`;

// Returns an error message if any line is too wide, otherwise null.
// Width is measured in characters, not bytes.
export function checkWidth(content) {
  const tooLong = content
    .split("\n")
    .map((line, i) => ({ n: i + 1, len: [...line].length }))
    .filter(({ len }) => len > WIDTH);
  if (!tooLong.length) return null;
  const list = tooLong.map(({ n, len }) => `line ${n}: ${len} chars`).join(", ");
  return `Nothing printed. Lines over ${WIDTH} chars: ${list}. Reformat and retry.`;
}

// Removes control characters other than newline and tab. Text from a remote
// client must not be able to send raw ESC/POS commands (cuts, drawer kicks,
// mode changes); the print script adds the only ones we want.
export function stripControl(content) {
  return content.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
