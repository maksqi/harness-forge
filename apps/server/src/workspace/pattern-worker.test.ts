import { describe, expect, it } from 'vitest'
import { compileGlob, compileSearchRegex, escapeRegex, SEARCH_TIMEOUT_MESSAGE, startPatternWorker } from './pattern-worker.ts'

describe('compileGlob', () => {
  it('matches the file name at any depth without "/", else the whole relative path; dot files included', async () => {
    const paths = ['a.ts', 'src/b.ts', 'src/deep/c.ts', '.hidden.ts', 'src/.d.ts', 'readme.md', 'src/e.tsx']
    const run = async (pattern: string): Promise<string[]> => {
      const worker = startPatternWorker({ glob: compileGlob(pattern) })
      try {
        return (await worker.filterPaths(paths)).map(index => paths[index]!)
      }
      finally {
        await worker.close()
      }
    }
    expect(await run('*.ts')).toEqual(['a.ts', 'src/b.ts', 'src/deep/c.ts', '.hidden.ts', 'src/.d.ts'])
    expect(await run('src/*.ts')).toEqual(['src/b.ts', 'src/.d.ts'])
    expect(await run('src/**/*.ts')).toEqual(['src/b.ts', 'src/deep/c.ts', 'src/.d.ts'])
    expect(await run('./src/*.{ts,tsx}')).toEqual(['src/b.ts', 'src/.d.ts', 'src/e.tsx'])
    expect(await run('/readme.md')).toEqual(['readme.md'])
    expect(compileGlob('*.ts').basename).toBe(true)
    expect(compileGlob('src/*.ts').basename).toBe(false)
  })

  it('refuses an empty pattern', () => {
    expect(() => compileGlob('./')).toThrow(/empty/)
  })
})

describe('compileSearchRegex', () => {
  it('prefers the u flag, falls back without it, adds i when case-insensitive', () => {
    expect(compileSearchRegex('\\p{L}+')).toEqual({ source: '\\p{L}+', flags: 'u' })
    // `\-` outside a class is a syntax error with `u` only.
    expect(compileSearchRegex('a\\-b')).toEqual({ source: 'a\\-b', flags: '' })
    expect(compileSearchRegex('todo', { caseSensitive: false })).toEqual({ source: 'todo', flags: 'iu' })
  })

  it('escapes a literal pattern', () => {
    expect(escapeRegex('a.b*(c)[d]{e}|f/g\\h^$+?')).toBe('a\\.b\\*\\(c\\)\\[d\\]\\{e\\}\\|f\\/g\\\\h\\^\\$\\+\\?')
    const { source, flags } = compileSearchRegex('foo(bar', { literal: true })
    expect(new RegExp(source, flags).test('x foo(bar y')).toBe(true)
  })

  it('refuses invalid syntax on the main thread with a validation error', () => {
    expect(() => compileSearchRegex('foo(')).toThrow(/Invalid regular expression/)
    try {
      compileSearchRegex('[')
    }
    catch (error) {
      expect(error).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['pattern'] }] } })
    }
  })
})

describe('startPatternWorker', () => {
  it('reports matching lines with 1-based numbers, without a trailing \\r, up to the limit', async () => {
    const worker = startPatternWorker({ regex: compileSearchRegex('needle') })
    try {
      const matches = await worker.searchTexts([
        { path: 'a.txt', text: 'one\r\nneedle two\r\nthree\r\n' },
        { path: 'b.txt', text: 'needle\nneedle\nneedle' },
        { path: 'empty.txt', text: '' },
      ], 3)
      expect(matches).toEqual([
        { path: 'a.txt', line: 2, text: 'needle two' },
        { path: 'b.txt', line: 1, text: 'needle' },
        { path: 'b.txt', line: 2, text: 'needle' },
      ])
      const anchored = startPatternWorker({ regex: compileSearchRegex('^$') })
      try {
        // A final newline does not add an empty line.
        expect(await anchored.searchTexts([{ path: 'x', text: 'a\n\nb\n' }], 10)).toEqual([{ path: 'x', line: 2, text: '' }])
      }
      finally {
        await anchored.close()
      }
    }
    finally {
      await worker.close()
    }
  })

  it('cuts long matching lines at 2000 characters', async () => {
    const worker = startPatternWorker({ regex: compileSearchRegex('x') })
    try {
      const [match] = await worker.searchTexts([{ path: 'long.txt', text: 'x'.repeat(5000) }], 1)
      expect(match!.text).toHaveLength(2000)
    }
    finally {
      await worker.close()
    }
  })

  it('times out on catastrophic backtracking while the event loop stays responsive', async () => {
    const worker = startPatternWorker({ regex: compileSearchRegex('(a+)+$'), timeoutMs: 300 })
    let ticks = 0
    const interval = setInterval(() => ticks++, 10)
    const started = Date.now()
    try {
      await expect(worker.searchTexts([{ path: 'redos.txt', text: `${'a'.repeat(40)}!` }], 10)).rejects.toMatchObject({ code: 'validation_error', message: SEARCH_TIMEOUT_MESSAGE })
    }
    finally {
      clearInterval(interval)
      await worker.close()
    }
    expect(Date.now() - started).toBeLessThan(5000)
    expect(ticks).toBeGreaterThanOrEqual(10)
    // A failed worker refuses further requests.
    await expect(worker.searchTexts([], 1)).rejects.toBeDefined()
  })

  it('rejects with the abort reason when the signal aborts', async () => {
    const controller = new AbortController()
    const worker = startPatternWorker({ regex: compileSearchRegex('(a+)+$'), signal: controller.signal })
    const pending = worker.searchTexts([{ path: 'redos.txt', text: `${'a'.repeat(40)}!` }], 10)
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await worker.close()
  })
})
