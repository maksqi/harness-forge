import { LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { codeOmittedText, readAloudChunks, speechChunks, speechText } from './speech-text'

describe('speechText: code, diagrams, tables and formulas', () => {
  it.each([
    ['a fence with a language', 'Here is the fix:\n\n```ts\nconst a = 1\n```\n\nDone.', 'Here is the fix:\nTypeScript code omitted.\nDone.'],
    ['a fence without a language', '```\nplain code\n```', 'Code omitted.'],
    ['a mermaid fence', '```mermaid\ngraph TD\n  A --> B\n```', 'Diagram omitted.'],
    ['a tilde fence', '~~~python\nprint(1)\n~~~', 'Python code omitted.'],
    ['an info string with attributes', '```ts title="a.ts" {1,3}\nlet a\n```', 'TypeScript code omitted.'],
    ['an unknown language, capitalized', '```haxe\ntrace(1);\n```', 'Haxe code omitted.'],
    ['a text fence', '```text\nSome output\n```', 'Code omitted.'],
    ['an unclosed fence (to the end)', 'Intro\n```js\nconst x = 1\nconst y = 2', 'Intro.\nJavaScript code omitted.'],
    ['a fence closed only by a long enough marker', '````md\n```\ninner\n```\n````\nAfter', 'Markdown code omitted.\nAfter.'],
    ['a fence inside a list item', '- Step one:\n  ```bash\n  npm i\n  ```\n- Step two', 'Step one:\nShell code omitted.\nStep two.'],
    ['a table', 'Compare:\n\n| Model | Price |\n| --- | ---: |\n| A | $1 |\n| B | $2 |\n\nThat is all.', 'Compare:\nTable omitted.\nThat is all.'],
    ['a table without outer pipes', 'a | b\n--|--\n1 | 2', 'Table omitted.'],
    ['a pipe that is no table', 'Use a | b to pipe.', 'Use a | b to pipe.'],
    ['a $$ block', 'Energy:\n$$\nE = mc^2\n$$\nNice.', 'Energy:\nFormula omitted.\nNice.'],
    ['a one-line $$ block', '$$E = mc^2$$', 'Formula omitted.'],
    ['a \\[ \\] block', '\\[\n\\frac{a}{b}\n\\]', 'Formula omitted.'],
    ['an unclosed $$ block (to the end)', '$$\n\\sum_i x_i', 'Formula omitted.'],
  ])('%s', (_name, markdown, expected) => {
    expect(speechText(markdown)).toBe(expected)
  })

  it('names common languages and ignores what follows the language', () => {
    expect(codeOmittedText('js')).toBe('JavaScript code omitted.')
    expect(codeOmittedText('c++')).toBe('C++ code omitted.')
    expect(codeOmittedText('{.python}')).toBe('Python code omitted.')
    expect(codeOmittedText('  yml  ')).toBe('YAML code omitted.')
    expect(codeOmittedText('')).toBe('Code omitted.')
    expect(codeOmittedText('MERMAID')).toBe('Diagram omitted.')
  })
})

describe('speechText: inline math, links, URLs and images', () => {
  it.each([
    ['inline $$ math', 'The energy $$E=mc^2$$ is large.', 'The energy formula is large.'],
    ['\\( \\) math', 'Let \\(x^2\\) be positive.', 'Let formula be positive.'],
    ['$…$ math', 'Let $x_1$ be 5.', 'Let formula be 5.'],
    ['amounts of money stay', 'It costs $5 and $10, or $5-$10 per month.', 'It costs $5 and $10, or $5-$10 per month.'],
    ['an escaped dollar stays', 'Pay \\$5 now.', 'Pay $5 now.'],
    ['a link reads its label', 'Read [the **docs**](https://nuxt.com/docs "Nuxt") first.', 'Read the docs first.'],
    ['a link with parentheses in its target', 'See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) too.', 'See Foo too.'],
    ['a reference link and its definition', 'See [this][ref].\n\n[ref]: https://example.com "Example"', 'See this.'],
    ['an autolink reads "link"', 'Visit <https://example.com/a>.', 'Visit link.'],
    ['an email autolink reads the address', 'Mail <someone@example.com>.', 'Mail someone@example.com.'],
    ['a bare URL reads "link" and keeps the punctuation', 'Go to https://example.com/a?b=c.', 'Go to link.'],
    ['a bare URL in parentheses', '(see https://en.wikipedia.org/wiki/Foo_(bar))', '(see link).'],
    ['a www address', 'www.example.com is up', 'link is up.'],
    ['a URL in a code span', 'Open `https://localhost:3000` now.', 'Open link now.'],
    ['an image reads its alt text', '![A red fox](/api/files/file_1)', 'A red fox.'],
    ['an image without alt text reads nothing', 'Look: ![](x.png) nice', 'Look: nice.'],
    ['a linked image reads its alt text', '[![Logo](logo.png)](https://example.com)', 'Logo.'],
  ])('%s', (_name, markdown, expected) => {
    expect(speechText(markdown)).toBe(expected)
  })
})

describe('speechText: remaining markdown and HTML are stripped', () => {
  it.each([
    [
      'emphasis and code spans',
      'This is **bold**, *italic*, __strong__, _em_, ***both*** and ~~gone~~ with `code_here` and snake_case_name.',
      'This is bold, italic, strong, em, both and gone with code_here and snake_case_name.',
    ],
    ['arithmetic keeps its stars', 'Compute 2 * 3 * 4 now.', 'Compute 2 * 3 * 4 now.'],
    ['escapes read the character', 'Use \\*stars\\* and \\_underscores\\_ literally.', 'Use *stars* and _underscores_ literally.'],
    [
      'headings, paragraphs and list items end as sentences',
      '# Title\n\nIntro text\ngoes on\n\n- First item\n- Second item!\n1. Numbered\n- [x] Done task\n  * Nested,',
      'Title.\nIntro text goes on.\nFirst item.\nSecond item!\nNumbered.\nDone task.\nNested.',
    ],
    ['a closing ATX sequence', '## Setup ##', 'Setup.'],
    ['a hash without a space is no heading', '#hashtag and C#', '#hashtag and C#.'],
    ['an empty heading reads nothing', '#\n\nText', 'Text.'],
    ['two backticks open no fence', '``inline`` code', 'inline code.'],
    ['a setext heading', 'Title\n=====\nBody', 'Title.\nBody.'],
    ['a thematic break', 'One\n\n---\n\nTwo\n\n* * *\nThree', 'One.\nTwo.\nThree.'],
    ['a blockquote', '> Quoted line\n> continues\n>\n> Next', 'Quoted line continues.\nNext.'],
    ['HTML tags, comments and entities', 'Press <kbd>Ctrl</kbd>+<kbd>C</kbd><br>to copy &amp; paste &#8594; done<!-- note -->', 'Press Ctrl+C to copy & paste \u2192 done.'],
    ['script and style elements', '<script>alert(1)</script><style>p{}</style>Hi', 'Hi.'],
    ['an HTML block', '<details>\n<summary>More</summary>\n\nHidden text\n</details>', 'More.\nHidden text.'],
    ['footnotes', 'A claim[^1].\n\n[^1]: The source', 'A claim.\nThe source.'],
    ['a hard break backslash', 'Line one\\\nline two', 'Line one line two.'],
    ['a comparison is no tag', 'Use a < b and b > c.', 'Use a < b and b > c.'],
    ['Windows line breaks', 'One\r\n\r\nTwo', 'One.\nTwo.'],
  ])('%s', (_name, markdown, expected) => {
    expect(speechText(markdown)).toBe(expected)
  })

  it('reads nothing for empty or markup-only replies', () => {
    expect(speechText('')).toBe('')
    expect(speechText('  \n\n ')).toBe('')
    expect(speechText('---\n<br>\n<!-- x -->')).toBe('')
  })

  it('never lets the private placeholders of the parser leak', () => {
    expect(speechText('A \uE0000\uE001 B `code` \\*')).toBe('A 0 B code *.')
  })
})

function sentences(count: number, length = 100): string {
  return Array.from({ length: count }, (_, index) => {
    const head = `Sentence ${index + 1} `
    return `${head}${'x'.repeat(length - head.length - 1)}.`
  }).join(' ')
}

describe('speechChunks', () => {
  it('keeps a short text in one chunk', () => {
    expect(speechChunks('Hello there. How are you?')).toEqual(['Hello there. How are you?'])
    expect(speechChunks('')).toEqual([])
    expect(speechChunks(' \n ')).toEqual([])
  })

  it('starts with at most 300 characters, then at most 1,500, at sentence ends', () => {
    const text = sentences(40)
    const chunks = speechChunks(text)
    expect(chunks[0]!.length).toBeLessThanOrEqual(LIMITS.speechFirstChunkChars)
    expect(chunks[0]!.length).toBeGreaterThan(LIMITS.speechFirstChunkChars - 101)
    for (const chunk of chunks.slice(1))
      expect(chunk.length).toBeLessThanOrEqual(LIMITS.speechChunkChars)
    expect(chunks[1]!.length).toBeGreaterThan(LIMITS.speechChunkChars - 101)
    for (const chunk of chunks)
      expect(chunk).toMatch(/^Sentence \d+ x+\.(?: Sentence \d+ x+\.)*$/)
    expect(chunks.join(' ')).toBe(text)
  })

  it('breaks a long sentence at a clause break, else at a space', () => {
    const clause = `${'word '.repeat(40)}and then, ${'more '.repeat(60)}end.`
    const [head, ...tail] = speechChunks(clause)
    expect(head!.endsWith('and then,')).toBe(true)
    expect(head!.length).toBeLessThanOrEqual(300)
    expect(`${head} ${tail.join(' ')}`).toBe(clause)

    const spaces = `${'lorem '.repeat(80)}end`
    const chunks = speechChunks(spaces)
    expect(chunks[0]!.length).toBeLessThanOrEqual(300)
    expect(chunks.every(chunk => !chunk.includes('  ') && chunk === chunk.trim())).toBe(true)
    expect(chunks.join(' ')).toBe(spaces.trim())
  })

  it('cuts a text without spaces at the limits and never splits a surrogate pair', () => {
    const word = 'y'.repeat(5000)
    expect(speechChunks(word).map(chunk => chunk.length)).toEqual([300, 1500, 1500, 1500, 200])
    const emoji = '\u{1F98A}'.repeat(200)
    const chunks = speechChunks(emoji, { first: 7, rest: 7 })
    expect(chunks.join('')).toBe(emoji)
    expect(chunks.every(chunk => chunk.length <= 7 && !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true)
  })

  it('treats line breaks as sentence ends', () => {
    expect(speechChunks('First line\nSecond line', { first: 12, rest: 12 })).toEqual(['First line', 'Second line'])
    expect(speechChunks('First line\nSecond line')).toEqual(['First line\nSecond line'])
  })

  it('takes custom limits and never goes over 4,096 characters', () => {
    expect(speechChunks('One. Two. Three.', { first: 5, rest: 10 })).toEqual(['One.', 'Two.', 'Three.'])
    const chunks = speechChunks(sentences(100), { first: 10_000, rest: 10_000, max: 10_000 })
    expect(chunks.every(chunk => chunk.length <= LIMITS.speechTextMaxChars)).toBe(true)
    expect(chunks.length).toBeGreaterThan(1)
  })
})

describe('readAloudChunks', () => {
  it('reads the words of the markdown in chunks', () => {
    expect(readAloudChunks('# Plan\n\n1. Read [the docs](https://nuxt.com).\n\n```ts\nx()\n```')).toEqual([
      'Plan.\nRead the docs.\nTypeScript code omitted.',
    ])
    expect(readAloudChunks('<br>')).toEqual([])
  })
})
