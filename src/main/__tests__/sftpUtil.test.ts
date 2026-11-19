import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  modeKind,
  normalizeRemotePath,
  permString,
  safeLocalName,
  sftpError,
  sortEntries,
  toEntry,
  validName
} from '../sftpUtil.ts'

test('permString: 종류와 rwx, 특수 비트', () => {
  assert.equal(permString(0o40755), 'drwxr-xr-x')
  assert.equal(permString(0o100644), '-rw-r--r--')
  assert.equal(permString(0o120777), 'lrwxrwxrwx')
  assert.equal(permString(0o41777), 'drwxrwxrwt') // /tmp
  assert.equal(permString(0o104755), '-rwsr-xr-x') // setuid
  assert.equal(permString(0o100600 | 0o2000), '-rw---S---')
})

test('toEntry: 폴더를 가리키는 링크는 폴더로, 깨진 링크는 other', () => {
  const a = { size: 7, mtime: 1700000000 }
  assert.equal(modeKind(0o120777), 'link')
  const dirLink = toEntry('www', { mode: 0o120777, ...a }, 0o40755)
  assert.equal(dirLink.type, 'dir')
  assert.equal(dirLink.isLink, true)
  assert.equal(dirLink.mtime, 1700000000 * 1000)
  assert.equal(toEntry('broken', { mode: 0o120777, ...a }).type, 'other')
  assert.equal(toEntry('f.txt', { mode: 0o100644, ...a }).type, 'file')
})

test('sortEntries: 폴더 먼저, 이름은 자연 정렬', () => {
  const e = (name: string, type: 'dir' | 'file') =>
    ({ name, type, isLink: false, size: 0, mtime: 0, perm: '' }) as const
  const out = sortEntries([e('b10', 'file'), e('Zdir', 'dir'), e('b2', 'file'), e('adir', 'dir')])
  assert.deepEqual(
    out.map((x) => x.name),
    ['adir', 'Zdir', 'b2', 'b10']
  )
})

test('normalizeRemotePath: ~, 상대 경로, 빈 값, NUL', () => {
  const home = '/home/me'
  assert.equal(normalizeRemotePath('', home), home)
  assert.equal(normalizeRemotePath('~', home), home)
  assert.equal(normalizeRemotePath('~/www/', home), '/home/me/www/')
  assert.equal(normalizeRemotePath('logs', home), '/home/me/logs')
  assert.equal(normalizeRemotePath('/var/www/../log', home), '/var/log')
  assert.throws(() => normalizeRemotePath('/tmp/\0x', home))
})

test('sftpError: 권한 없음/없는 경로는 한국어로', () => {
  assert.equal(
    sftpError({ code: 3, message: 'Permission denied' }, '/root').message,
    '권한 없음: /root'
  )
  assert.equal(sftpError({ code: 2, message: 'No such file' }, '/nope').message, '없는 경로: /nope')
  assert.match(sftpError(new Error('boom'), '/x').message, /^\/x: boom$/)
})

test('validName: 정상 이름은 앞뒤 공백만 정리, 위험한 이름은 거부', () => {
  assert.equal(validName('  새 폴더 '), '새 폴더')
  for (const bad of ['', '   ', '.', '..', 'a/b', 'x\0y', 'a'.repeat(256), undefined])
    assert.throws(() => validName(bad), String(bad))
})

test('safeLocalName: 윈도우에서 못 쓰는 문자/예약어/끝 점', () => {
  assert.equal(safeLocalName('a:b*c?.log'), 'a_b_c_.log')
  assert.equal(safeLocalName('a\\b'), 'a_b') // 리눅스에선 파일 이름에 \ 를 쓸 수 있다
  assert.equal(safeLocalName('tab\there'), 'tab_here')
  assert.equal(safeLocalName('report.'), 'report')
  assert.equal(safeLocalName('con.txt'), '_con.txt')
  assert.equal(safeLocalName('..'), '_')
  assert.equal(safeLocalName('정상 파일.txt'), '정상 파일.txt')
})
