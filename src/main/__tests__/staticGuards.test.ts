// 정적 가드: 개발용 진단 코드가 배포판에 섞이지 않는지, preload 로 여는 API 범위가 그대로인지 확인한다. 제품 코드는 읽기만 한다.
// package.json 의 test glob(src/main/__tests__/*.test.ts)이 잡는 위치에 둔다.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', '..', '..')
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8')

test('diag 채널 문자열은 diag.ts 와 preload 의 DEV 가드 안에만 있다', () => {
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const f = path.join(d, e.name)
      if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(f)
      return /\.(ts|tsx)$/.test(e.name) ? [f] : []
    })
  const hits = walk(path.join(root, 'src'))
    .filter((f) => /['"]diag:(snapshot|gc)['"]/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(root, f).replaceAll('\\', '/'))
    .sort()
  assert.deepEqual(hits, ['src/main/diag.ts', 'src/preload/index.ts'])
})

test('preload 의 diag 는 import.meta.env.DEV 삼항 안에서만 api 에 들어간다', () => {
  const s = read('src/preload/index.ts')
  const i = s.indexOf('...(import.meta.env.DEV')
  assert.ok(i > 0, 'DEV 조건부 spread 가 있어야 한다')
  assert.ok(s.indexOf("'diag:snapshot'") > i && s.indexOf("'diag:gc'") > i)
})

test('index.ts 의 expose-gc 와 registerDiag 는 DEV 가드 안에서만 쓴다', () => {
  const lines = read('src/main/index.ts').split('\n')
  for (const key of ["'--expose-gc'", 'registerDiag']) {
    const l = lines.filter((x) => x.includes(key) && !x.trim().startsWith('//'))
    assert.ok(l.length >= 1, `${key} 사용처가 있어야 한다`)
    for (const x of l) assert.match(x, /import\.meta\.env\.DEV/, `${key} 는 DEV 가드 필요: ${x}`)
  }
})

test('preload api 최상위 키는 term/sessions/app(언어)/getPathForFile (+DEV diag) 뿐이고 contextIsolation 을 유지한다', () => {
  const s = read('src/preload/index.ts')
  const body = s.slice(s.indexOf('const api = {'), s.indexOf('export type Api'))
  const top = [...body.matchAll(/^ {2}(?:\.\.\.\(|(\w+):)/gm)].map((m) => m[1] ?? '...spread')
  assert.deepEqual(top, ['term', 'sessions', 'app', 'getPathForFile', '...spread'])
  assert.match(s, /contextBridge\.exposeInMainWorld\('api'/)
  assert.match(read('src/main/index.ts'), /contextIsolation: true/)
  assert.match(read('src/main/index.ts'), /nodeIntegration: false/)
})

test('xterm scrollback 은 명시적 상수이고 term.dispose 와 구독 해제가 cleanup 에 있다', () => {
  const s = read('src/renderer/src/components/TerminalView.tsx')
  assert.match(s, /const SCROLLBACK = \d+/)
  assert.match(s, /scrollback: SCROLLBACK/)
  for (const k of ['ro.disconnect()', 'slot.dispose()', 'term.dispose()', 'selSub.dispose()'])
    assert.ok(s.includes(k), `${k} 누락`)
})
