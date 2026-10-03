import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { compactionData } from '~/utils/testing/fixtures'
import CompactionDivider from './CompactionDivider.vue'

describe('compactionDivider (P9-0b stub)', () => {
  it('renders its root with the kind, the variant, the count and the label', () => {
    const wrapper = mount(CompactionDivider, { props: { data: compactionData({ trigger: 'auto', messagesCompacted: 42 }), variant: 'run' } })
    const root = wrapper.get(`[data-testid="${testIds.compactionDivider}"]`)
    expect(root.attributes()).toMatchObject({
      'data-kind': 'auto',
      'data-variant': 'run',
      'data-count': '42',
      'role': 'group',
      'aria-label': 'Context compacted during this response',
    })
    expect(root.attributes('data-state')).toBeUndefined()
  })
})
