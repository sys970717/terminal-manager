// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  DiagGcResult,
  DiagRendererInfo,
  DiagSnapshot,
  Folder,
  RemoteListing,
  RemoveResult,
  SaveSessionResult,
  SessionInfo,
  SessionInput,
  SessionTree,
  UploadProgress
} from '../shared/types'
import type { Lang } from '../shared/i18n'

type Unsubscribe = () => void

// ───── dev 전용 진단 (import.meta.env.DEV 가드 안에서만 쓰이므로 prod 번들에서는 제거됨) ─────
const subCounts: Record<string, number> = {}
function bumpSub(channel: string, delta: 1 | -1): void {
  subCounts[channel] = (subCounts[channel] ?? 0) + delta
}

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  if (import.meta.env.DEV) bumpSub(channel, 1)
  let done = false
  return () => {
    // 이중 해제를 막아 카운터가 어긋나지 않게 한다 (removeListener 자체는 멱등)
    if (done) return
    done = true
    ipcRenderer.removeListener(channel, listener)
    if (import.meta.env.DEV) bumpSub(channel, -1)
  }
}

// 렌더러에 노출할 API (Node/IPC 를 직접 노출하지 않고 필요한 기능만 좁게 연다)
const api = {
  term: {
    spawnLocal: (opts: { shell?: string; cols: number; rows: number }): Promise<number> =>
      ipcRenderer.invoke('term:spawnLocal', opts),
    connectSsh: (sessionId: string, cols: number, rows: number): Promise<number> =>
      ipcRenderer.invoke('term:connectSsh', sessionId, cols, rows),
    write: (id: number, data: string): void => ipcRenderer.send('term:write', id, data),
    resize: (id: number, cols: number, rows: number): void =>
      ipcRenderer.send('term:resize', id, cols, rows),
    kill: (id: number): void => ipcRenderer.send('term:kill', id),
    /** remoteDir 를 주면 그 원격 폴더로, 없으면 home 으로 업로드 */
    upload: (id: number, localPaths: string[], remoteDir?: string): Promise<void> =>
      ipcRenderer.invoke('term:upload', id, localPaths, remoteDir),
    /** 원격 폴더 목록 (path 가 없으면 home) */
    listDir: (id: number, path?: string): Promise<RemoteListing> =>
      ipcRenderer.invoke('term:listDir', id, path),
    /** 원격 파일/폴더 다운로드 (저장 폴더는 main 이 묻는다). 진행률은 onUploadProgress(kind: 'download') */
    download: (id: number, remotePaths: string[]): Promise<void> =>
      ipcRenderer.invoke('term:download', id, remotePaths),
    mkdir: (id: number, dir: string, name: string): Promise<string> =>
      ipcRenderer.invoke('term:mkdir', id, dir, name),
    rename: (id: number, dir: string, from: string, to: string): Promise<void> =>
      ipcRenderer.invoke('term:rename', id, dir, from, to),
    /** 삭제 (폴더는 안의 내용까지). 확인은 부르는 쪽에서 먼저 받는다 */
    remove: (id: number, remotePaths: string[]): Promise<RemoveResult> =>
      ipcRenderer.invoke('term:remove', id, remotePaths),
    openDownloads: (id: number): Promise<void> => ipcRenderer.invoke('term:openDownloads', id),
    onData: (cb: (id: number, data: string) => void): Unsubscribe => subscribe('term:data', cb),
    onExit: (cb: (id: number, code: number, reason?: string) => void): Unsubscribe =>
      subscribe('term:exit', cb),
    onUploadProgress: (cb: (p: UploadProgress) => void): Unsubscribe =>
      subscribe('term:upload-progress', cb)
  },
  sessions: {
    tree: (): Promise<SessionTree> => ipcRenderer.invoke('sessions:tree'),
    saveSession: (s: SessionInput): Promise<SaveSessionResult> =>
      ipcRenderer.invoke('sessions:saveSession', s),
    deleteSession: (id: string): Promise<void> => ipcRenderer.invoke('sessions:deleteSession', id),
    duplicateSession: (id: string): Promise<SessionInfo | undefined> =>
      ipcRenderer.invoke('sessions:duplicateSession', id),
    saveFolder: (f: { id?: string; name: string; parentId: string | null }): Promise<Folder> =>
      ipcRenderer.invoke('sessions:saveFolder', f),
    deleteFolder: (id: string): Promise<void> => ipcRenderer.invoke('sessions:deleteFolder', id),
    move: (kind: 'session' | 'folder', id: string, target: string | null): Promise<void> =>
      ipcRenderer.invoke('sessions:move', kind, id, target),
    pickKeyFile: (): Promise<string | undefined> => ipcRenderer.invoke('dialog:pickKeyFile')
  },
  app: {
    /** OS 언어로 정한 기본 언어 */
    getLang: (): Promise<Lang> => ipcRenderer.invoke('app:getLang'),
    /** main 쪽 메시지 언어도 맞춘다 */
    setLang: (lang: Lang): Promise<void> => ipcRenderer.invoke('app:setLang', lang)
  },
  /** 드래그앤드롭한 File 의 로컬 경로 (Electron 32+ 에서 File.path 대체) */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  // dev 전용: prod 빌드에서는 키 자체가 없다 (조건부 spread 는 상수 폴딩으로 제거됨)
  ...(import.meta.env.DEV
    ? {
        diag: {
          snapshot: (): Promise<DiagSnapshot> => ipcRenderer.invoke('diag:snapshot'),
          gc: (): Promise<DiagGcResult> => ipcRenderer.invoke('diag:gc'),
          renderer: (): DiagRendererInfo => ({
            subs: { ...subCounts },
            heapUsed: (performance as unknown as { memory: { usedJSHeapSize: number } }).memory
              .usedJSHeapSize
          })
        }
      }
    : {})
}

export type Api = typeof api

// contextIsolation 이 꺼져 있으면 노출하지 않고 오류로 막는다 (window.electron 같은 범용 IPC 는 노출하지 않음)
if (!process.contextIsolated) {
  throw new Error('contextIsolation 이 꺼져 있어 preload API 를 노출할 수 없습니다.')
}
contextBridge.exposeInMainWorld('api', api)
