// The same-tab navigation of an MCP sign-in (docs/UI.md 8.14, 11.10): one module, so unit tests can vi.mock() it
// (happy-dom does not navigate). `useMcpSignIn().start` checks that the URL is http(s) before it calls this.
export function assignLocation(url: string): void {
  window.location.assign(url)
}
