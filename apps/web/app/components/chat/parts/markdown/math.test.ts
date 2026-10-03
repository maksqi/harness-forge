// Math rendering with KaTeX, loaded the way markstream-vue loads it (`import('katex')`, then
// `import('katex/dist/contrib/mhchem')`) plus the stylesheet `ensureMathStyles` imports. Guards KaTeX upgrades: the
// assertions read the MathML annotation (the TeX source), never KaTeX class names (KaTeX 0.18 prefixes its classes).
import { describe, expect, it } from 'vitest'

// The same extensionless specifier markstream-vue imports; it ships without type declarations, so it stays a runtime
// string (resolved by Vite like the app's own import).
const MHCHEM_MODULE = 'katex/dist/contrib/mhchem'

async function loadKatex() {
  const katex = await import('katex')
  return katex.default
}

describe('math rendering (KaTeX)', () => {
  it('renders a fraction with its TeX source as the MathML annotation', async () => {
    const katex = await loadKatex()
    const html = katex.renderToString('\\frac{a}{b}', { throwOnError: true })
    expect(html).toContain('<annotation encoding="application/x-tex">\\frac{a}{b}</annotation>')
    expect(html).toContain('<math')
  })

  it('renders display math', async () => {
    const katex = await loadKatex()
    const html = katex.renderToString('\\sum_{i=1}^{n} i', { displayMode: true, throwOnError: true })
    expect(html).toContain('display="block"')
  })

  it('renders chemistry once the mhchem extension is loaded from the path markstream-vue uses', async () => {
    const katex = await loadKatex()
    await import(/* @vite-ignore */ MHCHEM_MODULE)
    const html = katex.renderToString('\\ce{H2O}', { throwOnError: true })
    expect(html).toContain('\\ce{H2O}')
    expect(() => katex.renderToString('\\ce{CO2 + H2O -> H2CO3}', { throwOnError: true })).not.toThrow()
  })

  it('reports invalid TeX instead of rendering it silently', async () => {
    const katex = await loadKatex()
    expect(() => katex.renderToString('\\frac{a}{', { throwOnError: true })).toThrow()
  })

  it('resolves the stylesheet that ensureMathStyles loads', async () => {
    await expect(import('katex/dist/katex.min.css')).resolves.toBeDefined()
  })
})
