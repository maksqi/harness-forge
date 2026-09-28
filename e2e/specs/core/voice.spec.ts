// Voice (docs/UI.md 7.17, 7.18, 9.9, 12, 14.7; docs/API.md 4.19; ADR-029) with the mock media models
// (docs/PROVIDERS.md 8): dictation records the microphone (Chromium's fake device, granted by playwright.config.ts) and
// sends the clip as the multipart part `file` of `POST /api/audio/transcriptions`, which `mock:transcribe` answers with
// "This is a mock transcription."; read-aloud sends `{ text }` to `POST /api/audio/speech`, which `mock:speech` answers
// with a silent WAV (400 ms per word, 1 s to 6 s) played by one app-wide player. Both are opt-in in Settings -> Media;
// every test sets the models it needs through the API and restores the media settings afterwards.
import type { Locator, Page } from '@playwright/test'
import {
  assistantMessages,
  byTestId,
  composer,
  expect,
  mediaSettingsOf,
  multipartParts,
  NO_MEDIA_SETTINGS,
  openNewChat,
  recordRequests,
  test,
  testIds,
  uniqueId,
  wordList,
} from '../../helpers/index.ts'

const TRANSCRIPT = 'This is a mock transcription.'
const TEST_VOICE_TEXT = 'This is how replies sound when they are read aloud.'
const TRANSCRIPTIONS_PATH = '/api/audio/transcriptions'
const SPEECH_PATH = '/api/audio/speech'
/** EBML magic: every WebM file starts with it. */
const WEBM_MAGIC = [0x1A, 0x45, 0xDF, 0xA3]

/** The composer's mic button. */
function micOf(page: Page): Locator {
  return composer(page).getByTestId(testIds.composerMic)
}

/** Waits until `button` reaches `state`, polling fast (a short reading plays for about 2 s). */
async function expectReadAloudState(button: Locator, state: 'idle' | 'loading' | 'playing', timeout = 10_000): Promise<void> {
  await expect.poll(() => button.getAttribute('data-state'), { intervals: [50], timeout, message: `read aloud is ${state}` }).toBe(state)
}

