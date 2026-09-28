import { describe, expect, it } from 'vitest'
import { isSafeCss, sanitizeSvg, SvgSanitizeError, urlArguments } from './svg.ts'

const NS = 'xmlns="http://www.w3.org/2000/svg"'

describe('sanitizeSvg', () => {
  it('keeps a plain icon and declares the SVG namespace', () => {
    const svg = sanitizeSvg(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<!-- exported -->
<svg viewBox="0 0 24 24" width="24" height="24"><title>Acme &amp; Co</title><path d="M0 0h24v24H0z" fill="currentColor" fill-rule="evenodd"/></svg>`)
    expect(svg).toBe(`<svg ${NS} viewBox="0 0 24 24" width="24" height="24"><title>Acme &amp; Co</title><path d="M0 0h24v24H0z" fill="currentColor" fill-rule="evenodd"/></svg>\n`)
  })

  it('drops scripts, foreign objects, animations, event handlers and editor namespaces', () => {
    const svg = sanitizeSvg(`<svg ${NS} xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" onload="alert(1)">
<script>alert(1)</script>
<script><![CDATA[ alert(2) ]]></script>
<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>
<sodipodi:namedview id="base"/>
<circle cx="5" cy="5" r="4" onclick="alert(3)" onmouseover="x()"><animate attributeName="href" to="javascript:alert(4)"/><set attributeName="fill" to="red"/></circle>
<feImage href="https://evil.example/x.png"/>
</svg>`)
    expect(svg).not.toMatch(/script|alert|foreignObject|onload|onclick|onmouseover|animate|<set|sodipodi|feImage|evil/i)
    expect(svg).toContain('<circle cx="5" cy="5" r="4"/>')
  })

  it('keeps local references and drops external ones', () => {
    const svg = sanitizeSvg(`<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink">
<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><path id="p" d="M0 0"/></defs>
<use xlink:href="#p"/><use href="https://evil.example/sprite.svg#p"/><use xlink:href="javascript:alert(1)"/>
<rect fill="url(#g)" width="1" height="1"/><rect fill="url(https://evil.example/g.svg#g)" width="2" height="2"/>
<rect style="fill: url(#g); stroke: red" width="3" height="3"/><rect style="fill: url('https://evil.example/x')" width="4" height="4"/>
<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/><image href="https://evil.example/x.png" width="1" height="1"/>
<image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" width="1" height="1"/>
</svg>`)
    expect(svg).toContain('<use xlink:href="#p"/>')
    expect(svg).toContain('<rect fill="url(#g)" width="1" height="1"/>')
    expect(svg).toContain('<rect width="2" height="2"/>')
    expect(svg).toContain('<rect style="fill: url(#g); stroke: red" width="3" height="3"/>')
    expect(svg).toContain('<rect width="4" height="4"/>')
    expect(svg).toContain('<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>')
    expect(svg).not.toMatch(/evil|javascript|svg\+xml/)
    expect(svg.startsWith(`<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink">`)).toBe(true)
  })

  it('unwraps links and keeps their content', () => {
    const svg = sanitizeSvg(`<svg ${NS}><a href="https://example.com"><rect width="1" height="1"/></a></svg>`)
    expect(svg).toBe(`<svg ${NS}><rect width="1" height="1"/></svg>\n`)
  })

  it('keeps safe style sheets and drops unsafe ones', () => {
    const safe = sanitizeSvg(`<svg ${NS}><style>.st0{fill:#1a1a1a}.st1>path{opacity:.5}</style><path class="st0" d="M0 0"/></svg>`)
    expect(safe).toContain('<style>.st0{fill:#1a1a1a}.st1&gt;path{opacity:.5}</style>')
    for (const css of ['@import url(https://evil.example/a.css);', '.a{background:url(https://evil.example/x)}', '.a{fill:\\75 rl(x)}', '@font-face{src:url(x.woff)}', '.a{behavior:url(x.htc)}']) {
      const svg = sanitizeSvg(`<svg ${NS}><style>${css.replace(/</g, '&lt;')}</style><path d="M0 0"/></svg>`)
      expect(svg).not.toContain('<style')
    }
  })

  it('reads url() arguments linearly and refuses malformed ones', () => {
    expect(urlArguments('fill: url(#a); stroke: URL( "#b" ) ; x: url(\'c d\')')).toEqual(['#a', '#b', 'c d'])
    expect(urlArguments('no urls')).toEqual([])
    expect(urlArguments('url(#a')).toBeNull()
    expect(urlArguments('url("#a)')).toBeNull()
    expect(urlArguments('url("#a" x)')).toBeNull()
    expect(urlArguments('url(a"b)')).toBeNull()
    expect(urlArguments(`url(${' '.repeat(50_000)}`)).toBeNull()
  })

  it('checks CSS', () => {
    expect(isSafeCss('fill:#fff;stroke:url(#a)')).toBe(true)
    expect(isSafeCss('fill:url( "#a" )')).toBe(true)
    expect(isSafeCss('fill:url(data:image/png;base64,AAAA)')).toBe(false)
    expect(isSafeCss('fill:url(#a) url(b)')).toBe(false)
    expect(isSafeCss('x:expression(alert(1))')).toBe(false)
    expect(isSafeCss('/* comment */fill:red')).toBe(true)
    expect(isSafeCss('/* unterminated fill:red')).toBe(false)
  })

  it('escapes text and attribute values on output', () => {
    const svg = sanitizeSvg(`<svg ${NS}><text x="0" y="&quot;1&quot;">a &lt;b&gt; &#x41;&#66;</text></svg>`)
    expect(svg).toBe(`<svg ${NS}><text x="0" y="&quot;1&quot;">a &lt;b&gt; AB</text></svg>\n`)
  })

  it.each([
    ['not SVG', '<html><body/></html>'],
    ['empty', ''],
    ['text only', 'hello'],
    ['two roots', `<svg ${NS}/><svg ${NS}/>`],
    ['unclosed element', `<svg ${NS}><g>`],
    ['mismatched end tag', `<svg ${NS}><g></svg>`],
    ['unquoted attribute', `<svg ${NS} width=10/>`],
    ['duplicate attribute', `<svg ${NS} width="1" width="2"/>`],
    ['entity definitions', `<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg ${NS}>&a;</svg>`],
    ['unknown entity', `<svg ${NS}><text>&nbsp;</text></svg>`],
    ['stray ampersand', `<svg ${NS}><text>a & b</text></svg>`],
    ['NUL character', `<svg ${NS}>\0</svg>`],
    ['unterminated comment', `<svg ${NS}><!-- </svg>`],
    ['deep nesting', `<svg ${NS}>${'<g>'.repeat(200)}${'</g>'.repeat(200)}</svg>`],
  ])('rejects %s', (_name, input) => {
    expect(() => sanitizeSvg(input)).toThrow(SvgSanitizeError)
  })

  it('strips a byte order mark', () => {
    expect(sanitizeSvg(`\uFEFF<svg ${NS}/>`)).toBe(`<svg ${NS}/>\n`)
  })

  it('never lets a foreign namespace declaration through', () => {
    const svg = sanitizeSvg('<svg xmlns="http://www.w3.org/1999/xhtml"><rect width="1" height="1"/></svg>')
    expect(svg).toBe(`<svg ${NS}><rect width="1" height="1"/></svg>\n`)
  })
})
