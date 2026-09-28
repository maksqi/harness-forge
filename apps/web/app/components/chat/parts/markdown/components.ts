// Registers our markstream node components (fenced code, images) for every `Markdown` renderer, once.
import { setCustomComponents } from 'markstream-vue'
import { MARKDOWN_CUSTOM_ID } from './markdown-options'
import MarkdownCodeBlock from './MarkdownCodeBlock.vue'
import MarkdownImage from './MarkdownImage.vue'

let registered = false

export function registerMarkdownComponents(): void {
  if (registered)
    return
  registered = true
  setCustomComponents(MARKDOWN_CUSTOM_ID, { code_block: MarkdownCodeBlock, image: MarkdownImage })
}
