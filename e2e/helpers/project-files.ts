// The project file editor of Settings -> Customize for the Phase 12 specs (docs/UI.md 2.19, 9.14; ADR-056): a right
// sheet (`project-file-editor`, `data-kind`, `data-path`, `data-mode` edit | new) that edits a project definition file
// as raw text (`project-file-content`, a MarkdownEditor; a textarea for `.mcp.json`), opened by Edit… of a project row
// (`customization-edit`, `data-source="project"`). Save (`project-file-save`) never approves; a file changed on disk after
// the editor read it shows `project-file-conflict` with Load from disk (`project-file-reload`) and Overwrite
// (`project-file-overwrite`).
import type { Locator, Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { chooseRowAction, customizationRow, fillMarkdownEditor, markdownEditorInput } from './customize.ts'
import { testIds } from './testids.ts'

/** The project file editor sheet. */
export function projectFileEditor(page: Page): Locator {
  return page.getByTestId(testIds.projectFileEditor)
}

/** The raw text editor of the sheet (the MarkdownEditor root; `.mcp.json`: the textarea). */
export function projectFileContent(editor: Locator): Locator {
  return editor.getByTestId(testIds.projectFileContent)
}

/** The project row of a definition (`customization-row`, `data-source="project"`). */
export function projectRow(page: Page | Locator, kind: string, name: string): Locator {
  return customizationRow(page, { 'data-source': 'project', 'data-kind': kind, 'data-name': name })
}

/**
 * Opens the editor of a project row (its `⋯` menu, Edit…) and waits until the file is loaded into the editor (the text
 * holds `contains` when given). Returns the sheet.
 */
export async function openProjectFileEditor(page: Page, row: Locator, path: string, contains?: string): Promise<Locator> {
  await chooseRowAction(page, row, testIds.customizationEdit)
  const editor = projectFileEditor(page)
  await expect(editor).toHaveAttribute('data-mode', 'edit')
  await expect(editor).toHaveAttribute('data-path', path)
  const content = projectFileContent(editor)
  await expect(content).toHaveAttribute('data-ready', 'true')
  if (contains !== undefined)
    await expect(markdownEditorInput(content)).toContainText(contains)
  return editor
}

/** Replaces the whole text of the open file. */
export async function replaceProjectFileText(page: Page, editor: Locator, text: string): Promise<void> {
  await fillMarkdownEditor(page, projectFileContent(editor), text)
}

/** The text of a project file on disk. */
export function readProjectFile(folder: string, relative: string): Promise<string> {
  return readFile(join(folder, ...relative.split('/')), 'utf8')
}
