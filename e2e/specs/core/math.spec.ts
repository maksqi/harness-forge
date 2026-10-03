// Math in replies (docs/UI.md 7.4 markdown): `mock:echo` repeats the message, so inline math, display math and an
// mhchem formula come back as the reply and render through markstream-vue + KaTeX. The assertions read the MathML
// annotations (the TeX source) and the computed font, never KaTeX class names (KaTeX 0.18 prefixes its classes).
import {
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  startChat,
  test,
  uniqueId,
} from '../../helpers/index.ts'

test.describe('math', () => {
  test('inline, display and chemistry math render with KaTeX', async ({ page }) => {
    const token = uniqueId('math')
    const text = `Math check ${token}: inline $\\frac{a}{b}$ and water $\\ce{H2O}$\n\n$$\\sum_{i=1}^{n} i$$`

    await startChat(page, { modelRef: 'mock:echo', text })
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done', 15_000)

    const annotations = reply.locator('annotation[encoding="application/x-tex"]')
    await expect(annotations.filter({ hasText: '\\frac{a}{b}' })).toHaveCount(1)
    await expect(annotations.filter({ hasText: '\\ce{H2O}' })).toHaveCount(1)
    await expect(annotations.filter({ hasText: '\\sum_{i=1}^{n} i' })).toHaveCount(1)
    await expect(reply.locator('math[display="block"]')).toHaveCount(1)

    // No KaTeX parse error (rendered with a ParseError title or an error class in every KaTeX version).
    await expect(reply.locator('[title^="ParseError"], [class*="katex-error"]')).toHaveCount(0)

    // The KaTeX stylesheet is loaded: the rendered formula uses the KaTeX fonts.
    const fontFamily = await reply.locator('math').first().evaluate((node) => {
      const host = node.closest('span[class*="katex"]') ?? node.parentElement ?? node
      return host.ownerDocument.defaultView!.getComputedStyle(host).fontFamily
    })
    expect(fontFamily).toContain('KaTeX')
  })
})
