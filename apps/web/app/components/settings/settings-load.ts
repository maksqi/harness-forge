// Loading the global settings for the General and Appearance pages: they show the defaults until the values arrive,
// and a failed load says so (with Retry) instead of letting the defaults pass for the saved values.
import { onMounted, ref } from 'vue'
import { useSettingsStore } from '~/stores/settings'

export function useSettingsLoad() {
  const settings = useSettingsStore()
  const loading = ref(false)
  const loadError = ref<unknown>(null)

  async function load(): Promise<void> {
    loading.value = true
    loadError.value = null
    try {
      await settings.fetch()
    }
    catch (error) {
      loadError.value = error
    }
    finally {
      loading.value = false
    }
  }

  onMounted(() => {
    if (!settings.loaded)
      void load()
  })

  return { loading, loadError, load }
}
