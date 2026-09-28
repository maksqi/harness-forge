import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  charsetOf,
  contentKind,
  decodeBytes,
  decodeEntities,
  extractHtml,
  mimeTypeOf,
  normalizePlainText,
  sniffHtmlCharset,
} from './html-text.ts'

describe('extractHtml', () => {
  it('drops scripts, styles and other non-content elements and keeps the text in order', () => {
    const html = `<!DOCTYPE html>
      <html><head><title>Ignored head text</title><style>body { color: red }</style><script>var head = 1</script></head>
      <body>
        <nav><a href="/">Home</a> <a href="/about">About</a></nav>
        <script type="module">console.log("secret")</script>
        <noscript>Enable JavaScript</noscript>
        <template><p>template text</p></template>
        <svg viewBox="0 0 10 10"><title>icon title</title><path d="M0 0"/></svg>
        <svg class="self-closing" />
        <iframe src="https://ads.example.com">frame text</iframe>
        <!-- a comment with <p>markup</p> -->
        <main>
          <h1>Main heading</h1>
          <p>First <b>bold</b> paragraph.</p>
          <p>Second<br>line</p>
        </main>
        <style>.late { display: none }</style>
      </body></html>`
    const { text } = extractHtml(html)
    expect(text).toBe('Main heading\n\nFirst bold paragraph.\n\nSecond\nline')
    for (const hidden of ['secret', 'color: red', 'Enable JavaScript', 'template text', 'icon title', 'frame text', 'a comment', 'Home', 'display: none', 'Ignored head text'])
      expect(text).not.toContain(hidden)
  })

  it('reads the title from <title>, else og:title, else null', () => {
    expect(extractHtml('<html><head><title>  Hello &amp; welcome\n  </title></head><body>x</body></html>').title).toBe('Hello & welcome')
    expect(extractHtml('<head><meta content="Open &quot;Graph&quot;" property="og:title"></head><body>x</body>').title).toBe('Open "Graph"')
    expect(extractHtml('<head><meta name=og:title content=Unquoted></head>').title).toBe('Unquoted')
    expect(extractHtml('<head><title></title><meta property="og:title" content="Fallback"></head>').title).toBe('Fallback')
    expect(extractHtml('<p>no title</p>').title).toBeNull()
    expect(extractHtml(`<title>${'t'.repeat(500)}</title>`).title).toHaveLength(300)
  })

  it('decodes entities after removing tags, so escaped markup stays text', () => {
    const { text } = extractHtml('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp;amp; &copy; &#169; &#x1F600; caf&eacute; &euro;&nbsp;5 &unknown; &#0;</p>')
    expect(text).toBe('<script>alert(1)</script> &amp; © © \u{1F600} café € 5 &unknown; \uFFFD')
  })

  it('turns lists, tables and headings into lines', () => {
    const html = '<h2>Items</h2><ul><li>One</li><li><p>Two</p></li><li></li><li>Three <em>3</em></li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'
    expect(extractHtml(html).text).toBe('Items\n\n- One\n- Two\n- Three 3\n\nA B\n1 2')
  })

  it('keeps preformatted blocks as they are', () => {
    const html = '<p>Code:</p><pre><code>function f() {\n  return 1 &lt; 2\n}</code></pre><p>After</p>'
    expect(extractHtml(html).text).toBe('Code:\n\nfunction f() {\n  return 1 < 2\n}\n\nAfter')
  })

  it('collapses whitespace and handles unclosed elements and stray characters', () => {
    // Source whitespace (also newlines) is not significant, as in a browser.
    expect(extractHtml('<p>a \t  b\n\n\n\n c</p>').text).toBe('a b c')
    expect(extractHtml('<div>one</div><div>two</div><p>three</p>').text).toBe('one\ntwo\n\nthree')
    expect(extractHtml('<p>1 < 2 and 3 > 2</p>').text).toBe('1 < 2 and 3 > 2')
    expect(extractHtml('<p>visible</p><script>never closed').text).toBe('visible')
    expect(extractHtml('<p>a\u200Bb\u0000c\uE000d</p>').text).toBe('abcd')
  })
  it('stays linear on 2 MB of unclosed or malformed markup (untrusted pages must not block the server)', () => {
    for (const input of ['<a'.repeat(1_000_000), '<meta '.repeat(350_000), '<title'.repeat(350_000), '<script<!'.repeat(230_000), '<pre<br'.repeat(300_000)]) {
      const started = performance.now()
      extractHtml(input)
      expect(performance.now() - started).toBeLessThan(2000)
    }
  })
})

