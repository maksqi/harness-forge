// Test helpers of the bulk data tests (W5.3): an app with the fake chats service (message tree and bulk members, C8),
// the real files service, a recording event bus and a fake runner; message builders; zip readers.
import type { ChatCreate, FileRef, HarnessUIMessage } from '@harness-forge/shared'
import type { TestApp, TestAppOptions } from '../../testing/create-test-app.ts'
import type { FakeChatRunner, RecordingEventBus } from '../../testing/fakes.ts'
import type { AppDeps } from '../../types.ts'
import type { ChatsService } from '../chats/types.ts'
import type { FilesServiceOptions } from '../files/index.ts'
import type { FilesService } from '../files/types.ts'
import type { DataServiceOptions } from './index.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeChatRunner, createFakeChatsService, createRecordingEventBus, readAllBytes } from '../../testing/fakes.ts'
import { createFilesService } from '../files/index.ts'
import { createDataService } from './index.ts'

export interface DataTestApp {
  t: TestApp
  deps: AppDeps
  events: RecordingEventBus
  runs: FakeChatRunner
}

export interface DataTestAppOptions {
  data?: DataServiceOptions
  /** Wraps the (fake) chats service, e.g. to count or delay calls. */
  chats?: (chats: ChatsService) => ChatsService
  /** Options of the real files service (e.g. its clock), and a wrapper of it (Phase 7 cleanup tests). */
  filesOptions?: FilesServiceOptions
  files?: (files: FilesService) => FilesService
  env?: TestAppOptions['env']
}

/** Every app created by `dataApp`, closed by `closeDataApps()` (call it in `afterEach`). */
const apps: TestApp[] = []

export async function dataApp(options: DataTestAppOptions = {}): Promise<DataTestApp> {
  const events = createRecordingEventBus()
  const runs = createFakeChatRunner()
  const t = await createTestApp({
    start: false,
    ...(options.env === undefined ? {} : { env: options.env }),
    overrides: { events, runs },
    factories: {
      chats: (deps) => {
        const chats = createFakeChatsService(deps)
        return options.chats?.(chats) ?? chats
      },
      data: deps => createDataService(deps, options.data),
      files: (deps) => {
        const files = createFilesService(deps, options.filesOptions)
        return options.files?.(files) ?? files
      },
    },
  })
  apps.push(t)
  return { t, deps: t.deps, events, runs }
}

export async function closeDataApps(): Promise<void> {
  for (const app of apps.splice(0))
    await app.close()
}

export function chatId(n: number): string {
  return `0199a8f0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
}

export function mid(n: number): string {
  return `msg_${n.toString().padStart(16, '0')}`
}

export function user(n: number, text = `question ${n}`, extra: HarnessUIMessage['parts'] = []): HarnessUIMessage {
  return { id: mid(n), role: 'user', metadata: { modelRef: 'mock:echo', startedAt: 1_000 + n }, parts: [{ type: 'text', text }, ...extra] }
}

export function assistant(n: number, text = `answer ${n}`): HarnessUIMessage {
  return { id: mid(n), role: 'assistant', metadata: { modelRef: 'mock:echo', startedAt: 1_000 + n }, parts: [{ type: 'text', text, state: 'done' }] }
}

export function filePart(ref: FileRef): HarnessUIMessage['parts'][number] {
  return { type: 'file', mediaType: ref.mime, filename: ref.name, url: ref.url }
}

/**
 * ARCHITECTURE.md 6.8: A (1) -> RA (2) -> B (3) -> RB (4); A2 (5, an edit of A) -> RA2 (6); active leaf RA2. `extra`
 * parts are added to the first message.
 */
export function treeChat(n: number, extra: HarnessUIMessage['parts'] = []): ChatCreate {
  const base = n * 100
  return {
    id: chatId(n),
    title: `Chat ${n}`,
    modelRef: 'mock:echo',
    messages: [user(base + 1, 'A', extra), assistant(base + 2, 'RA'), user(base + 3, 'B'), assistant(base + 4, 'RB'), user(base + 5, 'A2'), assistant(base + 6, 'RA2')],
    parentIds: [null, mid(base + 1), mid(base + 2), mid(base + 3), null, mid(base + 5)],
    activeLeafId: mid(base + 6),
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function exportBytes(deps: AppDeps, query: { files?: boolean, settings?: boolean } = {}): Promise<Uint8Array> {
  return readAllBytes((await deps.data.exportBackup(query)).stream)
}

/** Every entry of a zip, inflated (fflate). */
export function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes)
}

export function entryJson<T = unknown>(entries: Record<string, Uint8Array>, name: string): T {
  const bytes = entries[name]
  if (bytes === undefined)
    throw new Error(`no entry ${name}`)
  return JSON.parse(strFromU8(bytes)) as T
}

/** A central directory record of a zip (no zip64, no archive comment). */
export interface CentralRecord {
  name: string
  versionMadeBy: number
  flags: number
  method: number
  dosTime: number
  dosDate: number
  externalAttributes: number
}

/** The central directory records of a zip, in order. */
export function centralDirectory(zip: Uint8Array): CentralRecord[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const eocd = zip.byteLength - 22
  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const records: CentralRecord[] = []
  for (let index = 0; index < count; index++) {
    const nameLength = view.getUint16(offset + 28, true)
    records.push({
      name: Buffer.from(zip.subarray(offset + 46, offset + 46 + nameLength)).toString('utf8'),
      versionMadeBy: view.getUint16(offset + 4, true),
      flags: view.getUint16(offset + 8, true),
      method: view.getUint16(offset + 10, true),
      dosTime: view.getUint16(offset + 12, true),
      dosDate: view.getUint16(offset + 14, true),
      externalAttributes: view.getUint32(offset + 38, true),
    })
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
  }
  return records
}

/** The DOS date and time fflate writes for `at` (local time, 2-second resolution). */
export function dosDateTime(at: number): { dosDate: number, dosTime: number } {
  const date = new Date(at)
  return {
    dosDate: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
  }
}

/** A multipart body with the upload in the part `file` and the given fields. */
export function importForm(upload: Uint8Array | string, name: string, fields: Record<string, string> = {}): FormData {
  const form = new FormData()
  form.append('file', new Blob([typeof upload === 'string' ? upload : new Uint8Array(upload)]), name)
  for (const [key, value] of Object.entries(fields))
    form.append(key, value)
  return form
}
