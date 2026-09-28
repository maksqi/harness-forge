// A hint for a missing or too narrow `HF_TRUST_PROXY` (ADR-026, ARCHITECTURE.md 10.6 and 12). Owner: W5.7.
//
// A request whose TCP peer is not a trusted proxy but carries a forwarded header that the server would honor from one
// is logged once per peer address (`warn`, fields `peer` and `headers`, never the header values): with
// `HF_TRUST_PROXY` unset that is `X-Forwarded-For` (`X-Forwarded-Proto` is still honored from anyone, v1), with it
// set `X-Forwarded-For` and `X-Forwarded-Proto`. At most `MAX_WARNED_PEERS` addresses are remembered, so a client
// cycling through addresses cannot grow the set without bound. Called by the access log for every request.
import type { Logger } from '../../logger.ts'
import type { AppContext } from '../types.ts'
import type { ProxyTrustSetting } from './request-info.ts'
import { proxyTrustFor } from '../../security/proxy-trust.ts'
import { peerAddress, UNKNOWN_CLIENT_ADDRESS } from './request-info.ts'

/** Distinct peers that are warned about; later ones are not logged (one last warning says so). */
export const MAX_WARNED_PEERS = 256

/** Warning when `HF_TRUST_PROXY` is unset. */
export const UNTRUSTED_FORWARDING_UNSET_MESSAGE = 'X-Forwarded-For ignored: HF_TRUST_PROXY is not set. Behind a reverse '
  + 'proxy, set HF_TRUST_PROXY to its address (for example loopback) so the login rate limit sees the real clients.'
/** Warning when `HF_TRUST_PROXY` is set but does not list the peer. */
export const UNTRUSTED_FORWARDING_MESSAGE = 'Forwarded headers ignored: the peer is not listed in HF_TRUST_PROXY.'
/** Logged once when `MAX_WARNED_PEERS` is reached. */
export const UNTRUSTED_FORWARDING_SUPPRESSED_MESSAGE = 'Further peers sending ignored forwarded headers are not logged.'

const HONORED_WITHOUT_TRUST = ['x-forwarded-for'] as const
const HONORED_WITH_TRUST = ['x-forwarded-for', 'x-forwarded-proto'] as const

export type UntrustedProxyWarner = (c: AppContext, logger: Logger) => void

export function createUntrustedProxyWarner(trust: ProxyTrustSetting, options: { maxPeers?: number } = {}): UntrustedProxyWarner {
  const maxPeers = options.maxPeers ?? MAX_WARNED_PEERS
  const warned = new Set<string>()
  let suppressed = false
  return (c, logger) => {
    const matcher = proxyTrustFor(trust.trustProxy)
    const names = matcher === null ? HONORED_WITHOUT_TRUST : HONORED_WITH_TRUST
    const headers = names.filter(name => c.req.header(name) !== undefined)
    if (headers.length === 0)
      return
    const peer = peerAddress(c)
    if (peer === UNKNOWN_CLIENT_ADDRESS || warned.has(peer) || matcher?.isTrusted(peer) === true)
      return
    if (warned.size >= maxPeers) {
      if (!suppressed) {
        suppressed = true
        logger.warn(UNTRUSTED_FORWARDING_SUPPRESSED_MESSAGE, { peers: warned.size })
      }
      return
    }
    warned.add(peer)
    logger.warn(matcher === null ? UNTRUSTED_FORWARDING_UNSET_MESSAGE : UNTRUSTED_FORWARDING_MESSAGE, { peer, headers })
  }
}
