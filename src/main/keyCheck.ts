// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
// 키 파일 존재 확인 (electron 비의존: access 를 주입 가능 → node:test 로 검증)
// - 저장을 막지 않는다. 경고 문자열 배열만 돌려주고, 확인이 불가능하거나 오래 걸리면 빈 배열.
// - 경고에는 파일 이름(basename)만 담는다. 전체 경로는 넣지 않는다.
import { promises as fsp } from 'fs'
import { basename } from 'path'
import { t } from './i18n.ts'

export const KEY_CHECK_TIMEOUT_MS = 1000

export interface KeyCheckOptions {
  access?: (p: string) => Promise<void>
  timeoutMs?: number
}

/** 네트워크(UNC) 경로는 응답이 오래 걸릴 수 있어 확인하지 않는다 */
const isNetworkPath = (p: string): boolean => p.startsWith('\\\\') || p.startsWith('//')

/** 파일 이름만 뽑는다 (Windows/POSIX 구분자 모두 처리) */
const fileName = (p: string): string => basename(p.replaceAll('\\', '/'))

export async function checkKeyFile(
  keyPath: string | undefined,
  opts: KeyCheckOptions = {}
): Promise<string[]> {
  const path = keyPath?.trim()
  if (!path || isNetworkPath(path)) return []
  const access = opts.access ?? ((p: string) => fsp.access(p))
  const timeoutMs = opts.timeoutMs ?? KEY_CHECK_TIMEOUT_MS

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([access(path), timeout]) // 시간 초과도 "문제 없음"과 같이 경고 없음
    return []
  } catch (e) {
    // 파일이 없을 때만 경고. 권한 등 그 밖의 오류는 접속 때 안내되므로 여기서는 조용히 넘어감
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return [t('keyCheck.notFound', { name: fileName(path) })]
    }
    return []
  } finally {
    clearTimeout(timer)
  }
}
