import { DatabaseIcon, ImagePlayIcon } from '@lucide/vue'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { DEFAULT_LAST_ROUTES, isAppPath, modeOfPath, rememberRoute, sanitizeLastRoutes, SETTINGS_LINKS } from './navigation'

describe('modeOfPath', () => {
  it('maps route prefixes to sidebar modes', () => {
    expect(modeOfPath('/')).toBe('chat')
    expect(modeOfPath('/chat/0199a2b0')).toBe('chat')
    expect(modeOfPath('/plugins')).toBe('plugins')
    expect(modeOfPath('/plugins/dice-tool')).toBe('plugins')
    expect(modeOfPath('/settings/providers')).toBe('settings')
    expect(modeOfPath('/settings')).toBe('settings')
    expect(modeOfPath('/plugins?filter=tools')).toBe('plugins')
    expect(modeOfPath('/settings#about')).toBe('settings')
  })

  it('does not match look-alike prefixes', () => {
    expect(modeOfPath('/pluginsx')).toBe('chat')
    expect(modeOfPath('/settingsfoo')).toBe('chat')
  })
})

describe('rememberRoute', () => {
  it('records the route of its mode and as the last app route', () => {
    const next = rememberRoute({ ...DEFAULT_LAST_ROUTES }, '/plugins?filter=tools')
    expect(next).toEqual({ chat: '/', plugins: '/plugins?filter=tools', app: '/plugins?filter=tools' })
    expect(rememberRoute(next, '/chat/abc')).toEqual({ chat: '/chat/abc', plugins: '/plugins?filter=tools', app: '/chat/abc' })
  })

  it('never records settings routes', () => {
    const last = { chat: '/chat/abc', plugins: '/plugins', app: '/chat/abc' }
    expect(rememberRoute(last, '/settings/models')).toBe(last)
  })

  it('ignores paths that would leave the app', () => {
    const last = { ...DEFAULT_LAST_ROUTES }
    expect(rememberRoute(last, '//evil.example')).toBe(last)
  })
})

describe('sanitizeLastRoutes', () => {
  it('replaces tampered or mismatched values with defaults', () => {
    expect(sanitizeLastRoutes({ chat: 'https://evil.example', plugins: '/settings/about', app: '/\\evil' }))
      .toEqual(DEFAULT_LAST_ROUTES)
    expect(sanitizeLastRoutes(null)).toEqual(DEFAULT_LAST_ROUTES)
    expect(sanitizeLastRoutes({ chat: '/chat/x', plugins: '/plugins/y', app: '/plugins/y' }))
      .toEqual({ chat: '/chat/x', plugins: '/plugins/y', app: '/plugins/y' })
    expect(sanitizeLastRoutes({ chat: '/?q=a', plugins: '/plugins?filter=tools', app: '/plugins?filter=tools' }))
      .toEqual({ chat: '/?q=a', plugins: '/plugins?filter=tools', app: '/plugins?filter=tools' })
  })

  it('accepts only single-slash paths', () => {
    expect(isAppPath('/plugins')).toBe(true)
    expect(isAppPath('//host')).toBe(false)
    expect(isAppPath('plugins')).toBe(false)
    expect(isAppPath(42)).toBe(false)
  })
})

describe('settings links', () => {
  it('lists the settings pages in sidebar order, Media right after Models and Data between Appearance and About', () => {
    expect(SETTINGS_LINKS.map(link => [link.key, link.label, link.to])).toEqual([
      ['providers', 'Providers', '/settings/providers'],
      ['models', 'Models', '/settings/models'],
      ['media', 'Media', '/settings/media'],
      ['general', 'General', '/settings/general'],
      ['appearance', 'Appearance', '/settings/appearance'],
      ['data', 'Data', '/settings/data'],
      ['about', 'About', '/settings/about'],
    ])
  })

  it('gives every link its own nav test id, the Media link the image-play icon and the Data link the database icon', () => {
    expect(SETTINGS_LINKS.map(link => link.testId)).toEqual([
      testIds.settingsNavProviders,
      testIds.settingsNavModels,
      testIds.settingsNavMedia,
      testIds.settingsNavGeneral,
      testIds.settingsNavAppearance,
      testIds.settingsNavData,
      testIds.settingsNavAbout,
    ])
    expect(SETTINGS_LINKS.find(link => link.key === 'media')?.icon).toBe(ImagePlayIcon)
    expect(SETTINGS_LINKS.find(link => link.key === 'data')?.icon).toBe(DatabaseIcon)
    expect(SETTINGS_LINKS.every(link => modeOfPath(link.to) === 'settings')).toBe(true)
  })
})
