// Settings -> Data maintenance (docs/UI.md 9.8; docs/API.md 4.22, 5.19, 5.23; ADR-034, ADR-035) on a password-protected
// server of its own per test (`startPasswordServer({ dedicated: true })`): a rotation changes every session, share URL
// and pending approval for good, so never the shared e2e server.
// - Encryption key: "Rotate key…" needs exactly ROTATE and, 11 minutes after the login (the browser clock is moved
//   forward), the password; then the toast "Master key rotated" with the counts, version 2, the old share URL is
//   unavailable and the new one (from Shared links) opens the transcript, the pending approval shows as denied, this
//   browser stays signed in and another session is signed out.
// - Storage cleanup: a rowless blob older than the 24-hour grace period placed in the server's file store (the data
//   directory is known because this spec started the server) is a leftover file; "Check for unused files" counts it,
//   "Remove…" asks, removes it from disk and the next check reads "No unused files.".
import type { Locator, Page } from '@playwright/test'
import type { PasswordServer } from '../../helpers/index.ts'
import { createHash } from 'node:crypto'
import { access, mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  byTestId,
  expect,
  HarnessApi,
  startPasswordServer,
  test,
  testIds,
  uniqueId,
} from '../../helpers/index.ts'

const APPROVAL_TOOL = 'mock_approval_tool'

/** From anywhere in the app to Settings -> Data through the sidebar (no reload). */
async function openDataSettings(page: Page): Promise<void> {
  await page.getByTestId(testIds.settingsLink).click()
  await page.getByTestId(testIds.settingsNavData).click()
  await expect(page.getByTestId(testIds.settingsNavData)).toHaveAttribute('data-state', 'active')
  await expect(page.getByTestId(testIds.dataSettings)).toBeVisible()
}

/** The visible toast with this text (vue-sonner). */
function toastWith(page: Page, text: string): Locator {
  return page.locator('[data-sonner-toast]').filter({ hasText: text })
}