describe('decodeEntities', () => {
  it('maps numeric C1 references to Windows-1252 and invalid ones to U+FFFD', () => {
    expect(decodeEntities('&#128;&#x93;quoted&#x94;')).toBe('€“quoted”')
    expect(decodeEntities('&#xD800;&#1114112;')).toBe('\uFFFD\uFFFD')
    expect(decodeEntities('&AMP; &Eacute; &eacute; &hellip;')).toBe('&AMP; É é …')
  })
})

describe('content types and charsets', () => {
  it('parses the mime type and the charset parameter', () => {
    expect(mimeTypeOf('Text/HTML; charset=UTF-8')).toBe('text/html')
    expect(mimeTypeOf('')).toBeNull()
    expect(mimeTypeOf(null)).toBeNull()
    expect(mimeTypeOf('garbage')).toBeNull()
    expect(charsetOf('text/html; charset="ISO-8859-1"')).toBe('ISO-8859-1')
    expect(charsetOf('text/plain;charset=windows-1251; format=flowed')).toBe('windows-1251')
    expect(charsetOf('text/plain')).toBeNull()
  })

  it('classifies what web_fetch can read', () => {
    const empty = new Uint8Array(0)
    expect(contentKind('text/html', empty)).toBe('html')
    expect(contentKind('application/xhtml+xml', empty)).toBe('html')
    for (const type of ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/ld+json', 'application/xml', 'application/rss+xml', 'application/javascript', 'application/x-yaml'])
      expect(contentKind(type, empty), type).toBe('text')
    for (const type of ['image/png', 'image/svg+xml', 'application/pdf', 'application/octet-stream', 'video/mp4', 'application/zip'])
      expect(contentKind(type, empty), type).toBe('unsupported')
    expect(contentKind(null, Buffer.from('  <!DOCTYPE html><html></html>'))).toBe('html')
    expect(contentKind(null, Buffer.from('<div><title>x</title>'))).toBe('html')
    expect(contentKind(null, Buffer.from('plain words'))).toBe('text')
    expect(contentKind(null, Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x01]))).toBe('unsupported')
  })

  it('sniffs a BOM or a meta charset declaration', () => {
    expect(sniffHtmlCharset(Buffer.from('<meta charset="windows-1252"><p>x</p>'))).toBe('windows-1252')
    expect(sniffHtmlCharset(Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-2">'))).toBe('iso-8859-2')
    expect(sniffHtmlCharset(Uint8Array.from([0xEF, 0xBB, 0xBF, 0x3C]))).toBe('utf-8')
    expect(sniffHtmlCharset(Buffer.from('<p>none</p>'))).toBeNull()
  })

  it('decodes legacy charsets, BOMs and unknown labels', () => {
    expect(decodeBytes(Uint8Array.from([0x63, 0x61, 0x66, 0xE9]), 'iso-8859-1')).toBe('café')
    expect(decodeBytes(Uint8Array.from([0x80, 0x20, 0x35]), 'windows-1252')).toBe('€ 5')
    expect(decodeBytes(Uint8Array.from([0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00]), null)).toBe('hi')
    expect(decodeBytes(Buffer.from('café'), 'no-such-charset')).toBe('café')
    expect(decodeBytes(Uint8Array.from([0x61, 0xFF, 0x62]), 'utf-8')).toBe('a\uFFFDb')
  })

  it('normalizes plain text', () => {
    expect(normalizePlainText('\r\n\uFEFFline 1\r\nline 2\n\n\n\nline 3\n')).toBe('line 1\nline 2\n\nline 3')
  })
})
