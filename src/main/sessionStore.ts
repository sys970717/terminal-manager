// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import { app, ipcMain, safeStorage, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import type { SaveSessionResult, SessionInput } from '../shared/types'
import { createStore, type Store } from './storeCore.ts'
import { checkKeyFile } from './keyCheck.ts'
import { t } from './i18n.ts'

/**
 * 세션/폴더 저장소 (Electron 연결부). 실제 로직은 storeCore.ts.
 * - 파일: %APPDATA%/terminal-manager/sessions.json  (git 저장소 밖)
 * - 비밀번호/passphrase 는 safeStorage(Windows DPAPI)로 암호화한 base64 만 저장. 평문 저장 안 함.
 * - PEM 키는 "경로"만 저장하고 키 내용은 저장하지 않음.
 */

export type { ConnectInfo } from './storeCore.ts'

let store: Store | null = null

function getStore(): Store {
  store ??= createStore({
    filePath: join(app.getPath('userData'), 'sessions.json'),
    crypto: safeStorage,
    onCorrupt: ({ filePath, backupPath, reason }) => {
      void dialog.showMessageBox({
        type: 'warning',
        title: t('store.corrupt.title'),
        message: t('store.corrupt.message'),
        detail: backupPath
          ? t('store.corrupt.detailBackedUp', { path: backupPath, reason })
          : t('store.corrupt.detailNoBackup', { path: filePath, reason })
      })
    }
  })
  return store
}

export const getTree = (): ReturnType<Store['getTree']> => getStore().getTree()
export const getConnectInfo = (id: string): ReturnType<Store['getConnectInfo']> =>
  getStore().getConnectInfo(id)

export function registerSessionHandlers(): void {
  ipcMain.handle('sessions:tree', () => getTree())
  ipcMain.handle(
    'sessions:saveSession',
    async (_e, input: SessionInput): Promise<SaveSessionResult> => {
      const info = await getStore().saveSession(input)
      // 저장이 끝난 뒤에 확인. 경고가 있어도 저장은 성공이며, 확인 실패/지연은 저장을 막지 않는다.
      if (info.authType !== 'key') return info
      const warnings = await checkKeyFile(info.keyPath).catch(() => [])
      return warnings.length > 0 ? { ...info, warnings } : info
    }
  )
  ipcMain.handle('sessions:deleteSession', (_e, id: string) => getStore().deleteSession(id))
  ipcMain.handle('sessions:duplicateSession', (_e, id: string) => getStore().duplicateSession(id))
  ipcMain.handle('sessions:saveFolder', (_e, f) => getStore().saveFolder(f))
  ipcMain.handle('sessions:deleteFolder', (_e, id: string) => getStore().deleteFolder(id))
  ipcMain.handle('sessions:move', (_e, kind, id, target) => getStore().move(kind, id, target))
  ipcMain.handle('dialog:pickKeyFile', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const r = await dialog.showOpenDialog(win, {
      title: t('dialog.keyFile.title'),
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: t('dialog.keyFile.filterKeys'), extensions: ['pem', 'key', 'ppk', ''] },
        { name: t('dialog.keyFile.filterAll'), extensions: ['*'] }
      ]
    })
    return r.canceled ? undefined : r.filePaths[0]
  })
}
