// The composer toolbar's narrow-screen rule (docs/UI.md 2.20, 7.35, 14.5; Phase 14, W14.8). The left tools (+, model
// picker, effort, output style, web search, image options) share one line with the right tools (permission, context
// ring, mic, send). When the line gets short (390 px phones, a model with tools, a reply's context ring), the model name
// truncates first, but only down to a 40 px touch target; after that the left tools wrap onto a second line instead of
// squeezing anything, and the right tools stay on the bottom line (Send keeps its place). No control of the toolbar is
// ever narrower than 40 px on a coarse pointer, so the web search toggle can show in every state (its unavailable state
// included) without pushing the model picker below its touch target.
// Pure constants (classes), so the rule is unit-tested (`toolbar-layout.test.ts`) and the component stays declarative.

/** The touch target of every toolbar control on coarse pointers (docs/UI.md 14.5). */
export const TOOLBAR_TOUCH_TARGET_PX = 40

/**
 * The left tools: they take the free width (`flex-1`, `min-w-0`) and wrap onto a second line once the model picker is
 * at its minimum (`flex-wrap`); the 2px gap applies between the lines too.
 */
export const TOOLBAR_START_CLASS = 'min-w-0 flex-1 flex-wrap gap-0.5'

/** The right tools: never shrink, and sit on the bottom line when the left tools wrap (`self-end`). */
export const TOOLBAR_END_CLASS = 'shrink-0 gap-1 self-end'

/**
 * The model picker's trigger in the toolbar (merged over its own `min-w-0 max-w-full` by the button's class merge): a
 * 40 px flex basis that grows up to its content (`grow`, `max-w-max`), so the line breaks only when the picker is already
 * at 40 px, and it never truncates below that (`min-w-10`).
 */
export const TOOLBAR_PICKER_CLASS = 'min-w-10 grow basis-10 max-w-max'
