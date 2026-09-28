<script setup lang="ts">
// Login (docs/UI.md 9.7), `auth` layout: the password form; success goes to `?redirect=` (in-app paths only) or /.
// Never renders its own <main> (the auth layout does).
import LoginForm from '~/components/settings/LoginForm.vue'
import { useHead, useRoute } from '~/components/settings/nuxt-imports'

definePageMeta({ layout: 'auth' })

useHead({ title: 'Log in · harness-forge' })

const route = useRoute()
</script>

<template>
  <LoginForm :redirect="route.query.redirect" />
</template>
