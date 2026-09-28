import { DEFAULT_SETTINGS, speechVoiceSchema, transcriptionLanguageSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_LANGUAGE,
  filterVoices,
  isSecureOrigin,
  languageLabel,
  parseLanguage,
  parseSpeed,
  parseVoice,
  SPEECH_SPEEDS,
  speedLabel,
  TEST_VOICE_TEXT,
  TRANSCRIPTION_LANGUAGES,
} from './voice-settings'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dictation languages', () => {
  it('starts with automatic detection, then 22 languages by English name', () => {
    expect(TRANSCRIPTION_LANGUAGES[0]).toEqual({ value: 'auto', label: 'Detect automatically' })
    expect(AUTO_LANGUAGE).toBe(DEFAULT_SETTINGS.transcriptionLanguage)
    const languages = TRANSCRIPTION_LANGUAGES.slice(1)
    expect(languages).toHaveLength(22)
    expect(languages.map(option => option.label)).toEqual([...languages.map(option => option.label)].sort())
    expect(languages.find(option => option.label === 'Ukrainian')?.value).toBe('uk')
    expect(languages.find(option => option.label === 'Chinese')?.value).toBe('zh')
    for (const option of TRANSCRIPTION_LANGUAGES)
      expect(transcriptionLanguageSchema.safeParse(option.value).success).toBe(true)
  })

  it('labels a stored language, and keeps an unknown code as it is', () => {
    expect(languageLabel('auto')).toBe('Detect automatically')
    expect(languageLabel('de')).toBe('German')
    expect(languageLabel('yue')).toBe('yue')
  })

  it('accepts only valid transcription languages', () => {
    expect(parseLanguage('auto')).toBe('auto')
    expect(parseLanguage('pl')).toBe('pl')
    expect(parseLanguage('yue')).toBe('yue')
    expect(parseLanguage('EN')).toBeNull()
    expect(parseLanguage('english')).toBeNull()
    expect(parseLanguage(undefined)).toBeNull()
    expect(parseLanguage(null)).toBeNull()
  })
})

describe('read-aloud speeds', () => {
  it('offers 0.75x to 2x with 1x as the default', () => {
    expect(SPEECH_SPEEDS).toEqual([0.75, 1, 1.25, 1.5, 1.75, 2])
    expect(SPEECH_SPEEDS).toContain(DEFAULT_SETTINGS.speechSpeed)
    expect(SPEECH_SPEEDS.map(speedLabel)).toEqual(['0.75×', '1×', '1.25×', '1.5×', '1.75×', '2×'])
    expect(speedLabel(0.5)).toBe('0.5×')
  })

  it('parses select values into valid speeds', () => {
    expect(parseSpeed('1.25')).toBe(1.25)
    expect(parseSpeed('2')).toBe(2)
    expect(parseSpeed(0.75)).toBe(0.75)
    expect(parseSpeed('0.25')).toBeNull()
    expect(parseSpeed('3')).toBeNull()
    expect(parseSpeed('')).toBeNull()
    expect(parseSpeed('fast')).toBeNull()
    expect(parseSpeed(undefined)).toBeNull()
  })
})

describe('voice field', () => {
  it('treats an empty field as the provider default', () => {
    expect(parseVoice('')).toEqual({ value: null })
    expect(parseVoice('   ')).toEqual({ value: null })
  })

  it('trims a valid voice name', () => {
    expect(parseVoice('  alloy ')).toEqual({ value: 'alloy' })
    expect(parseVoice('en-US-Neural2-A')).toEqual({ value: 'en-US-Neural2-A' })
    expect(parseVoice('Kore')).toEqual({ value: 'Kore' })
    expect(parseVoice('voice_1.v2:beta')).toEqual({ value: 'voice_1.v2:beta' })
  })

  it('rejects what speechVoiceSchema rejects, with the inline message', () => {
    for (const text of ['alloy!', 'a/b', 'nova;rm', '<b>'])
      expect(parseVoice(text)).toEqual({ error: 'Voices use letters, digits, spaces and "_", ".", ":", "-".' })
    expect(parseVoice('x'.repeat(65))).toEqual({ error: 'Use at most 64 characters.' })
    expect(parseVoice('x'.repeat(64))).toEqual({ value: 'x'.repeat(64) })
    for (const text of ['alloy', 'x'.repeat(64)]) {
      const parsed = parseVoice(text)
      expect('value' in parsed && speechVoiceSchema.safeParse(parsed.value).success).toBe(true)
    }
  })

  it('suggests every voice without a query, else the voices containing it', () => {
    const voices = ['alloy', 'ash', 'ballad', 'coral', 'Sage', 'ash']
    expect(filterVoices(voices, '')).toEqual(['alloy', 'ash', 'ballad', 'coral', 'Sage'])
    expect(filterVoices(voices, ' A ')).toEqual(['alloy', 'ash', 'ballad', 'coral', 'Sage'])
    expect(filterVoices(voices, 'al')).toEqual(['alloy', 'ballad', 'coral'])
    expect(filterVoices(voices, 'SAGE')).toEqual(['Sage'])
    expect(filterVoices(voices, 'onyx')).toEqual([])
    expect(filterVoices([], 'a')).toEqual([])
  })
})

describe('test voice and origin', () => {
  it('reads a fixed sentence', () => {
    expect(TEST_VOICE_TEXT).toBe('This is how replies sound when they are read aloud.')
  })

  it('needs a secure context for the microphone', () => {
    vi.stubGlobal('isSecureContext', true)
    expect(isSecureOrigin()).toBe(true)
    vi.stubGlobal('isSecureContext', false)
    expect(isSecureOrigin()).toBe(false)
    vi.stubGlobal('isSecureContext', undefined)
    expect(isSecureOrigin()).toBe(false)
  })
})