test.describe('voice', () => {
  // Every test changes Settings -> Media: the cleanup puts back what was there.
  test.beforeEach(async ({ api, cleanup }) => {
    const before = mediaSettingsOf(await api.getSettings())
    cleanup(api => api.updateSettings(before))
  })

  test('dictation records until the timer shows 0:01, then the transcript goes in at the caret @smoke', async ({ page, api }) => {
    await api.updateSettings({ ...NO_MEDIA_SETTINGS, transcriptionModelRef: 'mock:transcribe' })

    await openNewChat(page)
    const input = page.getByTestId(testIds.composerInput)
    await input.fill('Hello ')
    const mic = micOf(page)
    await expect(mic).toHaveAttribute('data-state', 'idle')
    await expect(mic).toHaveAccessibleName('Dictate')
    await expect(mic).toHaveAttribute('aria-keyshortcuts', 'Alt+V')
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    const uploads = await recordRequests(page, 'POST', TRANSCRIPTIONS_PATH)

    // Recording: the indicator (dot, timer, Cancel) replaces the left tools, the mic is Stop, Send waits.
    await mic.click()
    await expect(mic).toHaveAttribute('data-state', 'recording')
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await expect(mic).toHaveAccessibleName('Stop and transcribe')
    const indicator = composer(page).getByTestId(testIds.composerRecording)
    await expect(indicator).toBeVisible()
    await expect(indicator.getByTestId(testIds.composerMicCancel)).toBeVisible()
    await expect(composer(page).getByTestId(testIds.modelPickerTrigger)).toHaveCount(0)
    await expect(composer(page).getByTestId(testIds.composerAdd)).toHaveCount(0)
    await expect(page.getByTestId(testIds.composerSend)).toHaveAttribute('data-state', 'disabled')
    await expect(indicator.getByTestId(testIds.composerRecordingTime)).toHaveText('0:01', { timeout: 5_000 })

    // Stop: the clip goes to the server as one multipart WebM part named `file` (no model, no language).
    const answered = page.waitForResponse(response => new URL(response.url()).pathname === TRANSCRIPTIONS_PATH)
    await mic.click()
    const response = await answered
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ text: TRANSCRIPT })
    expect(uploads.requests).toHaveLength(1)
    const [upload] = uploads.requests
    const contentType = upload!.headers['content-type'] ?? ''
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/)
    const parts = multipartParts(upload!.body ?? new Uint8Array(), contentType)
    expect(parts.map(part => part.name)).toEqual(['file'])
    const [clip] = parts
    expect(clip!.filename).toBe('dictation.webm')
    expect(clip!.contentType).toMatch(/^audio\/webm\b/)
    expect([...clip!.head.subarray(0, 4)]).toEqual(WEBM_MAGIC)
    expect(clip!.size).toBeGreaterThan(100)

    // The transcript follows the typed text (one space, no double space), the textarea has focus again.
    await expect(input).toHaveValue(`Hello ${TRANSCRIPT}`)
    await expect(mic).toHaveAttribute('data-state', 'idle')
    await expect(indicator).toHaveCount(0)
    await expect(input).toBeFocused()
    await expect(page.getByTestId(testIds.composerSend)).toHaveAttribute('data-state', 'ready')
    expect(uploads.requests).toHaveLength(1)
    await uploads.stop()
  })

  test('Esc cancels a recording without a request; Alt+V starts and stops dictation @smoke', async ({ page, api }) => {
    await api.updateSettings({ ...NO_MEDIA_SETTINGS, transcriptionModelRef: 'mock:transcribe' })

    await openNewChat(page)
    const input = page.getByTestId(testIds.composerInput)
    await input.fill('Keep this text')
    const mic = micOf(page)
    const uploads = await recordRequests(page, 'POST', TRANSCRIPTIONS_PATH)

    // Alt+V in the textarea starts recording; Esc there cancels it: nothing is sent and the text stays.
    await input.press('Alt+v')
    await expect(mic).toHaveAttribute('data-state', 'recording')
    await expect(composer(page).getByTestId(testIds.composerRecordingTime)).toHaveText('0:01', { timeout: 5_000 })
    await expect(input).toBeFocused()
    await input.press('Escape')
    await expect(mic).toHaveAttribute('data-state', 'idle')
    await expect(composer(page).getByTestId(testIds.composerRecording)).toHaveCount(0)
    await expect(input).toHaveValue('Keep this text')

    // Esc outside the textarea (focus on the mic) cancels too.
    await mic.click()
    await expect(mic).toHaveAttribute('data-state', 'recording')
    await expect(mic).toBeFocused()
    await expect(composer(page).getByTestId(testIds.composerRecordingTime)).toHaveText('0:01', { timeout: 5_000 })
    await page.keyboard.press('Escape')
    await expect(mic).toHaveAttribute('data-state', 'idle')

    // Cancel of the indicator drops the recording as well.
    await mic.click()
    await expect(mic).toHaveAttribute('data-state', 'recording')
    await expect(composer(page).getByTestId(testIds.composerRecordingTime)).toHaveText('0:01', { timeout: 5_000 })
    await composer(page).getByTestId(testIds.composerMicCancel).click()
    await expect(mic).toHaveAttribute('data-state', 'idle')
    await expect(input).toHaveValue('Keep this text')

    // A full dictation with Alt+V (start and stop, the caret at the end): the only request of this test.
    await input.click()
    await input.press('Alt+v')
    await expect(mic).toHaveAttribute('data-state', 'recording')
    await expect(composer(page).getByTestId(testIds.composerRecordingTime)).toHaveText('0:01', { timeout: 5_000 })
    const answered = page.waitForResponse(response => new URL(response.url()).pathname === TRANSCRIPTIONS_PATH)
    await input.press('Alt+v')
    expect((await answered).status()).toBe(200)
    await expect(input).toHaveValue(`Keep this text ${TRANSCRIPT}`)
    expect(uploads.requests, 'the canceled recordings sent nothing').toHaveLength(1)
    await uploads.stop()
  })

  test('without a speech-to-text model the mic opens the setup popover, which leads to Settings -> Media @smoke', async ({ page, api }) => {
    await api.updateSettings(NO_MEDIA_SETTINGS)

    await openNewChat(page)
    const mic = micOf(page)
    await expect(mic).toHaveAttribute('data-state', 'setup')
    await expect(mic).toHaveAttribute('aria-expanded', 'false')
    await mic.click()
    const setup = page.getByTestId(testIds.composerMicSetup)
    await expect(setup).toBeVisible()
    await expect(setup).toContainText('Choose a speech-to-text model to dictate messages.')
    await expect(mic).toHaveAttribute('aria-expanded', 'true')
    await setup.getByTestId(testIds.composerMicSetupLink).click()
    await expect(page).toHaveURL(/\/settings\/media$/)
    await expect(page.getByTestId(testIds.mediaSettings)).toBeVisible()
    await expect(page.getByTestId(testIds.settingsNavMedia)).toHaveAttribute('data-state', 'active')
    await expect(page.getByTestId(testIds.settingsTranscriptionModel)).toHaveAttribute('data-value', '')
  })

  test('read aloud sends the reply text, plays, stops on Stop, Esc and its end, and a second reply stops the first @smoke', async ({ page, api, cleanup }) => {
    await api.updateSettings({ ...NO_MEDIA_SETTINGS, speechModelRef: 'mock:speech' })
    const token = uniqueId('speech')
    // Long replies play for 6 s (the mock's longest clip), the short one for 2 s (five words). Each ends with a period:
    // read-aloud ends every block with sentence punctuation, so the sent text equals the reply.
    const first = `First reply to read ${token} ${wordList(12, 'a').join(' ')}.`
    const second = `Second reply to read ${token} ${wordList(12, 'b').join(' ')}.`
    const short = `Short reply ${token} to hear.`
    const { chatId } = await api.sendChat({ text: first })
    cleanup(api => api.removeChat(chatId))
    await api.sendChat({ chatId, text: second })
    await api.sendChat({ chatId, text: short })

    await page.goto(`/chat/${chatId}`)
    const replies = assistantMessages(page)
    await expect(replies).toHaveCount(3)
    await expect(replies.last()).toHaveAttribute('data-status', 'done')
    const speech = await recordRequests(page, 'POST', SPEECH_PATH)

    // The last reply: the request carries its text (the model and voice come from the settings), it plays and its
    // natural end returns to idle.
    const lastButton = replies.nth(2).getByTestId(testIds.messageReadAloud)
    await expect(lastButton).toHaveAttribute('data-state', 'idle')
    await expect(lastButton).toHaveAccessibleName('Read aloud')
    await lastButton.click()
    await expectReadAloudState(lastButton, 'playing')
    const playingSince = Date.now()
    expect(speech.jsonBodies()).toEqual([{ text: short }])
    await expect(lastButton).toHaveAttribute('aria-pressed', 'true')
    await expect(lastButton).toHaveAccessibleName('Stop reading')
    await expectReadAloudState(lastButton, 'idle')
    // The end of the 2 s clip, not a failure: it played for a while and no error toast came up.
    expect(Date.now() - playingSince, 'the clip played to its end').toBeGreaterThan(1_200)
    await expect(page.getByText('Could not read this reply aloud')).toHaveCount(0)
    await expect(lastButton).toHaveAttribute('aria-pressed', 'false')

    // The first reply plays; Read aloud of the second one stops it and plays the second one instead.
    const firstButton = replies.nth(0).getByTestId(testIds.messageReadAloud)
    const secondButton = replies.nth(1).getByTestId(testIds.messageReadAloud)
    await firstButton.click()
    await expectReadAloudState(firstButton, 'playing')
    await secondButton.click()
    await expectReadAloudState(firstButton, 'idle')
    await expect(firstButton).toHaveAttribute('aria-pressed', 'false')
    await expectReadAloudState(secondButton, 'playing')

    // Stop reading.
    await secondButton.click()
    await expectReadAloudState(secondButton, 'idle')

    // Esc outside inputs stops a reading too.
    await firstButton.click()
    await expectReadAloudState(firstButton, 'playing')
    await page.keyboard.press('Escape')
    await expectReadAloudState(firstButton, 'idle')

    expect(speech.jsonBodies()).toEqual([{ text: short }, { text: first }, { text: second }, { text: first }])
    await speech.stop()
  })

  test('Settings -> Media saves the models, the language, the voice and the speed; Test voice plays them @smoke', async ({ page, api }) => {
    await api.updateSettings(NO_MEDIA_SETTINGS)

    await page.goto('/settings/providers')
    await page.getByTestId(testIds.settingsNavMedia).click()
    await expect(page).toHaveURL(/\/settings\/media$/)
    await expect(page.getByTestId(testIds.settingsNavMedia)).toHaveAttribute('data-state', 'active')
    const media = page.getByTestId(testIds.mediaSettings)
    await expect(media).toBeVisible()
    await expect(page.getByTestId(testIds.pageHeader)).toContainText('Images and voice')
    await expect(media.getByTestId(testIds.imageSettings)).toBeVisible()
    await expect(media.getByTestId(testIds.voiceSettings)).toBeVisible()

    // Image model: only image models are offered.
    const imageModel = page.getByTestId(testIds.settingsImageModel)
    await expect(imageModel).toHaveAttribute('data-value', '')
    await imageModel.click()
    await expect(byTestId(page, testIds.modelSelectOption, { 'data-model-ref': 'mock:image' })).toBeVisible()
    await expect(byTestId(page, testIds.modelSelectOption, { 'data-model-ref': 'mock:echo' })).toHaveCount(0)
    await byTestId(page, testIds.modelSelectOption, { 'data-model-ref': 'mock:image' }).click()
    await expect(imageModel).toHaveAttribute('data-value', 'mock:image')
    await expect.poll(async () => (await api.getSettings()).imageModelRef).toBe('mock:image')

    // Speech to text, then its language (disabled while speech to text is off).
    const language = page.getByTestId(testIds.settingsTranscriptionLanguage)
    await expect(language).toBeDisabled()
    const transcription = page.getByTestId(testIds.settingsTranscriptionModel)
    await transcription.click()
    await expect(byTestId(page, testIds.modelSelectOption, { 'data-model-ref': 'mock:speech' })).toHaveCount(0)
    await byTestId(page, testIds.modelSelectOption, { 'data-model-ref': 'mock:transcribe' }).click()
    await expect(transcription).toHaveAttribute('data-value', 'mock:transcribe')
    await expect.poll(async () => (await api.getSettings()).transcriptionModelRef).toBe('mock:transcribe')
    await expect(language).toBeEnabled()
    await expect(language).toHaveAttribute('data-value', 'auto')
    await language.click()
    await page.getByRole('option', { name: /^English/ }).click()
    await expect(language).toHaveAttribute('data-value', 'en')
    await expect.poll(async () => (await api.getSettings()).transcriptionLanguage).toBe('en')

    // Read aloud, then its voice (suggested by the model) and speed (both disabled while read aloud is off).
    const voice = page.getByTestId(testIds.settingsSpeechVoice)
    const speed = page.getByTestId(testIds.settingsSpeechSpeed)
    const testVoice = page.getByTestId(testIds.settingsSpeechTest)
    await expect(voice).toBeDisabled()
    await expect(speed).toBeDisabled()
    await expect(testVoice).toBeDisabled()
    const speechModel = page.getByTestId(testIds.settingsSpeechModel)
    await speechModel.click()
    await byTestId(page, testIds.modelSelectOption, { 'data-model-ref': 'mock:speech' }).click()
    await expect(speechModel).toHaveAttribute('data-value', 'mock:speech')
    await expect.poll(async () => (await api.getSettings()).speechModelRef).toBe('mock:speech')
    await expect(voice).toBeEnabled()
    await expect(voice).toHaveAttribute('placeholder', 'Provider default')
    await voice.click()
    const voices = page.getByRole('listbox', { name: 'Voices' })
    await expect(voices.getByRole('option')).toHaveText(['mock-voice-a', 'mock-voice-b'])
    await voices.getByRole('option', { name: 'mock-voice-b' }).click()
    await expect(voice).toHaveValue('mock-voice-b')
    await expect.poll(async () => (await api.getSettings()).speechVoice).toBe('mock-voice-b')
    await expect(speed).toHaveAttribute('data-value', '1')
    await speed.click()
    await page.getByRole('option', { name: '1.5×' }).click()
    await expect(speed).toHaveAttribute('data-value', '1.5')
    await expect.poll(async () => (await api.getSettings()).speechSpeed).toBe(1.5)

    // Test voice reads the sample sentence with the chosen model and voice; Stop ends it.
    await expect(testVoice).toHaveAttribute('data-state', 'idle')
    const speech = await recordRequests(page, 'POST', SPEECH_PATH)
    await testVoice.click()
    await expectReadAloudState(testVoice, 'playing')
    expect(speech.jsonBodies()).toEqual([{ text: TEST_VOICE_TEXT, modelRef: 'mock:speech', voice: 'mock-voice-b' }])
    await speech.stop()
    await expect(testVoice).toHaveText('Stop')
    await expect(testVoice).toBeFocused()
    await testVoice.click()
    await expectReadAloudState(testVoice, 'idle')
    await expect(testVoice).toHaveText('Test voice')

    // Everything is there after a reload.
    await page.reload()
    await expect(page.getByTestId(testIds.settingsImageModel)).toHaveAttribute('data-value', 'mock:image')
    await expect(page.getByTestId(testIds.settingsTranscriptionModel)).toHaveAttribute('data-value', 'mock:transcribe')
    await expect(page.getByTestId(testIds.settingsTranscriptionLanguage)).toHaveAttribute('data-value', 'en')
    await expect(page.getByTestId(testIds.settingsSpeechModel)).toHaveAttribute('data-value', 'mock:speech')
    await expect(page.getByTestId(testIds.settingsSpeechVoice)).toHaveValue('mock-voice-b')
    await expect(page.getByTestId(testIds.settingsSpeechSpeed)).toHaveAttribute('data-value', '1.5')
  })
})
