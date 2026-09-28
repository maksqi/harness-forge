import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { API_CSP, inlineScriptHashes, scriptHash, SECURITY_HEADERS, spaCsp } from './headers.ts'

function sha256(text: string): string {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`
}

const COLOR_MODE_SCRIPT = '"use strict";(()=>{const e=document.documentElement;e.classList.add(localStorage.getItem("hf-color-mode")||"dark")})();'
const IMPORT_MAP = '{"imports":{"#entry":"/_nuxt/entry.js"}}'
const NUXT_CONFIG = 'window.__NUXT__={};window.__NUXT__.config={public:{},app:{baseURL:"/"}}'

const HTML = [
  '<!DOCTYPE html><html lang="en"><head>',
  `<script type="importmap">${IMPORT_MAP}</script>`,
  '<script type="module" src="/_nuxt/entry.js" crossorigin></script>',
  `<script>${COLOR_MODE_SCRIPT}</script>`,
  '<script data-src="not-an-attribute-named-src">window.a = 1</script>',
  '</head><body><div id="__nuxt"></div>',
  `<script>${NUXT_CONFIG}</script>`,
  `<SCRIPT>${COLOR_MODE_SCRIPT}</SCRIPT >`,
  '</body></html>',
].join('')

describe('inlineScriptHashes', () => {
  it('hashes every inline script in document order, skips external ones and duplicates', () => {
    expect(inlineScriptHashes(HTML)).toEqual([
      sha256(IMPORT_MAP),
      sha256(COLOR_MODE_SCRIPT),
      sha256('window.a = 1'),
      sha256(NUXT_CONFIG),
    ])
  })

  it('hashes the text as the browser sees it (CR LF normalized to LF, no trimming)', () => {
    const html = '<script>\r\n  let a = 1\r\n</script><script>\rx\r</script>'
    expect(inlineScriptHashes(html)).toEqual([sha256('\n  let a = 1\n'), sha256('\nx\n')])
  })

  it('returns nothing for a document without inline scripts', () => {
    expect(inlineScriptHashes('<html><script src="/a.js"></script></html>')).toEqual([])
  })

  it('scriptHash is the CSP hash source of the text', () => {
    expect(scriptHash('alert(1)')).toBe('sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI=')
  })
})

describe('spaCsp', () => {
  const csp = spaCsp(inlineScriptHashes(HTML))
  const directives = new Map(csp.split('; ').map((directive) => {
    const [name = '', ...values] = directive.split(' ')
    return [name, values] as const
  }))

  it('allows the color-mode inline script (and every other inline script) by hash only', () => {
    expect(directives.get('script-src')).toEqual([
      '\'self\'',
      '\'wasm-unsafe-eval\'',
      `'${sha256(IMPORT_MAP)}'`,
      `'${sha256(COLOR_MODE_SCRIPT)}'`,
      `'${sha256('window.a = 1')}'`,
      `'${sha256(NUXT_CONFIG)}'`,
    ])
  })

  it('has the directives of ARCHITECTURE.md 10.2 and never unsafe-eval or inline scripts', () => {
    expect(Object.fromEntries(directives)).toMatchObject({
      'default-src': ['\'self\''],
      'style-src': ['\'self\'', '\'unsafe-inline\''],
      'img-src': ['\'self\'', 'data:', 'blob:'],
      'font-src': ['\'self\'', 'data:'],
      'connect-src': ['\'self\''],
      'worker-src': ['\'self\'', 'blob:'],
      'object-src': ['\'none\''],
      'base-uri': ['\'none\''],
      'form-action': ['\'self\''],
      'frame-ancestors': ['\'none\''],
    })
    expect(directives.get('script-src')).not.toContain('\'unsafe-eval\'')
    expect(directives.get('script-src')).not.toContain('\'unsafe-inline\'')
  })
})

describe('static header values', () => {
  it('match ARCHITECTURE.md 10.2', () => {
    expect(API_CSP).toBe('default-src \'none\'; frame-ancestors \'none\'')
    expect(SECURITY_HEADERS).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    })
  })
})
