// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
// 세션/폴더 저장소 코어 (electron 비의존: 파일 입출력, 암호화, 알림, 대기 함수를 모두 주입 가능 → node:test 로 검증)
// - 저장은 임시 파일에 쓴 뒤 rename 으로 교체. rename 이 EPERM 이면 async 대기로 100ms 간격 3회 재시도.
// - 끝내 실패하면 메모리 목록을 저장 전 상태로 되돌리고 현재 언어의 오류로 reject.
// - 로드 시 JSON 이 깨졌거나 sessions 필드가 없으면 원본을 백업하고 빈 목록으로 시작(앱이 죽지 않음).
import * as nodeFs from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import type { Folder, SessionInfo, SessionInput, SessionTree } from '../shared/types'
import { DecryptError } from './sshAuth.ts'
import { validateSessionInput } from './validate.ts'
import { t } from './i18n.ts'

export interface StoredSession extends Omit<SessionInfo, 'hasPassword' | 'hasPassphrase'> {
  encPassword?: string
  encPassphrase?: string
}

export interface StoreFile {
  version: 1
  folders: Folder[]
  sessions: StoredSession[]
}

/** safeStorage 와 같은 모양 (테스트에서는 가짜로 교체) */
export interface CryptoLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(enc: Buffer): string
}

export interface FsLike {
  existsSync(p: string): boolean
  readFileSync(p: string, enc: 'utf8'): string
  writeFileSync(p: string, data: string, enc: 'utf8'): void
  renameSync(from: string, to: string): void
  copyFileSync(from: string, to: string): void
  mkdirSync(p: string, opts: { recursive: true }): void
  unlinkSync(p: string): void
}

export interface StoreOptions {
  filePath: string
  crypto: CryptoLike
  fs?: Partial<FsLike>
  /** 저장용 rename (async). EPERM 재시도 시험을 위해 주입 가능 */
  rename?: (from: string, to: string) => Promise<void>
  /** 재시도 대기 (async). 기본 setTimeout */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** 손상 파일을 처리했을 때 한 번만 호출 (알림 대화상자용). backupPath 가 없으면 백업 실패 */
  onCorrupt?: (info: { filePath: string; backupPath?: string; reason: string }) => void
  log?: (msg: string, err?: unknown) => void
}

