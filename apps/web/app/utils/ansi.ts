// ANSI escape handling for terminal output (docs/UI.md 7.19, 11.4; W7.11). The server already strips the codes from
// stored shell output, turns `\r\n` into `\n` and keeps only the last segment of a `\r` progress line; the client does
// the same again before rendering (older or plugin outputs may still carry them).
// Signature of stripAnsi frozen from Gate P7-0b (C15).

// CSI (`ESC [` or the 8-bit `0x9B`, parameters, intermediates, a final byte), OSC (`ESC ]` … BEL or `ESC \`, also
// unterminated at the end of the text), and the other two-byte escapes (`ESC` + one byte in @–Z, \, ^, _). Ranges are
// written as code points: parameters 0x30–0x3F, intermediates 0x20–0x2F, final bytes 0x40–0x7E.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /(?:\u001B\[|\u009B)[\u0030-\u003F]*[\u0020-\u002F]*[\u0040-\u007E]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\|$)|\u001B[\u0040-\u005A\\^_]/g

/** `text` without CSI / OSC escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/** `\r\n` as `\n`, and of a line rewritten with `\r` (a progress bar) only its last non-empty segment. */
export function collapseCarriageReturns(text: string): string {
  if (!text.includes('\r'))
    return text
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (!line.includes('\r'))
        return line
      const segments = line.split('\r')
      for (let index = segments.length - 1; index >= 0; index--) {
        if (segments[index] !== '')
          return segments[index]!
      }
      return ''
    })
    .join('\n')
}

/** Terminal text as the client shows it: escapes removed and carriage returns collapsed. */
export function terminalText(text: string): string {
  return collapseCarriageReturns(stripAnsi(text))
}
