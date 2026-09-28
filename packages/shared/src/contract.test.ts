/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as shared from './index.ts'

const API_MD = readFileSync(new URL('../../../docs/API.md', import.meta.url), 'utf8')

/** AI SDK option names and DTO fields ending in `Schema(s)`, and `settingsValuesSchema` (a plugin-sdk export). */
const NOT_EXPORTS = new Set(['inputSchema', 'metadataSchema', 'dataSchemas', 'dataPartSchemas', 'settingsValuesSchema'])

describe('naming contract of API.md', () => {
  it('exports every schema named in API.md', () => {
    const names = new Set([...API_MD.matchAll(/\b([a-z][\dA-Za-z]*Schemas?)\b/g)].map(match => match[1] ?? ''))
    const missing = [...names].filter(name => !NOT_EXPORTS.has(name) && !(name in shared))
    expect(missing).toEqual([])
    expect(names.size).toBeGreaterThan(100)
  })

  it('exports zod schemas under every *Schema name (factories are functions)', () => {
    for (const [name, value] of Object.entries(shared)) {
      if (!name.endsWith('Schema'))
        continue
      if (typeof value === 'function')
        expect(['listResponseSchema', 'cursorPageSchema', 'queryIntSchema', 'settingsPropertyValueSchema'], name).toContain(name)
      else
        expect(value, name).toBeInstanceOf(z.ZodType)
    }
  })
})
