// ANSI escape handling for terminal output (docs/UI.md 7.19, 11.4; W7.11). The server already strips the codes from
// stored shell output; the client strips them again before rendering.
// Signature frozen from Gate P7-0b (C15). Skeleton: returns the text unchanged until W7.11 implements it.

/** `text` without CSI / OSC escape sequences. */
export function stripAnsi(text: string): string {
  return text
}
