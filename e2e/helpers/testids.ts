// The `data-testid` contract (docs/UI.md 13): the constants of the web app, imported by path so specs and the app
// never drift apart. Use with `page.getByTestId(testIds.newChat)`; repeated elements carry their identity in data
// attributes (`data-chat-id`, `data-model-ref`, `data-provider-id`, ...), see `byTestId()` in `./locators.ts`.
export { testIds } from '../../apps/web/app/utils/testids.ts'
export type { TestId, TestIdKey } from '../../apps/web/app/utils/testids.ts'
