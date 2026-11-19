// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
// SFTP 파일 브라우저용 순수 함수 (ssh2 객체 없이 테스트할 수 있게 분리)
import { posix } from 'path'
import type { RemoteEntry } from '../shared/types'
import { t } from './i18n.ts'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

export type ModeKind = 'dir' | 'file' | 'link' | 'other'

export function modeKind(mode: number): ModeKind {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'dir'
    case S_IFREG:
      return 'file'
    case S_IFLNK:
      return 'link'
    default:
      return 'other'
  }
}

/** 0o40755 → 'drwxr-xr-x' (setuid/setgid/sticky 포함) */
export function permString(mode: number): string {
  const k = modeKind(mode)
  const type = k === 'dir' ? 'd' : k === 'link' ? 'l' : k === 'file' ? '-' : '?'
  const bit = (m: number, c: string): string => (mode & m ? c : '-')
  const x = (m: number, special: number, on: string, off: string): string =>
    mode & special ? (mode & m ? on : off) : mode & m ? 'x' : '-'
  return (
    type +
    bit(0o400, 'r') +
    bit(0o200, 'w') +
    x(0o100, 0o4000, 's', 'S') +
    bit(0o040, 'r') +
    bit(0o020, 'w') +
    x(0o010, 0o2000, 's', 'S') +
    bit(0o004, 'r') +
    bit(0o002, 'w') +
    x(0o001, 0o1000, 't', 'T')
  )
}

/** ssh2 readdir 결과 한 줄 → RemoteEntry. 링크는 대상 종류(targetMode)를 알면 그걸로 dir/file 을 정한다 */
export function toEntry(
  name: string,
  attrs: { mode: number; size: number; mtime: number },
  targetMode?: number
): RemoteEntry {
  const k = modeKind(attrs.mode)
  const isLink = k === 'link'
  const eff = isLink && targetMode !== undefined ? modeKind(targetMode) : k
  return {
    name,
    type: eff === 'dir' ? 'dir' : eff === 'file' ? 'file' : 'other',
    isLink,
    size: attrs.size,
    mtime: attrs.mtime * 1000,
    perm: permString(attrs.mode)
  }
}

/** 이름 목록 정렬: 폴더 먼저, 그다음 이름(대소문자 무시, 숫자는 자연 정렬) */
export function sortEntries(list: RemoteEntry[]): RemoteEntry[] {
  return list.sort(
    (a, b) =>
      (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  )
}

/**
 * 렌더러가 보낸 원격 경로 검사. 절대 경로만 받는다 (상대 경로는 home 기준으로 붙인다).
 * '..' 정리는 서버 realpath 가 최종 판단하므로 여기서는 형식만 본다.
 */
export function normalizeRemotePath(p: string, home: string): string {
  if (typeof p !== 'string' || p.length === 0) return home
  if (p.includes('\0')) throw new Error(t('sftp.badPathChar'))
  if (p === '~') return home
  if (p.startsWith('~/')) return posix.join(home, p.slice(2))
  return posix.normalize(p.startsWith('/') ? p : posix.join(home, p))
}

// SFTP 상태 코드 (draft-ietf-secsh-filexfer-02)
const NO_SUCH_FILE = 2
const PERMISSION_DENIED = 3

/** SFTP 오류를 사람이 읽을 메시지(현재 언어)로 바꾼다 */
export function sftpError(err: unknown, what: string): Error {
  const e = err as { code?: unknown; message?: string }
  if (e?.code === PERMISSION_DENIED) return new Error(t('sftp.permissionDenied', { path: what }))
  if (e?.code === NO_SUCH_FILE) return new Error(t('sftp.noSuchFile', { path: what }))
  return new Error(`${what}: ${e?.message ?? String(err)}`)
}

/** 새 폴더/이름 변경에 쓸 이름 검사. 경로 구분자, '.', '..', NUL 은 거부 */
export function validName(name: unknown): string {
  if (typeof name !== 'string') throw new Error(t('sftp.nameEmpty'))
  const n = name.trim()
  if (!n) throw new Error(t('sftp.nameEmpty'))
  if (n === '.' || n === '..') throw new Error(t('sftp.nameInvalid', { name: n }))
  if (/[/\0]/.test(n)) throw new Error(t('sftp.nameSlash'))
  if (Buffer.byteLength(n) > 255) throw new Error(t('sftp.nameTooLong'))
  return n
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * 원격 이름 → 윈도우에서 쓸 수 있는 로컬 이름.
 * \ / : * ? " < > | 와 제어 문자는 _ 로, 끝의 점/공백은 지우고, 예약어(CON 등)는 앞에 _ 를 붙인다.
 */
export function safeLocalName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let n = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '')
  if (!n || n === '.' || n === '..') n = '_'
  if (WIN_RESERVED.test(n)) n = '_' + n
  return n
}
