// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
/** 지원 언어. 새 언어를 넣으려면 여기와 각 사전(ko/en 과 같은 키)을 추가한다 */
export type Lang = 'ko' | 'en'
export const LANGS: readonly Lang[] = ['ko', 'en']
export const LANG_LABEL: Record<Lang, string> = { ko: '한국어', en: 'English' }

/** OS 선호 언어 목록에서 고른다: 한국어면 ko, 그 밖에는 en */
export function pickLang(locales: readonly string[]): Lang {
  const first = (locales[0] ?? '').toLowerCase()
  return first.startsWith('ko') ? 'ko' : 'en'
}

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v)
}

export type Vars = Record<string, string | number>

/** "{name}" 자리에 값을 넣는다 */
export function fill(text: string, vars?: Vars): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

/**
 * 사전 두 벌(ko 가 기준, en 은 같은 키를 모두 가져야 함)로 번역 함수를 만든다.
 * getLang 은 부를 때마다 현재 언어를 읽는다.
 */
export function makeT<D extends Record<string, string>>(
  dicts: { ko: D; en: { [K in keyof D]: string } },
  getLang: () => Lang
): (key: keyof D, vars?: Vars) => string {
  return (key, vars) => fill((dicts[getLang()] as D)[key] ?? dicts.ko[key] ?? String(key), vars)
}
