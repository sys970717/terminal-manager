// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import { ipcMain, type WebContents } from 'electron'
import * as pty from 'node-pty'
import { connectSsh } from './ssh'
import { createTermRegistry } from './termRegistry'
import { createGauge } from './gauge'
import { t, type MainKey } from './i18n.ts'
import type { RemoteListing, RemoveResult, UploadProgress } from '../shared/types'

/**
 * 터미널 레지스트리. 로컬 PTY 와 SSH 셸을 같은 인터페이스로 다룬다.
 * 렌더러는 termId 하나로 write / resize / kill / upload 를 호출한다.
 */

export interface TermEmitter {
  data: (data: string) => void
  exit: (code: number, reason?: string) => void
  progress: (p: Omit<UploadProgress, 'termId'>) => void
}

export interface TermBackend {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  /** SSH 터미널만: 로컬 파일/폴더를 원격 폴더(remoteDir, 없으면 home)로 업로드 */
  upload?(localPaths: string[], remoteDir?: string): Promise<void>
  /** SSH 터미널만: 원격 폴더 목록 (path 가 없으면 home) */
  listDir?(path?: string): Promise<RemoteListing>
  /** SSH 터미널만: 원격 파일/폴더를 로컬로 (저장할 폴더는 main 이 대화상자로 묻는다) */
  download?(remotePaths: string[]): Promise<void>
  /** SSH 터미널만: dir 안에 새 폴더. 만든 경로를 돌려준다 */
  mkdir?(dir: string, name: string): Promise<string>
  /** SSH 터미널만: dir 안의 이름 바꾸기 */
  rename?(dir: string, from: string, to: string): Promise<void>
  /** SSH 터미널만: 파일/폴더 삭제 (폴더는 안의 내용까지). 확인은 렌더러가 먼저 받는다 */
  remove?(remotePaths: string[]): Promise<RemoveResult>
  /** SSH 터미널만: 마지막으로 다운로드한 로컬 폴더를 탐색기로 연다 */
  openDownloads?(): Promise<void>
}

// terms/owners Map 은 termRegistry 가 관리한다 (kill/remove 멱등). 개수는 dev 진단(diag)에서 읽는다
const registry = createTermRegistry<TermBackend, WebContents>()
const ptyGauge = createGauge() // 살아 있는 로컬 pty 수. 프로세스가 실제로 종료될 때 내려간다
const watchedOwners = new WeakSet<WebContents>()
let nextId = 1
let registered = false

/** dev 진단용: 레지스트리와 pty 개수 */
export function getTermStats(): { terms: number; owners: number; ptys: number } {
  return { terms: registry.size, owners: registry.ownerSize, ptys: ptyGauge.value }
}

function emitterFor(id: number, owner: WebContents): TermEmitter {
  let exited = false
  const send = (ch: string, ...args: unknown[]): void => {
    if (!owner.isDestroyed()) owner.send(ch, id, ...args)
  }
  return {
    data: (d) => send('term:data', d),
    // 종료 알림은 한 번만 (kill 과 백엔드 자체 종료가 겹쳐도 term:exit 가 중복 전송되지 않는다)
    exit: (code, reason) => {
      if (exited) return
      exited = true
      registry.remove(id)
      send('term:exit', code, reason)
    },
    // 진행률은 termId 를 payload 안에 넣어서 보냄 (앞에 id 인자를 붙이지 않음)
    progress: (p) => {
      if (!owner.isDestroyed()) owner.send('term:upload-progress', { termId: id, ...p })
    }
  }
}

function track(owner: WebContents, id: number, backend: TermBackend): void {
  registry.add(id, owner, backend)
  // 창(렌더러)이 닫히거나, 렌더러가 리로드/비정상 종료되면 그 창이 연 터미널을 모두 정리.
  // 리스너는 창마다 한 번만 등록 (터미널마다 등록하면 탭을 열 때마다 리스너가 쌓인다)
  if (!watchedOwners.has(owner)) {
    watchedOwners.add(owner)
    const killOwned = (): void => registry.killOwner(owner)
    owner.once('destroyed', killOwned)
    owner.on('render-process-gone', killOwned)
    // 페이지가 새로 로드되면(리로드/HMR) 이전 페이지의 터미널은 주인이 사라진 것이므로 정리
    owner.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) killOwned()
    })
  }
}

/**
 * node-pty 1.1.0(Windows, conpty)는 pty 가 끝나도 입력 파이프(conin fd, _agent.inSocket)를 닫지 않아
 * pty 하나당 핸들이 1개씩 남는다 (windowsPtyAgent.js 의 kill/_cleanUpProcess 는 outSocket 만 destroy).
 * 프로세스가 끝난 뒤 그 소켓을 직접 닫는다. 비공개 필드라 없으면 아무것도 하지 않는다 (node-pty 가 고쳐지면 불필요).
 */
function closePtyInput(proc: pty.IPty): void {
  try {
    const agent = (proc as unknown as { _agent?: { inSocket?: { destroy(): void } } })._agent
    agent?.inSocket?.destroy()
  } catch {
    // 이미 닫힘
  }
}

