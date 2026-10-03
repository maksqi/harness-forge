// Folder path helpers of the Add project dialog (docs/UI.md 9.10): POSIX and Windows paths, breadcrumbs below the
// roots, and the folder-name rules of folderNameSchema with the dialog's messages.
import { describe, expect, it } from 'vitest'
import { baseName, folderCrumbs, folderNameError, isWithinRoot, joinPath, pathSeparator, rootOf, samePath } from './folder-path'

describe('folder paths', () => {
  it('takes the last segment of POSIX and Windows paths', () => {
    expect(baseName('/srv/workspaces/website')).toBe('website')
    expect(baseName('/srv/workspaces/website/')).toBe('website')
    expect(baseName('C:\\Users\\me\\code')).toBe('code')
    expect(baseName('/')).toBe('/')
    expect(baseName('plain')).toBe('plain')
  })

  it('joins a name with the separator of the parent', () => {
    expect(pathSeparator('/srv/a')).toBe('/')
    expect(pathSeparator('C:\\code')).toBe('\\')
    expect(joinPath('/srv/workspaces', 'demo')).toBe('/srv/workspaces/demo')
    expect(joinPath('/srv/workspaces/', 'demo')).toBe('/srv/workspaces/demo')
    expect(joinPath('C:\\code', 'demo')).toBe('C:\\code\\demo')
  })

  it('compares folders and finds the root that holds a path', () => {
    expect(samePath('/srv/workspaces/', '/srv/workspaces')).toBe(true)
    expect(isWithinRoot('/srv/workspaces', '/srv/workspaces')).toBe(true)
    expect(isWithinRoot('/srv/workspaces', '/srv/workspaces/a/b')).toBe(true)
    expect(isWithinRoot('/srv/workspaces', '/srv/workspaces-old/a')).toBe(false)
    expect(isWithinRoot('C:\\code', 'C:\\code\\a')).toBe(true)
    expect(rootOf('/srv/workspaces/team/a', ['/srv/workspaces', '/srv/workspaces/team'])).toBe('/srv/workspaces/team')
    expect(rootOf('/etc', ['/srv/workspaces'])).toBeNull()
  })

  it('builds the breadcrumb from the root down to the open folder', () => {
    expect(folderCrumbs('/srv/workspaces/website/packages', ['/home/me', '/srv/workspaces'])).toEqual([
      { label: 'workspaces', path: '/srv/workspaces' },
      { label: 'website', path: '/srv/workspaces/website' },
      { label: 'packages', path: '/srv/workspaces/website/packages' },
    ])
    expect(folderCrumbs('/srv/workspaces', ['/srv/workspaces'])).toEqual([{ label: 'workspaces', path: '/srv/workspaces' }])
    expect(folderCrumbs('C:\\code\\app', ['C:\\code'])).toEqual([
      { label: 'code', path: 'C:\\code' },
      { label: 'app', path: 'C:\\code\\app' },
    ])
    // Outside every root (or before the roots arrived): one crumb.
    expect(folderCrumbs('/srv/other/x', [])).toEqual([{ label: 'x', path: '/srv/other/x' }])
  })
})

describe('folderNameError', () => {
  it('accepts ordinary names', () => {
    for (const name of ['demo', 'my project', 'v1.2', 'a'.repeat(255), 'café'])
      expect(folderNameError(name)).toBeNull()
  })

  it('refuses slashes, a leading dot (also . and ..) and names over 255 characters with the dialog texts', () => {
    expect(folderNameError('a/b')).toBe('Use a name without slashes.')
    expect(folderNameError('a\\b')).toBe('Use a name without slashes.')
    expect(folderNameError('.')).toBe('Folder names can\'t start with a dot.')
    expect(folderNameError('..')).toBe('Folder names can\'t start with a dot.')
    expect(folderNameError('.hidden')).toBe('Folder names can\'t start with a dot.')
    expect(folderNameError('a'.repeat(256))).toBe('Use at most 255 characters.')
  })

  it('falls back to the schema for the rest (control characters)', () => {
    expect(folderNameError('a\u0001b')).toBe('Folder names cannot contain control characters.')
  })
})
