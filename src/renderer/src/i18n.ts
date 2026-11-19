// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
// 화면 문구 번역. 언어는 (1) 사용자가 고른 값(localStorage) → (2) OS 언어(main 이 판단) 순으로 정한다.
// 컴포넌트는 useT() 로 t 를 받아 언어가 바뀌면 다시 그려진다. 컴포넌트 밖 함수는 t 를 바로 써도 된다.
import { useSyncExternalStore } from 'react'
import { isLang, makeT, type Lang } from '../../shared/i18n'
import { ko } from './locales/ko'
import { en } from './locales/en'

const LANG_KEY = 'tm.lang'
let lang: Lang = 'ko'
const subs = new Set<() => void>()

export const getLang = (): Lang => lang
export const t = makeT({ ko, en }, getLang)

function apply(l: Lang): void {
  lang = l
  document.documentElement.lang = l
  void window.api.app.setLang(l) // main 의 오류 메시지도 같은 언어로
  subs.forEach((f) => f())
}

/** 사용자가 언어를 고름 (다음 실행에도 유지) */
export function setLang(l: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, l)
  } catch {
    // 저장 못 해도 이번 실행에는 적용
  }
  apply(l)
}

/** 앱 시작 시 한 번: 저장된 선택이 없으면 OS 언어를 따른다 */
export async function initLang(): Promise<void> {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(LANG_KEY)
  } catch {
    // 무시
  }
  apply(isLang(saved) ? saved : await window.api.app.getLang())
}

const subscribe = (f: () => void): (() => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

/** 현재 언어 (바뀌면 컴포넌트가 다시 그려짐) */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang)
}

/** 컴포넌트용 번역 함수 */
export function useT(): typeof t {
  useLang()
  return t
}
