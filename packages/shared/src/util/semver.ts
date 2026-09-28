// Dependency-free semver syntax checks (validation only; the server compares versions with `semver`).

const NUMERIC = /^(?:0|[1-9]\d*)$/
const PRERELEASE_ID = /^(?:0|[1-9]\d*|\d*[a-z-][\da-z-]*)$/i
const BUILD_ID = /^[\da-z-]+$/i
const X_RANGE = /^(?:[*0x]|[1-9]\d*)$/i
const OPERATOR = /^(?:<=|>=|~>|[<=>^~])/

interface VersionParts {
  core: string[]
  prerelease?: string
  build?: string
}

function splitVersion(value: string): VersionParts {
  let rest = value
  let build: string | undefined
  let prerelease: string | undefined
  const plus = rest.indexOf('+')
  if (plus >= 0) {
    build = rest.slice(plus + 1)
    rest = rest.slice(0, plus)
  }
  const dash = rest.indexOf('-')
  if (dash >= 0) {
    prerelease = rest.slice(dash + 1)
    rest = rest.slice(0, dash)
  }
  return { core: rest.split('.'), prerelease, build }
}

function validQualifiers(parts: VersionParts): boolean {
  if (parts.prerelease !== undefined && (parts.prerelease === '' || !parts.prerelease.split('.').every(id => PRERELEASE_ID.test(id))))
    return false
  if (parts.build !== undefined && (parts.build === '' || !parts.build.split('.').every(id => BUILD_ID.test(id))))
    return false
  return true
}

/** Strict SemVer 2.0.0 version (`1.2.0`, `2.0.0-beta.1`, `1.0.0+build.5`); no `v` prefix. */
export function isSemver(value: string): boolean {
  if (value.length === 0 || value.length > 256)
    return false
  const parts = splitVersion(value)
  return parts.core.length === 3 && parts.core.every(part => NUMERIC.test(part)) && validQualifiers(parts)
}

/** A partial version of a range: `1`, `1.2`, `1.x`, `*`, `1.2.3-beta.1` (qualifiers need a full numeric version). */
function isPartialVersion(value: string): boolean {
  const version = value.startsWith('v') || value.startsWith('V') ? value.slice(1) : value
  if (version === '')
    return false
  const parts = splitVersion(version)
  if (parts.core.length > 3 || !parts.core.every(part => X_RANGE.test(part)))
    return false
  if (parts.prerelease !== undefined || parts.build !== undefined)
    return parts.core.length === 3 && parts.core.every(part => NUMERIC.test(part)) && validQualifiers(parts)
  return true
}

function isComparator(token: string): boolean {
  const operator = token.match(OPERATOR)?.[0] ?? ''
  return isPartialVersion(token.slice(operator.length))
}

function isRangeSet(set: string): boolean {
  const trimmed = set.trim()
  if (trimmed === '')
    return false
  const hyphen = trimmed.split(/\s+-\s+/)
  if (hyphen.length === 2)
    return hyphen.every(isPartialVersion)
  if (hyphen.length > 2)
    return false
  // Allow whitespace between an operator and its version (`>= 1.2.0`), as node-semver does.
  const tokens = trimmed.replace(/(<=|>=|~>|[<=>^~])\s+/g, '$1').split(/\s+/)
  return tokens.every(isComparator)
}

/**
 * node-semver range syntax: comparators (`>=1.2.0 <2`), caret / tilde / x-ranges (`^1.0.0`, `~1.2`, `1.x`, `*`),
 * hyphen ranges (`1.0.0 - 2.0.0`) and `||` unions. Empty ranges are rejected.
 */
export function isSemverRange(value: string): boolean {
  if (value.trim() === '' || value.length > 256)
    return false
  return value.split('||').every(isRangeSet)
}
