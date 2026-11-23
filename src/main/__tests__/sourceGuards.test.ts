// 소스 문자열 가드. 실제 fs 로 src 를 읽는다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', '..')
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n)) out.push(p)
  }
  return out
}
const files = walk(SRC).filter((f) => !f.includes('__tests__'))
const rel = (f: string): string => f.slice(SRC.length + 1).replace(/\\/g, '/')

test('전역 파일 패널 열림 키가 src(테스트 제외)에 없다', () => {
  const key = ['tm', 'filePanel', 'open'].join('.')
  const hits = files.filter((f) => readFileSync(f, 'utf8').includes(key))
  assert.equal(hits.length, 0)
})

test('main/preload 의 setInterval 은 dev 전용 diag.ts 한 곳뿐이다 (SFTP 폴링 없음)', () => {
  const hits = files
    .filter((f) => /^(main|preload)\//.test(rel(f)))
    .filter((f) => /setInterval\s*\(/.test(readFileSync(f, 'utf8')))
    .map(rel)
  assert.deepEqual(hits, ['main/diag.ts'])
})

test('renderer 에 setInterval 이 없다', () => {
  const hits = files
    .filter((f) => rel(f).startsWith('renderer/'))
    .filter((f) => /setInterval\s*\(/.test(readFileSync(f, 'utf8')))
  assert.equal(hits.length, 0)
})

test('탭별 패널 상태는 TerminalView 가 아니라 props 로 받는다 (localStorage 저장 없음)', () => {
  const tv = readFileSync(join(SRC, 'renderer/src/components/TerminalView.tsx'), 'utf8')
  assert.match(tv, /panelOpen/)
  assert.doesNotMatch(tv, /useState\(\(\)\s*=>\s*lsGet\(/)
})
