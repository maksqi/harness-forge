// @ts-check
/// <reference path="./harness-forge.d.ts" />

/** @type {import('@harness-forge/plugin-sdk').PluginModule} */
export default {
  setup(ctx) {
    ctx.agents.register({
      name: 'docs-writer',
      description: 'Writes or updates documentation for code that changed. Use it after a feature is done.',
      instructions: 'You write concise documentation.\n\nRead the changed code, then update the README or the docs folder. Keep the existing style.',
      tools: ['read_file', 'find_files', 'search_files', 'write_file', 'edit_file'],
      model: 'inherit',
    })
    ctx.skills.register({
      name: 'changelog-entry',
      description: 'How to add an entry to CHANGELOG.md. Load it before editing the changelog.',
      content: '# Changelog entries\n\nAdd the entry under "Unreleased", grouped as Added, Changed or Fixed, one line per change.',
    })
  },
}