export const RENAME_RETRY_COUNT = 3
export const RENAME_RETRY_DELAY_MS = 100
/** Windows 에서 백신/인덱서가 파일을 잡고 있을 때 나오는 일시적 오류 */
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function createStore(opts: StoreOptions): Store {
  const fs: FsLike = { ...(nodeFs as unknown as FsLike), ...opts.fs }
  const rename = opts.rename ?? ((a, b) => nodeFs.promises.rename(a, b))
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((m, e) => console.error(m, e))
  const { filePath, crypto } = opts

  let data: StoreFile | null = null
  let corruptNotified = false
  let queue: Promise<unknown> = Promise.resolve()

  // ───── 로드 (동기) ─────
  function backupCorrupt(reason: string): void {
    const backupPath = `${filePath}.broken-${now()}`
    let done: string | undefined
    try {
      fs.renameSync(filePath, backupPath)
      done = backupPath
    } catch (e1) {
      try {
        fs.copyFileSync(filePath, backupPath) // 이름 변경이 막혀도 복사는 될 수 있음
        done = backupPath
      } catch (e2) {
        log('sessions.json 백업 실패 (앱은 계속 실행)', e2 ?? e1)
      }
    }
    log(`sessions.json 을 읽을 수 없어 빈 목록으로 시작합니다: ${reason}`)
    if (!corruptNotified) {
      corruptNotified = true // 알림은 1회만
      try {
        opts.onCorrupt?.({ filePath, backupPath: done, reason })
      } catch (e) {
        log('손상 알림 표시 실패', e)
      }
    }
  }

  function load(): StoreFile {
    if (data) return data
    let loaded: StoreFile | undefined
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<StoreFile> | null
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
          backupCorrupt(t('store.corrupt.noSessions'))
        } else {
          loaded = {
            version: 1,
            folders: Array.isArray(parsed.folders) ? parsed.folders : [],
            sessions: parsed.sessions
          }
        }
      } catch (e) {
        backupCorrupt(t('store.corrupt.parseFailed', { message: (e as Error).message }))
      }
    }
    data = loaded ?? { version: 1, folders: [], sessions: [] }
    return data
  }

  // ───── 저장 (async, 재시도 + 롤백) ─────
  async function persist(): Promise<void> {
    const tmp = `${filePath}.tmp`
    try {
      fs.mkdirSync(dirname(filePath), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(tmp, filePath)
          return
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code
          if (!code || !RETRYABLE.has(code) || attempt >= RENAME_RETRY_COUNT) throw e
          await sleep(RENAME_RETRY_DELAY_MS) // 이벤트 루프를 막지 않는 대기
        }
      }
    } catch (e) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // 임시 파일이 없으면 무시
      }
      const code = (e as NodeJS.ErrnoException).code
      throw new Error(code ? t('store.saveFailedCode', { code }) : t('store.saveFailed'), {
        cause: e
      })
    }
  }

  /** 변경 작업을 한 줄로 직렬화. 실패(검증/암호화/저장)하면 메모리 목록을 작업 전 상태로 되돌린다. */
  function mutate<T>(fn: (st: StoreFile) => T): Promise<T> {
    const run = queue.then(async () => {
      const before = structuredClone(load())
      try {
        const result = fn(load())
        await persist()
        return result
      } catch (e) {
        data = before
        throw e
      }
    })
    queue = run.catch(() => undefined)
    return run
  }

  // ───── 암호화 ─────
  function encrypt(plain: string): string {
    if (!crypto.isEncryptionAvailable()) {
      throw new Error(t('store.encryptionUnavailable'))
    }
    return crypto.encryptString(plain).toString('base64')
  }

  function decrypt(enc?: string): string | undefined {
    if (!enc) return undefined
    try {
      return crypto.decryptString(Buffer.from(enc, 'base64'))
    } catch (e) {
      throw new DecryptError(e)
    }
  }

  function toInfo(s: StoredSession): SessionInfo {
    const { encPassword, encPassphrase, ...rest } = s
    return { ...rest, hasPassword: !!encPassword, hasPassphrase: !!encPassphrase }
  }

  function isDescendant(candidate: string | null, ancestor: string): boolean {
    const folders = load().folders
    let cur = candidate
    while (cur) {
      if (cur === ancestor) return true
      cur = folders.find((x) => x.id === cur)?.parentId ?? null
    }
    return false
  }

  // ───── 공개 API ─────
  return {
    /** 렌더러용 목록. password/passphrase(및 암호문)는 포함하지 않는다. */
    getTree() {
      const st = load()
      return {
        folders: st.folders,
        sessions: st.sessions.map(toInfo),
        encryptionAvailable: crypto.isEncryptionAvailable()
      }
    },

    /** main 프로세스 안에서만 쓰는 복호화된 접속 정보. 복호화 실패 시 DecryptError */
    getConnectInfo(id: string) {
      const s = load().sessions.find((x) => x.id === id)
      if (!s) throw new Error(t('store.sessionNotFound'))
      return {
        name: s.name,
        host: s.host,
        port: s.port,
        username: s.username,
        authType: s.authType,
        keyPath: s.keyPath,
        password: decrypt(s.encPassword),
        passphrase: decrypt(s.encPassphrase)
      }
    },

    saveSession(input: SessionInput): Promise<SessionInfo> {
      return mutate((st) => {
        const invalid = validateSessionInput(input)
        if (invalid) throw new Error(invalid)
        if (input.folderId && !st.folders.some((f) => f.id === input.folderId))
          throw new Error(t('store.folderNotFound'))
        let s = input.id ? st.sessions.find((x) => x.id === input.id) : undefined
        if (!s) {
          s = { id: randomUUID() } as StoredSession
          st.sessions.push(s)
        }
        s.name = input.name.trim()
        s.folderId = input.folderId
        s.host = input.host.trim()
        s.port = Number(input.port)
        s.username = input.username.trim()
        s.authType = input.authType
        s.keyPath = input.authType === 'key' ? input.keyPath?.trim() || undefined : undefined
        // undefined = 유지, '' = 삭제, 값 = 암호화해서 교체
        if (input.password !== undefined)
          s.encPassword = input.password ? encrypt(input.password) : undefined
        if (input.passphrase !== undefined)
          s.encPassphrase = input.passphrase ? encrypt(input.passphrase) : undefined
        return toInfo(s)
      })
    },

    saveFolder(f: { id?: string; name: string; parentId: string | null }): Promise<Folder> {
      return mutate((st) => {
        if (!f.name?.trim()) throw new Error(t('store.folderNameRequired'))
        let folder = f.id ? st.folders.find((x) => x.id === f.id) : undefined
        if (!folder) {
          folder = { id: randomUUID(), name: '', parentId: null }
          st.folders.push(folder)
        }
        folder.name = f.name.trim()
        if (f.parentId !== folder.id && !isDescendant(f.parentId, folder.id))
          folder.parentId = f.parentId
        return folder
      })
    },

    /** 폴더 삭제: 안의 세션/하위 폴더는 상위 폴더로 올림 (세션이 사라지지 않게) */
    deleteFolder(id: string): Promise<void> {
      return mutate((st) => {
        const folder = st.folders.find((x) => x.id === id)
        if (!folder) return
        for (const f of st.folders) if (f.parentId === id) f.parentId = folder.parentId
        for (const s of st.sessions) if (s.folderId === id) s.folderId = folder.parentId
        st.folders = st.folders.filter((x) => x.id !== id)
      })
    },

    deleteSession(id: string): Promise<void> {
      return mutate((st) => {
        st.sessions = st.sessions.filter((x) => x.id !== id)
      })
    },

    move(kind: 'session' | 'folder', id: string, targetFolderId: string | null): Promise<void> {
      return mutate((st) => {
        if (kind === 'session') {
          const s = st.sessions.find((x) => x.id === id)
          if (s) s.folderId = targetFolderId
        } else {
          const f = st.folders.find((x) => x.id === id)
          if (f && f.id !== targetFolderId && !isDescendant(targetFolderId, f.id))
            f.parentId = targetFolderId
        }
      })
    },

    duplicateSession(id: string): Promise<SessionInfo | undefined> {
      return mutate((st) => {
        const s = st.sessions.find((x) => x.id === id)
        if (!s) return undefined
        const copy: StoredSession = {
          ...s,
          id: randomUUID(),
          name: t('store.copyName', { name: s.name })
        }
        st.sessions.push(copy)
        return toInfo(copy)
      })
    },

    /** 테스트/디버그용: 메모리 상태 */
    _peek: () => load()
  }
}

export interface Store {
  getTree(): SessionTree
  getConnectInfo(id: string): ConnectInfoData
  saveSession(input: SessionInput): Promise<SessionInfo>
  saveFolder(f: { id?: string; name: string; parentId: string | null }): Promise<Folder>
  deleteFolder(id: string): Promise<void>
  deleteSession(id: string): Promise<void>
  move(kind: 'session' | 'folder', id: string, targetFolderId: string | null): Promise<void>
  duplicateSession(id: string): Promise<SessionInfo | undefined>
  /** 테스트/디버그용: 메모리 상태 */
  _peek(): StoreFile
}

export interface ConnectInfoData {
  name: string
  host: string
  port: number
  username: string
  authType: 'key' | 'password'
  keyPath?: string
  password?: string
  passphrase?: string
}

/** SSH 접속 시 main 프로세스 안에서만 쓰는 복호화된 접속 정보 */
export type ConnectInfo = ConnectInfoData
