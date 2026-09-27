import process from 'node:process'
import tailwindcss from '@tailwindcss/vite'

const apiTarget = (process.env.HF_API_TARGET ?? 'http://localhost:8787').replace(/\/+$/, '')

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  ssr: false,
  devtools: { enabled: false },
  telemetry: false,

  modules: ['shadcn-nuxt', '@nuxtjs/color-mode', '@pinia/nuxt', '@vueuse/nuxt'],

  css: ['~/assets/css/main.css'],

  app: {
    head: {
      title: 'harness-forge',
      htmlAttrs: { lang: 'en' },
      meta: [
        { name: 'color-scheme', content: 'dark light' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },

  vite: {
    plugins: [tailwindcss()],
  },

  // App components: registered by file name (no path prefix), .vue files only, so helper .ts files next to
  // components are never registered. ui/ and ai-elements/ are registered once, by shadcn-nuxt below.
  components: [
    { path: '~/components', pathPrefix: false, extensions: ['.vue'], ignore: ['ui/**', 'ai-elements/**'] },
  ],

  // shadcn-vue components without prefix (<Button>); AI Elements Vue with the Ai prefix (<AiConversation>).
  shadcn: {
    prefix: '',
    componentDir: ['@/components/ui', { path: '@/components/ai-elements', prefix: 'Ai' }],
  },

  colorMode: {
    preference: 'dark',
    fallback: 'dark',
    classSuffix: '',
    storageKey: 'hf-color-mode',
  },

  nitro: {
    devProxy: {
      '/api': { target: `${apiTarget}/api`, changeOrigin: true },
    },
  },

  typescript: {
    typeCheck: false,
  },

  hooks: {
    // SPA only: emit index.html, 200.html and 404.html, never prerender app routes.
    'prerender:routes': (ctx) => {
      ctx.routes.clear()
    },
  },
})
