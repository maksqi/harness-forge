<script setup lang="ts">
// Shown on the empty state while no provider can be used (docs/UI.md 7.13).
import { PlugZapIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { testIds } from '~/utils/testids'
</script>

<template>
  <Alert
    :data-testid="testIds.noProviderCallout"
    role="region"
    aria-label="Connect a provider to start"
    class="w-full border-border bg-card"
  >
    <PlugZapIcon class="text-primary" />
    <AlertTitle>Connect a provider to start</AlertTitle>
    <AlertDescription class="text-muted-foreground">
      Add an API key for Anthropic, OpenAI, DeepSeek and more, or run models locally with Ollama.
    </AlertDescription>
    <div class="col-start-2 mt-2 flex justify-end">
      <Button as-child size="sm" :data-testid="testIds.noProviderConnect">
        <NuxtLink to="/settings/providers">
          Connect a provider
        </NuxtLink>
      </Button>
    </div>
  </Alert>
</template>
