// The one move action behind every "Move to project" menu (docs/UI.md 7.20, 11.4; ADR-031; W7.9): the header `⋯`
// menu, the sidebar row menu, the header chip and the command palette. `chats.update(chatId, { projectId })`
// (optimistic: the row leaves a list it no longer matches), then the toast "Moved to {name}" / "Moved out of {name}"
// with Undo (moves back); 409 run-active -> rolled back + "Wait for the response to finish before moving this chat.";
// 404 -> rolled back + "This project no longer exists."; never rejects.
// Signature frozen from Gate P7-0b (C15). Skeleton: the returned action does nothing until W7.9 implements it.

/** Moves a chat into a project (null = out of its project). Never rejects. */
export type MoveChat = (chatId: string, projectId: string | null) => Promise<void>

export function useMoveChat(): MoveChat {
  return () => Promise.resolve()
}
