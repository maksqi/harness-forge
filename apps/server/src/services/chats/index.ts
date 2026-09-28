// Phase 0 stub. Owner: W1.5 (W1.5-T2, W1.5-T3). Implement `ChatsService` (./types.ts) and keep the export name and
// signature: `createChatsService(deps: AppDeps): ChatsService` (tables `chats`, `messages`, `usage`).
import type { AppDeps } from '../../types.ts'
import type { ChatsService } from './types.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'

export function createChatsService(_deps: AppDeps): ChatsService {
  return {
    listMessages: rejectsNotImplemented('chats.listMessages'),
    getMessage: rejectsNotImplemented('chats.getMessage'),
    upsertMessage: rejectsNotImplemented('chats.upsertMessage'),
    replaceFrom: rejectsNotImplemented('chats.replaceFrom'),
    list: rejectsNotImplemented('chats.list'),
    get: rejectsNotImplemented('chats.get'),
    create: rejectsNotImplemented('chats.create'),
    update: rejectsNotImplemented('chats.update'),
    remove: rejectsNotImplemented('chats.remove'),
    export: rejectsNotImplemented('chats.export'),
    find: rejectsNotImplemented('chats.find'),
    summary: rejectsNotImplemented('chats.summary'),
    ensure: rejectsNotImplemented('chats.ensure'),
    touch: rejectsNotImplemented('chats.touch'),
    setTitle: rejectsNotImplemented('chats.setTitle'),
    addUsage: rejectsNotImplemented('chats.addUsage'),
    transaction: rejectsNotImplemented('chats.transaction'),
  }
}