function spawnLocal(
  emit: TermEmitter,
  opts: { shell?: string; cols: number; rows: number; cwd?: string }
): TermBackend {
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  const shell =
    opts.shell ||
    (isWin ? 'powershell.exe' : process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash'))
  const env = { ...process.env } as Record<string, string>
  // Finder/Dock 에서 띄운 macOS 앱은 LANG 이 없어 한글이 깨지므로 UTF-8 로케일을 채운다
  if (isMac && !env.LANG) env.LANG = 'en_US.UTF-8'
  // macOS 터미널 앱들처럼 로그인 셸로 띄워 ~/.zprofile 의 PATH(Homebrew 등)를 읽게 한다
  const proc = pty.spawn(shell, isMac ? ['-l'] : [], {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd || process.env.USERPROFILE || process.env.HOME || process.cwd(),
    env
  })
  const releasePty = ptyGauge.acquire()
  const dataSub = proc.onData(emit.data)
  const exitSub = proc.onExit(({ exitCode }) => {
    // 프로세스가 끝났으니 이벤트 구독을 풀고 개수를 내린다 (kill 로 끝났든 스스로 끝났든 동일)
    dataSub.dispose()
    exitSub.dispose()
    closePtyInput(proc)
    releasePty()
    emit.exit(exitCode)
  })
  return {
    write: (d) => proc.write(d),
    resize: (c, r) => proc.resize(c, r),
    kill: () => proc.kill()
  }
}

export function registerTermHandlers(): void {
  // ipcMain.handle 은 같은 채널을 두 번 등록하면 던진다. 호출이 겹쳐도 한 번만 등록한다
  if (registered) return
  registered = true

  ipcMain.handle('term:spawnLocal', (e, opts) => {
    const id = nextId++
    track(e.sender, id, spawnLocal(emitterFor(id, e.sender), opts))
    return id
  })

  // SSH 는 접속 과정(키 확인, 인증)을 터미널에 바로 보여주기 위해 id 를 먼저 돌려주고 비동기로 연결
  ipcMain.handle('term:connectSsh', (e, sessionId: string, cols: number, rows: number) => {
    const id = nextId++
    const owner = e.sender
    track(owner, id, connectSsh(owner, emitterFor(id, owner), sessionId, cols, rows))
    return id
  })

  ipcMain.on('term:write', (_e, id: number, data: string) => registry.get(id)?.write(data))
  ipcMain.on('term:resize', (_e, id: number, cols: number, rows: number) => {
    if (cols > 0 && rows > 0) registry.get(id)?.resize(cols, rows)
  })
  ipcMain.on('term:kill', (_e, id: number) => registry.kill(id))

  ipcMain.handle('term:upload', async (_e, id: number, paths: string[], remoteDir?: string) => {
    const term = registry.get(id)
    if (!term?.upload) throw new Error(t('term.uploadSshOnly'))
    await term.upload(paths, typeof remoteDir === 'string' && remoteDir ? remoteDir : undefined)
  })

  ipcMain.handle('term:listDir', async (_e, id: number, path?: string) => {
    const term = registry.get(id)
    if (!term?.listDir) throw new Error(t('term.listSshOnly'))
    return term.listDir(typeof path === 'string' && path ? path : undefined)
  })

  // 파일 패널 동작. 렌더러가 보낸 값은 문자열인지 여기서 한 번 거른다 (경로 검사는 ssh.ts)
  const sshOnly = (id: number): TermBackend => {
    const term = registry.get(id)
    if (!term?.listDir) throw new Error(t('term.sshOnly'))
    return term
  }
  /** 문자열이 아니면 badKey 문구로 거부 */
  const str = (v: unknown, badKey: MainKey): string => {
    if (typeof v !== 'string') throw new Error(t(badKey))
    return v
  }
  const strs = (v: unknown): string[] => {
    if (!Array.isArray(v) || v.length === 0) throw new Error(t('term.noSelection'))
    return v.map((x) => str(x, 'term.badPath'))
  }
  ipcMain.handle('term:download', (_e, id: number, paths: unknown) =>
    sshOnly(id).download!(strs(paths))
  )
  ipcMain.handle('term:mkdir', (_e, id: number, dir: unknown, name: unknown) =>
    sshOnly(id).mkdir!(str(dir, 'term.badFolder'), str(name, 'term.badName'))
  )
  ipcMain.handle('term:rename', (_e, id: number, dir: unknown, from: unknown, to: unknown) =>
    sshOnly(id).rename!(
      str(dir, 'term.badFolder'),
      str(from, 'term.badName'),
      str(to, 'term.badNewName')
    )
  )
  ipcMain.handle('term:remove', (_e, id: number, paths: unknown) =>
    sshOnly(id).remove!(strs(paths))
  )
  ipcMain.handle('term:openDownloads', (_e, id: number) => sshOnly(id).openDownloads!())
}

/** 앱 종료/모든 창 닫힘 시 호출. 몇 번 불러도 안전하다 */
export function killAllTerms(): void {
  registry.killAll()
}
