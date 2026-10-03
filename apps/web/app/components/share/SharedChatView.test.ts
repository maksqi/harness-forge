// The public share page (docs/UI.md 7.15): states, the transcript built from the chat part components, the head, and
// the guarantee that the whole tree is store-free and calls nothing but `shares.view`.
import type { ShareView } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { ComputedRef } from 'vue'
import { HarnessError } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import SharedChatView from './SharedChatView.vue'
import { allByTestId, byTestId, OTHER_TOKEN, settle, shareView, TOKEN } from './testing'

type ViewHandler = (input: { params: { token: string } }) => Promise<ShareView>

const mocks = vi.hoisted(() => ({
  /** Every `api.<module>.<action>` the tree touched, in order. */
  calls: [] as string[],
  view: null as unknown as ((input: { params: { token: string } }) => Promise<unknown>),
  useHead: vi.fn(),
}))

// A recording stand-in for the typed client: any route other than shares.view is recorded and rejects.
vi.mock('~/composables/useApi', () => ({
  useApi: () => new Proxy({}, {
    get: (_target, module) => new Proxy({}, {
      get: (_inner, action) => (input: { params: { token: string } }) => {
        mocks.calls.push(`${String(module)}.${String(action)}`)
        if (module === 'shares' && action === 'view')
          return mocks.view(input)
        return Promise.reject(new Error(`unexpected call ${String(module)}.${String(action)}`))
      },
    }),
  }),
  useApiFetch: () => vi.fn(),
}))
vi.mock('./nuxt-imports', () => ({ useHead: mocks.useHead, useRoute: vi.fn() }))
// Markdown (TextPart, ReasoningPart) reads the color mode.
vi.mock('~/components/chat/nuxt-imports', () => ({
  useColorMode: () => ({ value: 'dark', preference: 'dark' }),
  useRoute: vi.fn(),
  useRouter: vi.fn(),
  navigateTo: vi.fn(),
}))

let wrapper: VueWrapper | null = null

function mountView(token = TOKEN) {
  const props = reactive({ token })
  // app.vue provides the TooltipProvider around every layout.
  wrapper = mount({
    render: () => h(TooltipProvider, null, { default: () => h(SharedChatView, { token: props.token }) }),
  }, { attachTo: document.body })
  return props
}

function page(): HTMLElement {
  return byTestId(testIds.sharePage)!
}

function respond(view: ShareView | ViewHandler) {
  mocks.view = typeof view === 'function' ? view : async () => view
}

function fail(error: HarnessError) {
  mocks.view = async () => {
    throw error
  }
}

const FILE_URL = `/api/share/${TOKEN}/files/file_AAAAAAAAAAAAAAAA`

const KITCHEN_SINK = shareView({
  title: 'Refactor auth flow',
  options: { reasoning: true, toolDetails: false, attachments: true },
  messages: [
    {
      role: 'user',
      command: { name: 'review' },
      parts: [
        { type: 'file', mediaType: 'image/png', filename: 'screen.png', url: FILE_URL },
        { type: 'text', text: 'Can you move the auth flow to server sessions?' },
      ],
    },
    {
      role: 'assistant',
      modelRef: 'anthropic:claude-sonnet-5',
      status: 'stopped',
      parts: [
        { type: 'reasoning', text: 'The secret plan.' },
        { type: 'tool', toolName: 'mcp__docs__search', status: 'done' },
        { type: 'text', text: 'Here is **the plan**.' },
        { type: 'source-url', sourceId: 's1', url: 'https://nuxt.com/docs', title: 'Nuxt docs' },
        { type: 'source-document', sourceId: 's2', title: 'RFC 6265', mediaType: 'text/plain' },
      ],
    },
    {
      role: 'assistant',
      modelRef: 'openai:gpt-5',
      status: 'failed',
      parts: [],
    },
  ],
})

beforeEach(() => {
  mocks.calls = []
  mocks.useHead.mockReset()
  // No active Pinia at all: any store in the tree would throw.
  setActivePinia(undefined)
  respond(KITCHEN_SINK)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
})

