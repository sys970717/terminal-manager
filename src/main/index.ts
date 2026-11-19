// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerTermHandlers, killAllTerms } from './terms'
import { registerSessionHandlers } from './sessionStore'
import { getLang, setLang } from './i18n'
import { isLang, pickLang } from '../shared/i18n'

// 테스트용: TM_USER_DATA 를 지정하면 세션/known_hosts 를 그 폴더에 저장 (실제 데이터와 분리)
if (process.env['TM_USER_DATA']) app.setPath('userData', process.env['TM_USER_DATA'])

// dev 전용: 렌더러에서 gc() 를 부를 수 있게 한다 (메모리 누수 측정용). prod 에서는 켜지지 않는다.
// 반드시 app ready 이전에 추가해야 렌더러 프로세스에 전달된다.
if (import.meta.env.DEV) app.commandLine.appendSwitch('js-flags', '--expose-gc')

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
    // 창/작업 표시줄 아이콘 (macOS 는 창 아이콘이 없고 앱 번들의 icns 를 쓴다)
    ...(process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 보안: 렌더러는 Node 에 접근하지 못하고, preload 의 window.api 로만 main 과 통신한다
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 파일을 창에 떨어뜨렸을 때 앱 화면이 그 파일로 바뀌지 않게 (개발 서버 HMR 리로드는 허용)
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (!(is.dev && devUrl && url.startsWith(devUrl))) e.preventDefault()
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.terminalmanager.app')
  // 개발 모드(npm run dev)에서도 macOS Dock 에 앱 아이콘이 보이게 (배포판은 icns 가 대신함)
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(icon)

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 언어: OS 언어로 시작하고, 화면에서 고르면 바꾼다
  setLang(pickLang(app.getPreferredSystemLanguages()))
  ipcMain.handle('app:getLang', () => getLang())
  ipcMain.handle('app:setLang', (_e, l: unknown) => {
    if (isLang(l)) setLang(l)
  })
  registerSessionHandlers()
  registerTermHandlers()
  // dev 전용 진단 IPC. 가드 안에서 동적 import 하므로 prod 번들에는 포함되지 않는다
  if (import.meta.env.DEV) void import('./diag').then((m) => m.registerDiag())

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  killAllTerms()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 종료 직전에도 한 번 더 정리 (macOS Cmd+Q 처럼 window-all-closed 를 거치지 않는 경로 대비). 멱등이라 중복 호출돼도 안전
app.on('before-quit', () => killAllTerms())

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