/** A key-status row of the Encryption key section (`data-slot` hooks, docs/UI.md 9.8). */
function keyRow(section: Locator, slot: string): Locator {
  return section.locator(`[data-slot="${slot}"]`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch {
    return false
  }
}

interface RotationSeed {
  /** A chat with a share link (two turns). */
  shared: { id: string, title: string, sharePath: string }
  /** A chat whose last reply waits for an approval of `mock_approval_tool`. */
  pendingId: string
}

/** The chats of the rotation test and one stored secret (so the rotation has something to encrypt again). */
async function seedRotation(server: PasswordServer): Promise<RotationSeed> {
  const owner = await HarnessApi.create(server.baseURL)
  try {
    await owner.client.auth.login({ body: { password: server.password } })
    const token = uniqueId('keys')
    const chat = await owner.createChat({ title: `Rotated share ${token}` })
    for (const text of [`Rotate first ${token}`, `Rotate second ${token}`])
      await owner.sendChat({ chatId: chat.id, text, modelRef: 'mock:echo' })
    const share = await owner.client.shares.create({ body: { chatId: chat.id } })
    const waiting = await owner.sendChat({ modelRef: 'mock:tool-approval', toolMode: 'ask', text: `Approve later ${token}` })
    await owner.setCredentials('openai', { apiKey: `sk-e2e-${token}` })
    return { shared: { id: chat.id, title: chat.title ?? '', sharePath: share.path }, pendingId: waiting.chatId }
  }
  finally {
    await owner.dispose()
  }
}

test.describe('data maintenance', () => {
  // A server of its own per test: a rotation changes the key version, every session and every share URL for good.
  let server: PasswordServer | undefined

  test.beforeEach(async () => {
    server = await startPasswordServer({ dedicated: true, label: 'hf-e2e-maintenance' })
  })

  test.afterEach(async () => {
    await server?.stop()
    server = undefined
  })

  test('rotating the key changes the share URL and expires the pending approval @smoke', async ({ page, browser }) => {
    const { baseURL, password } = server!
    const { shared, pendingId } = await seedRotation(server!)
    // Fake timers from the first document on, so the browser clock can be moved past the 10-minute fresh window.
    await page.clock.install()
    const session = new HarnessApi(page.request, baseURL)
    await session.client.auth.login({ body: { password } })
    // A second session (another browser), signed out by the rotation.
    const other = await HarnessApi.create(baseURL)
    try {
      await other.client.auth.login({ body: { password } })

      await page.goto(`${baseURL}/`)
      await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
      await openDataSettings(page)
      const section = page.getByTestId(testIds.dataKeySection)
      await expect(keyRow(section, 'key-status')).toHaveAttribute('data-source', 'file')
      await expect(keyRow(section, 'key-status')).toHaveAttribute('data-key-check', 'ok')
      await expect(keyRow(section, 'key-source')).toHaveText('Key file in the data directory')
      await expect(keyRow(section, 'key-version')).toHaveText('1')
      await expect(keyRow(section, 'key-rotated')).toHaveText('Never')
      await expect(keyRow(section, 'key-secrets')).toContainText('1 encrypted')

      // The dialog lists the effects with the counts and waits for exactly ROTATE.
      await section.getByTestId(testIds.dataKeyRotate).click()
      const dialog = page.getByTestId(testIds.keyRotateDialog)
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('Rotate the master key?')
      const effects = dialog.locator('[data-slot="key-rotate-effects"]')
      await expect(effects).toContainText('Every share link changes (1 link)')
      await expect(effects).toContainText('pending approvals expire (1 waiting)')
      const typed = dialog.getByTestId(testIds.keyRotateConfirm)
      const submit = dialog.getByTestId(testIds.keyRotateSubmit)
      await expect(typed).toBeFocused()
      await expect(submit).toBeDisabled()
      await typed.fill('rotate')
      await expect(submit).toBeDisabled()
      await typed.fill('ROTATE')
      await expect(submit).toBeEnabled()

      // A fresh-auth route: 11 minutes after the login the password comes first.
      await page.clock.fastForward('11:00')
      await submit.click()
      const prompt = page.getByTestId(testIds.confirmPasswordDialog)
      await expect(prompt).toBeVisible()
      await expect(prompt).toContainText('Rotating the master key needs your password.')
      await prompt.getByTestId(testIds.confirmPasswordInput).fill(password)
      await prompt.getByTestId(testIds.confirmPasswordSubmit).click()
      await expect(prompt).toBeHidden()
      await expect(dialog).toBeHidden()
      const rotated = toastWith(page, 'Master key rotated')
      await expect(rotated).toBeVisible()
      await expect(rotated).toContainText('1 secret encrypted again · 1 approval expired')
      await expect(keyRow(section, 'key-version')).toHaveText('2')
      await expect(keyRow(section, 'key-rotated')).not.toHaveText('Never')

      // This browser stays signed in (a new cookie); the other session is signed out.
      expect(await session.client.auth.status()).toMatchObject({ enabled: true, authenticated: true })
      expect(await other.client.auth.status()).toMatchObject({ enabled: true, authenticated: false })

      // The share link has a new URL: the old one is unavailable, the new one (from Shared links) opens the transcript.
      const shares = page.getByTestId(testIds.sharesSection)
      await expect(shares.getByTestId(testIds.sharesRow)).toHaveCount(1)
      const [link] = (await session.client.shares.list()).items
      expect(link?.path, 'the share URL changed').not.toBe(shared.sharePath)
      const visitor = await browser.newContext()
      try {
        const guest = await visitor.newPage()
        await guest.goto(`${baseURL}${shared.sharePath}`)
        await expect(guest.getByTestId(testIds.sharePage)).toHaveAttribute('data-state', 'unavailable')
        await guest.goto(`${baseURL}${link!.path}`)
        await expect(guest.getByTestId(testIds.sharePage)).toHaveAttribute('data-state', 'ready')
        await expect(guest.getByTestId(testIds.shareTitle)).toHaveText(shared.title)
        await expect(guest.getByTestId(testIds.shareTranscript).getByTestId(testIds.shareMessage)).toHaveCount(4)
      }
      finally {
        await visitor.close()
      }

      // The pending approval expired: the tool row shows Denied and no card is left.
      await page.goto(`${baseURL}/chat/${pendingId}`)
      const reply = page.getByTestId(testIds.messageAssistant).last()
      const row = byTestId(reply, testIds.toolRow, { 'data-tool-name': APPROVAL_TOOL })
      await expect(row).toHaveAttribute('data-state', 'output-denied')
      await expect(row).toHaveAttribute('data-status', 'denied')
      await expect(row).toContainText('Denied')
      await expect(reply.getByTestId(testIds.toolApproval)).toHaveCount(0)
      expect((await session.getChat(pendingId)).pendingApproval).toBe(false)
    }
    finally {
      await other.dispose()
    }
  })

  test('the storage cleanup finds a leftover file and removes it @smoke', async ({ page }) => {
    const { baseURL, password, dataDir } = server!
    expect(dataDir, 'the spec started the server').toBeDefined()
    // A rowless blob (`files/<aa>/<sha256>`) from two days ago: past the grace period, kept by no file row.
    const content = `leftover ${uniqueId('blob')}\n`
    const sha256 = createHash('sha256').update(content).digest('hex')
    const shard = join(dataDir!, 'files', sha256.slice(0, 2))
    const blob = join(shard, sha256)
    await mkdir(shard, { recursive: true })
    await writeFile(blob, content)
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    await utimes(blob, twoDaysAgo, twoDaysAgo)

    await new HarnessApi(page.request, baseURL).client.auth.login({ body: { password } })
    await page.goto(`${baseURL}/settings/data`)
    const section = page.getByTestId(testIds.dataCleanupSection)
    await expect(section).toBeVisible()
    const run = section.getByTestId(testIds.dataCleanupRun)
    await expect(run).toBeDisabled()

    await section.getByTestId(testIds.dataCleanupCheck).click()
    const summary = section.getByTestId(testIds.dataCleanupSummary)
    await expect(summary).toHaveAttribute('data-state', 'removable')
    await expect(summary).toContainText('1 leftover file on disk can be removed')
    await expect(run).toBeEnabled()

    await run.click()
    const confirm = page.getByTestId(testIds.dataCleanupConfirm)
    await expect(confirm).toBeVisible()
    const alert = page.getByRole('alertdialog')
    await expect(alert).toContainText('Remove unused files?')
    await expect(alert).toContainText('This deletes 1 leftover file on disk. It can\'t be undone.')
    await confirm.click()
    await expect(toastWith(page, 'Removed 1 leftover file from disk')).toBeVisible()
    await expect(confirm).toBeHidden()

    // The section checks again: nothing is left, and the last cleanup is shown.
    await expect(summary).toHaveAttribute('data-state', 'empty')
    await expect(summary).toContainText('No unused files.')
    await expect(summary).toContainText('Last cleanup')
    await expect(run).toBeDisabled()
    expect(await exists(blob), 'the blob is gone from disk').toBe(false)
  })
})
