// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
// main 프로세스 문구(오류 메시지, 터미널에 찍는 안내 등) 번역.
// electron 을 import 하지 않는다 (단위 테스트가 node 로 바로 불러 씀). 기본 언어는 ko.
// node 가 .ts 를 직접 불러올 수 있도록 import 경로에 확장자를 붙인다.
// 문구는 모듈 로드 때가 아니라 t() 를 부를 때 번역하므로, 실행 중 언어를 바꾸면 다음 문구부터 바로 반영된다.
import { makeT, type Lang } from '../shared/i18n.ts'
import { ko } from './locales/ko.ts'
import { en } from './locales/en.ts'

export type MainKey = keyof typeof ko

let lang: Lang = 'ko'
export const getLang = (): Lang => lang
export const setLang = (l: Lang): void => {
  lang = l
}
export const t = makeT({ ko, en }, getLang)
