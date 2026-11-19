// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

const two = (n: number): string => String(n).padStart(2, '0')

/** 2026-11-18 15:07 */
export function formatTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** 원격(POSIX) 경로 이어 붙이기 */
export function joinRemote(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

/** 원격(POSIX) 상위 폴더. '/' 의 상위는 '/' */
export function parentRemote(dir: string): string {
  const t = dir.replace(/\/+$/, '')
  const i = t.lastIndexOf('/')
  return i <= 0 ? '/' : t.slice(0, i)
}

/** 셸에 넣을 작은따옴표 인용 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
