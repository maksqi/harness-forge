import { z } from 'zod'

// zod v4 probes `new Function` for its JIT; the SPA's CSP forbids eval, so run zod in jitless mode (no CSP errors).
z.config({ jitless: true })

export default defineNuxtPlugin(() => {})
