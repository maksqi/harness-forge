// The single server event stream (docs/API.md 7, docs/UI.md 11): `EventSource('/api/events')` while the user has
// access (auth known and no login required), exponential backoff on errors (quiet while the endpoint is missing or
// answers 501 in Phase 0), typed dispatch into the stores, and a refetch of every loaded store after a reconnect.
import { apiUrl, SERVER_EVENT_TYPES } from '@harness-forge/shared'
import { watch } from 'vue'
import { defineNuxtPlugin, useRouter } from '#imports'
import { dispatchServerEvent, parseServerEvent, refetchLoadedStores, setServerEventsStatus } from '~/composables/useServerEvents'
import { useAuthStore } from '~/stores/auth'
import { createEventStream } from '~/utils/event-stream'

export default defineNuxtPlugin(() => {
  const router = useRouter()
  const auth = useAuthStore()

  const stream = createEventStream({
    url: apiUrl('events.stream'),
    eventTypes: SERVER_EVENT_TYPES,
    onMessage: (data) => {
      const event = parseServerEvent(data)
      if (event)
        dispatchServerEvent(event, { navigate: path => router.replace(path) })
    },
    onOpen: ({ reconnected }) => {
      if (reconnected)
        void refetchLoadedStores()
    },
    onStatus: setServerEventsStatus,
  })

  watch(() => auth.loaded && !auth.requiresLogin, (ready) => {
    if (ready)
      stream.start()
    else
      stream.stop()
  }, { immediate: true })
})
