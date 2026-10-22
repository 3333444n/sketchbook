// Tiny localStorage wrapper. Only used for UI preferences and the shape library,
// never for scene data. Every access is guarded: storage can be unavailable.

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Quota exceeded or storage disabled: preferences are best-effort.
  }
}
