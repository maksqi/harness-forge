// The hook import of the Customize Hooks tab (docs/UI.md 2.18, 9.13; ADR-048): Import… on the Hooks tab opens "Import
// hooks"; text that is not JSON reads "This isn't valid JSON.", an object without hooks "No hooks found."; a pasted
// Claude Code settings file (with `permissions`, which is ignored) previews "Found 3 hooks": two ready items (checked;
// the timeout shown) and one with a regular-expression matcher (unchecked, disabled, "Use tool names, | and * only."),
// and the notes say a "prompt" hook was left out. "Add 2 hooks" creates them as personal hooks ("Added 2 hooks"), which
// show as rows. The imported hooks never run in another spec's chats: a PreToolUse matcher that names no tool and a
// Notification hook (never shown in a chat); both are removed through `cleanup` by a unique marker in their commands.
import {
  byTestId,
  expect,
  hookRow,
  listHooks,
  removePersonalHooksWith,
  test,
  testIds,
  toastWith,
  uniqueId,
} from '../../helpers/index.ts'

test.describe('hook import', () => {
  test('pasted settings JSON previews ready, invalid and ignored hooks; Add creates the ready ones @smoke', async ({ page, api, cleanup }) => {
    const marker = uniqueId('import')
    const tool = `e2e_none_${marker.replaceAll('-', '_')}`
    cleanup(api => removePersonalHooksWith(api, marker))
    const settings = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PreToolUse: [
          { matcher: tool, hooks: [{ type: 'command', command: `sh .harness/hooks/${marker}-guard.sh`, timeout: 30 }] },
          { matcher: '^Bash.*$', hooks: [{ type: 'command', command: `sh ${marker}-regex.sh` }] },
        ],
        Notification: [{ hooks: [{ type: 'command', command: `sh ${marker}-notify.sh` }] }],
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Check the work.' }] }],
      },
    }

    await page.goto('/settings/customize?tab=hooks')
    const panel = page.getByTestId(testIds.hooksPanel)
    await expect(panel).toBeVisible()
    await page.getByTestId(testIds.customizeImport).click()
    const dialog = page.getByTestId(testIds.hookImportDialog)
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Import hooks')
    await expect(dialog).toContainText('Paste Claude Code settings JSON (the whole file or its "hooks" object).')
    const input = dialog.getByTestId(testIds.hookImportInput)
    const submit = dialog.getByTestId(testIds.hookImportSubmit)
    const error = dialog.getByTestId(testIds.hookImportError)

    // Errors: not JSON, then JSON without hooks.
    await input.fill('{ "hooks": ')
    await expect(error).toHaveText('This isn\'t valid JSON.')
    await expect(submit).toBeDisabled()
    await input.fill('{ "permissions": {} }')
    await expect(error).toHaveText('No hooks found.')
    await expect(submit).toBeDisabled()

    // The preview: two ready items, one invalid matcher, a note for the prompt hook.
    await input.fill(JSON.stringify(settings, null, 2))
    await expect(error).toHaveCount(0)
    const preview = dialog.getByTestId(testIds.hookImportPreview)
    await expect(preview).toHaveAttribute('data-count', '3')
    await expect(preview).toContainText('Found 3 hooks')
    const items = preview.getByTestId(testIds.hookImportItem)
    await expect(items).toHaveCount(3)
    const ready = byTestId(preview, testIds.hookImportItem, { 'data-event': 'PreToolUse', 'data-state': 'ready' })
    await expect(ready).toContainText(`PreToolUse · ${tool}`)
    await expect(ready).toContainText('30s')
    await expect(ready.getByRole('checkbox')).toHaveAttribute('data-state', 'checked')
    const invalid = byTestId(preview, testIds.hookImportItem, { 'data-event': 'PreToolUse', 'data-state': 'invalid' })
    await expect(invalid).toContainText('^Bash.*$')
    await expect(invalid).toContainText('Use tool names, | and * only.')
    await expect(invalid.getByRole('checkbox')).toBeDisabled()
    await expect(invalid.getByRole('checkbox')).toHaveAttribute('data-state', 'unchecked')
    const notify = byTestId(preview, testIds.hookImportItem, { 'data-event': 'Notification', 'data-state': 'ready' })
    await expect(notify).toContainText(`${marker}-notify.sh`)
    await expect(notify).toContainText('60s')
    await expect(dialog.locator('[data-slot="hook-import-notes"]')).toContainText('Ignored: "prompt" hooks aren\'t supported.')

    // Unchecking a ready item counts down; checking it again counts up.
    await notify.getByRole('checkbox').click()
    await expect(submit).toHaveAttribute('data-count', '1')
    await expect(submit).toHaveText('Add 1 hook')
    await notify.getByRole('checkbox').click()
    await expect(submit).toHaveAttribute('data-count', '2')
    await expect(submit).toHaveText('Add 2 hooks')

    // Add creates the two ready hooks as personal hooks.
    await submit.click()
    await expect(toastWith(page, 'Added 2 hooks')).toBeVisible()
    await expect(dialog).toBeHidden()
    const personal = byTestId(panel, testIds.hooksSection, { 'data-source': 'personal' })
    const guard = hookRow(personal, { 'data-event': 'PreToolUse', 'data-state': 'active' }).filter({ hasText: `${marker}-guard.sh` })
    await expect(guard.locator('[data-slot="hook-row-matcher"]')).toHaveText(tool)
    await expect(guard).toContainText('timeout 30s')
    await expect(hookRow(personal, { 'data-event': 'Notification', 'data-state': 'active' }).filter({ hasText: `${marker}-notify.sh` })).toBeVisible()
    const stored = (await listHooks(api)).items.filter(item => item.source === 'personal' && item.kind === 'command' && item.command.includes(marker))
    expect(stored.map(item => item.event).sort()).toEqual(['Notification', 'PreToolUse'])
    expect(stored.some(item => item.kind === 'command' && item.command.includes('regex'))).toBe(false)
  })
})
