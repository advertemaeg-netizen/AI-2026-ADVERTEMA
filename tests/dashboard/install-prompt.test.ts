import { describe, expect, it } from 'vitest'
import {
  INSTALL_PROMPT_DISMISSED_KEY,
  installPromptMode,
  isIosPlatform,
  isStandalone,
  readDismissed,
  writeDismissed,
} from '@/lib/install-prompt'

/**
 * The install card's decisions: which platform's card, when none at all, and
 * a dismissal that survives a storage that throws.
 */

const base = { desktop: false, standalone: false, dismissed: false, ios: false, hasInstallEvent: false }

describe('which card', () => {
  it('iOS gets the instructions card, with or without an install event', () => {
    expect(installPromptMode({ ...base, ios: true })).toBe('ios')
    expect(installPromptMode({ ...base, ios: true, hasInstallEvent: true })).toBe('ios')
  })

  it('Android gets the button card only once beforeinstallprompt was captured', () => {
    expect(installPromptMode(base)).toBe('hidden')
    expect(installPromptMode({ ...base, hasInstallEvent: true })).toBe('android')
  })

  it('never on desktop widths, when installed, or after a dismissal', () => {
    for (const platform of [{ ios: true }, { hasInstallEvent: true }]) {
      expect(installPromptMode({ ...base, ...platform, desktop: true })).toBe('hidden')
      expect(installPromptMode({ ...base, ...platform, standalone: true })).toBe('hidden')
      expect(installPromptMode({ ...base, ...platform, dismissed: true })).toBe('hidden')
    }
  })
})

describe('iOS by platform', () => {
  it('iPhone, iPad and iPod report themselves', () => {
    expect(isIosPlatform({ platform: 'iPhone', maxTouchPoints: 5 })).toBe(true)
    expect(isIosPlatform({ platform: 'iPad', maxTouchPoints: 5 })).toBe(true)
    expect(isIosPlatform({ platform: 'iPod', maxTouchPoints: 5 })).toBe(true)
  })

  it('an iPad in desktop mode says MacIntel; its touch points tell it from a Mac', () => {
    expect(isIosPlatform({ platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true)
    expect(isIosPlatform({ platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false)
    expect(isIosPlatform({ platform: 'MacIntel' })).toBe(false)
  })

  it('Android and Windows are not iOS, whatever browser is in the user agent', () => {
    expect(isIosPlatform({ platform: 'Linux armv81', maxTouchPoints: 5 })).toBe(false)
    expect(isIosPlatform({ platform: 'Win32', maxTouchPoints: 10 })).toBe(false)
    expect(isIosPlatform({})).toBe(false)
  })
})

describe('already installed', () => {
  const matchMedia = (matches: boolean) => (query: string) => ({ matches: query === '(display-mode: standalone)' && matches })

  it('display-mode standalone (Android) or navigator.standalone (iOS)', () => {
    expect(isStandalone({ matchMedia: matchMedia(true), navigator: {} })).toBe(true)
    expect(isStandalone({ matchMedia: matchMedia(false), navigator: { standalone: true } })).toBe(true)
    expect(isStandalone({ matchMedia: matchMedia(false), navigator: { standalone: false } })).toBe(false)
    expect(isStandalone({ matchMedia: matchMedia(false), navigator: {} })).toBe(false)
  })

  it('a browser without matchMedia is a browser tab', () => {
    expect(isStandalone({ navigator: {} })).toBe(false)
  })
})

describe('the dismissal in storage', () => {
  const memory = () => {
    const map = new Map<string, string>()
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      map,
    }
  }
  const throwing = {
    getItem: () => {
      throw new DOMException('blocked', 'SecurityError')
    },
    setItem: () => {
      throw new DOMException('full', 'QuotaExceededError')
    },
  }

  it('is written under its key as the time of the dismissal, and read back', () => {
    const storage = memory()
    expect(readDismissed(storage)).toBe(false)
    writeDismissed(storage, new Date('2026-10-26T09:00:00Z'))
    expect(storage.map.get(INSTALL_PROMPT_DISMISSED_KEY)).toBe('2026-10-26T09:00:00.000Z')
    expect(readDismissed(storage)).toBe(true)
  })

  it('a storage that throws, or none at all, reads as not dismissed and swallows the write', () => {
    expect(readDismissed(throwing)).toBe(false)
    expect(() => writeDismissed(throwing)).not.toThrow()
    expect(readDismissed(undefined)).toBe(false)
    expect(() => writeDismissed(null)).not.toThrow()
  })
})