describe('sharedChatView', () => {
  it('shows skeletons while loading, then the snapshot title, date and transcript', async () => {
    let resolve: (view: ShareView) => void = () => {}
    respond(() => new Promise<ShareView>((done) => {
      resolve = done
    }))
    mountView()
    expect(page().dataset.state).toBe('loading')
    expect(page().querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)

    resolve(KITCHEN_SINK)
    await settle()
    expect(page().dataset.state).toBe('ready')
    const title = byTestId(testIds.shareTitle)!
    expect(title.tagName).toBe('H1')
    expect(title.textContent?.trim()).toBe('Refactor auth flow')
    expect(document.querySelectorAll('h1')).toHaveLength(1)
    const meta = byTestId(testIds.shareMeta)!
    expect(meta.textContent).toContain('Read-only snapshot · ')
    expect(meta.textContent).toContain('2026')
    expect(meta.querySelector('time')?.getAttribute('datetime')).toBe(new Date(KITCHEN_SINK.snapshotAt).toISOString())
  })

  it('renders every message with the chat part components, as articles in a plain list', async () => {
    mountView()
    await settle()
    await new Promise(resolve => setTimeout(resolve, 30))
    const transcript = byTestId(testIds.shareTranscript)!
    expect(transcript.tagName).toBe('OL')
    const messages = allByTestId(testIds.shareMessage, transcript)
    expect(messages.map(message => [message.tagName, message.dataset.role, message.dataset.status])).toEqual([
      ['ARTICLE', 'user', 'done'],
      ['ARTICLE', 'assistant', 'stopped'],
      ['ARTICLE', 'assistant', 'failed'],
    ])

    const [user, reply, failed] = messages as [HTMLElement, HTMLElement, HTMLElement]
    // User: the transcript's bubble with the command badge, the plain text and the attachment above it.
    expect(user.querySelector('[data-slot="user-message"]')).not.toBeNull()
    expect(user.querySelector('[data-slot="command-badge"]')?.textContent).toContain('/review')
    expect(user.textContent).toContain('Can you move the auth flow to server sessions?')
    const image = byTestId(testIds.fileChip, user)!.querySelector('img')!
    expect(image.getAttribute('src')).toBe(FILE_URL)
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')

    // Assistant: collapsed reasoning labelled "Thought", the tool row, markdown text, one merged sources row, the
    // model id and "Stopped".
    const reasoning = byTestId(testIds.reasoningRow, reply)!
    expect(reasoning.dataset.state).toBe('done')
    expect(reasoning.dataset.expanded).toBe('false')
    expect(reasoning.textContent?.trim()).toBe('Thought')
    expect(reply.textContent).not.toContain('The secret plan.')
    expect(byTestId(testIds.shareToolRow, reply)?.dataset.toolName).toBe('mcp__docs__search')
    expect(reply.querySelector('[data-slot="markdown"] strong')?.textContent).toBe('the plan')
    expect(allByTestId(testIds.sourcesRow, reply)).toHaveLength(1)
    expect(byTestId(testIds.sourcesRow, reply)?.textContent).toContain('2 sources')
    const meta = reply.querySelector('[data-slot="share-message-meta"]')!
    expect(meta.textContent?.replace(/\s+/g, ' ').trim()).toBe('claude-sonnet-5 · Stopped')
    expect(meta.querySelector('.font-mono')?.textContent).toBe('claude-sonnet-5')

    // A failed reply says so, without any error detail.
    expect(failed.textContent).toContain('This reply failed.')
    expect(failed.querySelector('[data-slot="share-message-meta"]')?.textContent?.trim()).toBe('gpt-5')

    // Never the store-backed or interactive chat pieces.
    for (const id of [testIds.toolRow, testIds.chatError, testIds.messageUser, testIds.messageAssistant])
      expect(byTestId(id), id).toBeNull()
    expect(document.body.querySelector('[data-testid="message-branch"]')).toBeNull()
  })

  it('shows the generated images of a reply as a gallery with its lightbox and Download link', async () => {
    const imageUrl = (id: string) => `/api/share/${TOKEN}/files/file_${id.repeat(16)}`
    respond(shareView({
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'Draw a red fox.' }] },
        {
          role: 'assistant',
          modelRef: 'mock:image',
          parts: [
            { type: 'tool', toolName: 'generate_image', status: 'done' },
            { type: 'file', mediaType: 'image/png', filename: 'image-1.png', url: imageUrl('A') },
            { type: 'file', mediaType: 'image/png', filename: 'image-2.png', url: imageUrl('B') },
            { type: 'text', text: 'Here are two foxes.' },
            { type: 'file', mediaType: 'application/pdf', filename: 'notes.pdf', url: imageUrl('C') },
          ],
        },
      ],
    }))
    mountView()
    await settle()
    const reply = allByTestId(testIds.shareMessage)[1]!
    const gallery = byTestId(testIds.imageGallery, reply)!
    expect(gallery.dataset.messageId).toBe('share-message-1')
    expect(gallery.dataset.count).toBe('2')
    const tiles = allByTestId<HTMLButtonElement>(testIds.imageTile, gallery)
    expect(tiles.map(tile => tile.querySelector('img')?.getAttribute('src'))).toEqual([imageUrl('A'), imageUrl('B')])
    // The PDF stays a chip, outside the gallery.
    expect(byTestId(testIds.fileChip, reply)?.textContent).toContain('notes.pdf')
    expect(byTestId(testIds.fileChip, gallery)).toBeNull()

    tiles[1]!.click()
    await settle()
    const lightbox = byTestId(testIds.imageLightbox)!
    expect(lightbox.dataset.index).toBe('1')
    const download = byTestId<HTMLAnchorElement>(testIds.imageDownload)!
    expect(download.getAttribute('href')).toBe(imageUrl('B'))
    expect(download.getAttribute('download')).toBe('image-2.png')
    expect(mocks.calls).toEqual(['shares.view'])
  })

  it('renders a reply split at a steer as reply, user bubble, reply, and never a compaction (Phase 9)', async () => {
    respond(shareView({
      options: { reasoning: false, toolDetails: false, attachments: true },
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'Fix the parser.' }] },
        {
          role: 'assistant',
          modelRef: 'mock:steer',
          parts: [
            { type: 'tool', toolName: 'todo_write', status: 'done' },
            { type: 'text', text: 'Step 1 done.' },
          ],
        },
        // The steer, split out by the server: an ordinary user message with its file.
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'Use the vitest filter instead' },
            { type: 'file', mediaType: 'application/pdf', filename: 'filter.pdf', url: FILE_URL },
          ],
        },
        {
          role: 'assistant',
          modelRef: 'mock:steer',
          parts: [
            { type: 'tool', toolName: 'task', status: 'done' },
            { type: 'tool', toolName: 'exit_plan_mode', status: 'done' },
            { type: 'text', text: 'Switched to the vitest filter.' },
          ],
        },
        // A /compact reply: the server dropped its marker.
        { role: 'user', command: { name: 'compact' }, parts: [{ type: 'text', text: '/compact' }] },
        { role: 'assistant', modelRef: 'mock:steer', parts: [] },
      ],
    }))
    mountView()
    await settle()
    const messages = allByTestId(testIds.shareMessage)
    expect(messages.map(message => message.dataset.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    const steer = messages[2]!
    expect(steer.querySelector('[data-slot="user-message"]')?.textContent).toContain('Use the vitest filter instead')
    expect(byTestId(testIds.fileChip, steer)?.textContent).toContain('filter.pdf')
    expect(steer.querySelector('[data-slot="share-message-meta"]')).toBeNull()
    // The agent tools are share tool rows (bodies only with tool details, ShareToolRow's part).
    expect(allByTestId(testIds.shareToolRow).map(row => row.dataset.toolName)).toEqual(['todo_write', 'task', 'exit_plan_mode'])
    // None of the chat's own agent pieces: no steer note, divider, summary or dimming.
    for (const id of [testIds.steerNote, testIds.compactionDivider, testIds.compactionSummary, testIds.taskBlock, testIds.planApproval])
      expect(byTestId(id), id).toBeNull()
    expect(document.body.querySelector('[data-compacted]')).toBeNull()
    expect(messages[4]!.querySelector('[data-slot="command-badge"]')?.textContent).toContain('/compact')
    expect(mocks.calls).toEqual(['shares.view'])
  })

  it('calls nothing but shares.view with the token, without any store', async () => {
    mountView()
    await settle()
    // Expand what can be expanded: still nothing else is requested.
    byTestId<HTMLButtonElement>(testIds.sourcesRow)!.click()
    byTestId(testIds.reasoningRow)!.querySelector('button')!.click()
    await settle()
    expect(mocks.calls).toEqual(['shares.view'])
    expect(page().dataset.state).toBe('ready')
  })

  it('passes the token to shares.view', async () => {
    const view = vi.fn(async () => KITCHEN_SINK)
    respond(view)
    mountView()
    await settle()
    expect(view).toHaveBeenCalledWith({ params: { token: TOKEN } })
  })

  it('sets the title, noindex and no-referrer in the head', async () => {
    mountView()
    const head = mocks.useHead.mock.calls[0]![0] as { title: ComputedRef<string>, meta: Array<{ name: string, content: string }> }
    expect(head.meta).toEqual([
      { name: 'robots', content: 'noindex, nofollow' },
      { name: 'referrer', content: 'no-referrer' },
    ])
    expect(head.title.value).toBe('Shared chat · harness-forge')
    await settle()
    expect(head.title.value).toBe('Refactor auth flow · harness-forge')
  })

  it('names an untitled snapshot "Untitled chat"', async () => {
    respond(shareView({ title: null }))
    mountView()
    await settle()
    expect(byTestId(testIds.shareTitle)?.textContent?.trim()).toBe('Untitled chat')
    expect(byTestId(testIds.shareTranscript)?.children).toHaveLength(0)
  })

  it('shows "This link is unavailable" for a 404, and for a malformed token without asking the server', async () => {
    fail(new HarnessError({ code: 'not_found', message: 'Not found.' }))
    mountView()
    await settle()
    expect(page().dataset.state).toBe('unavailable')
    const unavailable = byTestId(testIds.shareUnavailable)!
    expect(unavailable.querySelector('h1')?.textContent).toBe('This link is unavailable')
    expect(unavailable.textContent).toContain('It may have expired or been revoked, or the chat was deleted.')
    expect(byTestId(testIds.sharePageRetry)).toBeNull()
    const head = mocks.useHead.mock.calls[0]![0] as { title: ComputedRef<string> }
    expect(head.title.value).toBe('Link unavailable · harness-forge')

    wrapper!.unmount()
    mocks.calls = []
    mountView('not-a-token')
    await settle()
    expect(page().dataset.state).toBe('unavailable')
    expect(mocks.calls).toEqual([])
  })

  it('shows other failures with the server message and Try again', async () => {
    fail(new HarnessError({ code: 'internal_error', message: 'Something broke.' }))
    mountView()
    await settle()
    expect(page().dataset.state).toBe('error')
    const error = byTestId(testIds.sharePageError)!
    expect(error.dataset.code).toBe('internal_error')
    expect(error.textContent).toContain('Couldn\'t load this chat')
    expect(error.textContent).toContain('Something broke.')

    respond(KITCHEN_SINK)
    byTestId<HTMLButtonElement>(testIds.sharePageRetry)!.click()
    await settle()
    expect(page().dataset.state).toBe('ready')
    expect(mocks.calls).toEqual(['shares.view', 'shares.view'])
  })

  it('says how long to wait when rate limited', async () => {
    fail(new HarnessError({ code: 'rate_limited', message: 'Too many requests.', retryAfterMs: 11_200 }))
    mountView()
    await settle()
    const error = byTestId(testIds.sharePageError)!
    expect(error.dataset.code).toBe('rate_limited')
    expect(error.textContent).toContain('Too many requests. Try again in 12s.')
  })

  it('loads again when the token changes', async () => {
    const view = vi.fn(async ({ params }: { params: { token: string } }) => shareView({ title: params.token === TOKEN ? 'First' : 'Second' }))
    respond(view)
    const props = mountView()
    await settle()
    expect(byTestId(testIds.shareTitle)?.textContent?.trim()).toBe('First')
    props.token = OTHER_TOKEN
    await nextTick()
    await settle()
    expect(view).toHaveBeenLastCalledWith({ params: { token: OTHER_TOKEN } })
    expect(byTestId(testIds.shareTitle)?.textContent?.trim()).toBe('Second')
  })
})
