// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
// main / preload / renderer 가 함께 쓰는 타입

export interface Folder {
  id: string
  name: string
  parentId: string | null
}

export type AuthType = 'key' | 'password'

/** 렌더러로 보내는 세션 정보 (비밀값은 절대 포함하지 않음) */
export interface SessionInfo {
  id: string
  name: string
  folderId: string | null
  host: string
  port: number
  username: string
  authType: AuthType
  keyPath?: string
  hasPassword: boolean
  hasPassphrase: boolean
}

/** 세션 저장 응답: 세션 정보 + (선택) 경고. 비밀값은 포함하지 않는다. 경고가 있어도 저장은 성공한 것이다. */
export type SaveSessionResult = SessionInfo & { warnings?: string[] }

/** 세션 저장 요청. password/passphrase: undefined = 기존 값 유지, '' = 삭제 */
export interface SessionInput {
  id?: string
  name: string
  folderId: string | null
  host: string
  port: number
  username: string
  authType: AuthType
  keyPath?: string
  password?: string
  passphrase?: string
}

export interface SessionTree {
  folders: Folder[]
  sessions: SessionInfo[]
  encryptionAvailable: boolean
}

export interface UploadProgress {
  termId: number
  /** 현재 파일 이름 (원격 기준 상대 경로) */
  file: string
  fileIndex: number
  fileCount: number
  transferred: number
  total: number
  state: 'running' | 'done' | 'error' | 'cancelled'
  message?: string
  remoteDir?: string
  /** 없으면 업로드 (예전 이벤트와 호환) */
  kind?: 'upload' | 'download'
  /** 다운로드: 저장한 로컬 폴더 */
  localDir?: string
}

/** term:remove 응답 */
export interface RemoveResult {
  /** 지운 항목 수 (폴더 안의 파일 포함) */
  deleted: number
}

/**
 * 연결 상태. 'error' 는 종료 상태라서 이후 일반 종료('closed')가 덮어쓰지 않는다.
 * term:exit(id, code, reason?) 에서 reason 이 있으면 오류 종료(= 'error'), 없으면 정상 종료(= 'closed').
 */
export type ConnState = 'connecting' | 'connected' | 'error' | 'closed'

/** SSH 오류 분류 (classifySshError) */
export type SshErrorKind =
  | 'keyNotFound'
  | 'authFailed'
  | 'unreachable'
  | 'timeout'
  | 'passphraseWrong'
  | 'decryptFailed'
  | 'other'

// ───── dev 전용 진단 타입 (개발 계획 §3 계약. 타입만이라 prod 번들에 남지 않는다) ─────
/** preload 가 채널별 구독 수(subscribe 증감)와 renderer 힙을 알려주는 값 */
export interface DiagRendererInfo {
  subs: Record<string, number>
  heapUsed: number
}

// ───────────────────────── dev 전용 진단 (prod 빌드에는 사용되지 않는다) ─────────────────────────

/** diag:snapshot 응답. main 의 자원 개수와 프로세스별 메모리 */
export interface DiagSnapshot {
  ts: number
  main: {
    terms: number
    owners: number
    sshClients: number
    sshStreams: number
    sftp: number
    ptys: number
    /** ipcMain.on 으로 등록된 채널별 리스너 수 */
    ipcListeners: Record<string, number>
    heapUsed: number
  }
  procs: { type: string; pid: number; privateBytes: number; workingSet: number }[]
}

/** diag:gc 응답. 각 프로세스에서 gc 를 실제로 호출했는지 */
export interface DiagGcResult {
  main: boolean
  renderer: boolean
}

/** 원격 파일 브라우저: 폴더 안 항목 하나 */
export interface RemoteEntry {
  name: string
  /** link 는 대상이 폴더인지 확인한 뒤 dir/file 로 바뀌고 isLink 로 표시된다 */
  type: 'dir' | 'file' | 'other'
  isLink: boolean
  size: number
  /** 수정 시각 (ms) */
  mtime: number
  /** 'drwxr-xr-x' 형식 */
  perm: string
}

/** term:listDir 응답. path 는 서버가 풀어 준 절대 경로 (~ 나 .. 없음) */
export interface RemoteListing {
  path: string
  home: string
  entries: RemoteEntry[]
}
