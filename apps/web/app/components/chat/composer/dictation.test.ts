import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it, vi } from 'vitest'
import { mediaError } from '~/utils/testing/fake-media'
import { dictationErrorToast, insertDictation, pickRecorderMimeType, RECORDER_MIME_TYPES, recordingFileName } from './dictation'

describe('insertDictation', () => {
  it('inserts at the caret with a space before and after when needed; the caret ends after the transcript', () => {
    const cases: Array<[text: string, at: number, transcript: string, expected: string, caret: number]> = [
      ['', 0, 'Hello there.', 'Hello there.', 12],
      ['Hello ', 6, 'This is a mock transcription.', 'Hello This is a mock transcription.', 35],
      ['Hello', 5, 'world', 'Hello world', 11],
      ['Hello world', 0, 'Well', 'Well Hello world', 4],
      ['Hello world', 5, 'big', 'Hello big world', 9],
      ['Hello world', 6, 'big', 'Hello big world', 9],
      ['Hello.', 5, 'there', 'Hello there.', 11],
      ['(', 1, 'aside', '(aside', 6],
      ['See ()', 5, 'notes', 'See (notes)', 10],
      ['He said "', 9, 'yes', 'He said "yes', 12],
      ['"quoted"', 8, 'next', '"quoted" next', 13],
      ['a\n', 2, 'line', 'a\nline', 6],
      ['ends here', 9, 'and more', 'ends here and more', 18],
      ['x', 0, '(note)', '(note) x', 6],
    ]
    for (const [text, at, transcript, expected, caret] of cases)
      expect(insertDictation(text, transcript, at), JSON.stringify([text, at])).toEqual({ text: expected, caret })
  })

  it('replaces a selection, trims the transcript and clamps positions', () => {
    expect(insertDictation('Hello old world', 'new', { start: 6, end: 9 })).toEqual({ text: 'Hello new world', caret: 9 })
    expect(insertDictation('abc', '  spoken  ', { start: 10, end: 99 })).toEqual({ text: 'abc spoken', caret: 10 })
    expect(insertDictation('abc', 'x', { start: 2, end: 1 })).toEqual({ text: 'ab x c', caret: 4 })
    expect(insertDictation('abc', 'x', Number.NaN)).toEqual({ text: 'abc x', caret: 5 })
    expect(insertDictation('text', 'at end')).toEqual({ text: 'text at end', caret: 11 })
  })

  it('changes nothing for an empty transcript', () => {
    expect(insertDictation('Hello', '   ', 2)).toEqual({ text: 'Hello', caret: 2 })
    expect(insertDictation('', '')).toEqual({ text: '', caret: 0 })
  })
})

describe('pickRecorderMimeType', () => {
  it('prefers Opus in WebM, then WebM, Opus in Ogg and MP4 (Safari)', () => {
    expect(RECORDER_MIME_TYPES).toEqual(['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'])
    const supporting = (types: string[]) => ({ isTypeSupported: (type: string) => types.includes(type) })
    expect(pickRecorderMimeType(supporting(['audio/webm', 'audio/webm;codecs=opus']))).toBe('audio/webm;codecs=opus')
    expect(pickRecorderMimeType(supporting(['audio/webm']))).toBe('audio/webm')
    expect(pickRecorderMimeType(supporting(['audio/mp4', 'audio/ogg;codecs=opus']))).toBe('audio/ogg;codecs=opus')
    expect(pickRecorderMimeType(supporting(['audio/mp4']))).toBe('audio/mp4')
  })

  it('falls back to the browser default (undefined) when nothing matches or the check is missing', () => {
    expect(pickRecorderMimeType({ isTypeSupported: () => false })).toBeUndefined()
    expect(pickRecorderMimeType({})).toBeUndefined()
    expect(pickRecorderMimeType(undefined)).toBeUndefined()
  })

  it('skips a type whose check throws', () => {
    const isTypeSupported = vi.fn((type: string) => {
      if (type === 'audio/webm;codecs=opus')
        throw new Error('boom')
      return type === 'audio/webm'
    })
    expect(pickRecorderMimeType({ isTypeSupported })).toBe('audio/webm')
  })
})

describe('recordingFileName', () => {
  it('names the clip by its container, ignoring parameters', () => {
    expect(recordingFileName('audio/webm;codecs=opus')).toBe('dictation.webm')
    expect(recordingFileName('audio/ogg; codecs=opus')).toBe('dictation.ogg')
    expect(recordingFileName('audio/mp4')).toBe('dictation.m4a')
    expect(recordingFileName('audio/mpeg')).toBe('dictation.mp3')
    expect(recordingFileName('audio/wav')).toBe('dictation.wav')
    expect(recordingFileName('')).toBe('dictation.webm')
    expect(recordingFileName('application/octet-stream')).toBe('dictation.webm')
  })
})

describe('dictationErrorToast', () => {
  it('explains the microphone errors of getUserMedia', () => {
    expect(dictationErrorToast(mediaError('NotAllowedError'))).toEqual({ title: 'Microphone access is blocked. Allow it in the browser\'s site settings.' })
    expect(dictationErrorToast(mediaError('NotFoundError'))).toEqual({ title: 'No microphone was found.' })
    expect(dictationErrorToast(mediaError('NotReadableError'))).toEqual({ title: 'The microphone is in use by another app.' })
    expect(dictationErrorToast(new DOMException('Voice input needs HTTPS or localhost.', 'SecurityError'))).toEqual({ title: 'Voice input needs HTTPS or localhost' })
    expect(dictationErrorToast(new DOMException('No recorder', 'NotSupportedError'))).toEqual({ title: 'This browser can\'t record audio.' })
  })

  it('says the recording is too long for 413', () => {
    const error = new HarnessError({ code: 'payload_too_large', message: 'The request body is too large.', details: { limitBytes: 26_214_400 } })
    expect(dictationErrorToast(error)).toEqual({ title: 'The recording is too long.' })
  })

  it('uses the 7.4 title with the provider name and the server message for provider errors', () => {
    const missingKey = new HarnessError({ code: 'provider_not_configured', message: 'Add an API key for Groq in Settings.', providerId: 'groq' })
    expect(dictationErrorToast(missingKey, id => (id === 'groq' ? 'Groq' : undefined)))
      .toEqual({ title: 'No API key for Groq', description: 'Add an API key for Groq in Settings.' })
    const limited = new HarnessError({ code: 'rate_limited', message: 'Slow down.', providerId: 'openai' })
    expect(dictationErrorToast(limited)).toEqual({ title: 'Rate limited by openai', description: 'Slow down.' })
    const invalid = new HarnessError({ code: 'validation_error', message: 'The recording is empty.' })
    expect(dictationErrorToast(invalid)).toEqual({ title: 'Some values are not valid', description: 'The recording is empty.' })
  })

  it('never shows raw text for unknown failures', () => {
    expect(dictationErrorToast(new Error('secret stack'))).toEqual({ title: 'Something went wrong', description: 'An unexpected error occurred. Try again.' })
    expect(dictationErrorToast('nope')).toEqual({ title: 'Something went wrong', description: 'An unexpected error occurred. Try again.' })
  })
})
