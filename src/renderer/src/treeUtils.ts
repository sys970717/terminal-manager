// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import type { Folder, SessionInfo } from '../../shared/types'

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' })
export const byName = <T extends { name: string }>(a: T, b: T): number =>
  collator.compare(a.name, b.name)

/** "상위폴더 / 하위폴더" 형태의 경로 */
export function folderPath(folders: Folder[], id: string | null): string {
  const parts: string[] = []
  let cur = id
  let guard = 0
  while (cur && guard++ < 100) {
    const f = folders.find((x) => x.id === cur)
    if (!f) break
    parts.unshift(f.name)
    cur = f.parentId
  }
  return parts.join(' / ')
}

/** 셀렉트 박스용: 트리 순서대로 (id, 들여쓴 이름) */
export function folderOptions(folders: Folder[]): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = []
  const visit = (parent: string | null, depth: number): void => {
    for (const f of folders.filter((x) => x.parentId === parent).sort(byName)) {
      out.push({ id: f.id, label: `${'　'.repeat(depth)}${f.name}` })
      visit(f.id, depth + 1)
    }
  }
  visit(null, 0)
  return out
}

/** 검색어 매칭: 공백으로 나눈 단어가 모두 (폴더 경로 + 이름 + 계정@호스트) 에 포함되면 일치 */
export function matchSession(s: SessionInfo, folders: Folder[], query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = `${folderPath(folders, s.folderId)} ${s.name} ${s.username}@${s.host}`.toLowerCase()
  return q.split(/\s+/).every((w) => hay.includes(w))
}
