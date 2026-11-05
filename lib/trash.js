/**
 * 产物管理 · 回收站（设计文档 §9.1 / §13.2）。
 *
 * 全部操作都是「同一块磁盘内的 rename」：进回收站、还原、彻底删除都不复制文件，
 * 所以 2 GB 的文件也是一瞬间的事。只有跨卷（EXDEV）才退化成 copy+unlink。
 *
 * 磁盘结构：
 *   .trash/.manifest.json
 *   .trash/<stamp>/<session>/<relativePath>          ← 会话产物
 *   .trash/<stamp>/artifacts/<name>/<relativePath>   ← 共享产物
 */

import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { normalizeRel, resolveInside } from './util.js'

const MANIFEST_VERSION = 1
const DAY_MS = 86_400_000

/** `2026-11-04T00:12:33.123Z` → `2026-11-04T00-12-33-123Z`（作为目录名要合法）。 */
function stampOf(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** 尽量往上删空目录，删不动就停（不碰非空目录）。 */
function pruneEmptyDirs(startDir, stopDir) {
  let current = startDir
  while (current.length > stopDir.length && current.startsWith(stopDir)) {
    try {
      if (readdirSync(current).length > 0) return
      rmdirSync(current)
    } catch {
      return
    }
    current = dirname(current)
  }
}

/** rename，跨卷时退化为复制 + 删除。 */
function moveFile(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

export function createTrash({ root, settings, onAfterRestore }) {
  const trashRoot = join(root, '.trash')
  const manifestPath = join(trashRoot, '.manifest.json')

  /** @type {Record<string, {origin:{scope:string,session:string,path:string}, name:string, size:number, deletedAt:number}>} */
  let manifest = {}

  function load() {
    if (!existsSync(manifestPath)) {
      manifest = {}
      return
    }
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest = raw?.version === MANIFEST_VERSION && raw.items !== null && typeof raw.items === 'object'
        ? raw.items
        : {}
    } catch (error) {
      console.error('[dsh-plugin-artifacts] 回收站清单读取失败：', error?.message || String(error))
      manifest = {}
    }
  }

  function save() {
    try {
      mkdirSync(trashRoot, { recursive: true })
      const payload = JSON.stringify({ version: MANIFEST_VERSION, items: manifest }, null, 2)
      const tmp = `${manifestPath}.${process.pid}.tmp`
      writeFileSync(tmp, payload, 'utf8')
      renameSync(tmp, manifestPath)
    } catch (error) {
      console.error('[dsh-plugin-artifacts] 回收站清单写入失败：', error?.message || String(error))
    }
  }

  /** 一次删除批次共用一个 stamp 目录；撞名就加序号。 */
  function batchDir() {
    const base = stampOf()
    let candidate = join(trashRoot, base)
    let attempt = 2
    while (existsSync(candidate)) {
      candidate = join(trashRoot, `${base}-${attempt}`)
      attempt += 1
    }
    return candidate
  }

  /**
   * 把文件移进回收站。
   * @param {Array<{ id:string, scope:string, session:string, path:string, abs:string, name:string, size:number }>} entries
   */
  function move(entries) {
    const moved = []
    const failed = []
    if (entries.length === 0) return { moved, failed }

    const batch = batchDir()
    mkdirSync(batch, { recursive: true })

    for (const entry of entries) {
      const safePath = normalizeRel(entry.path)
      if (safePath === null) {
        failed.push({ id: entry.id, code: 'E_FORBIDDEN', message: '路径非法' })
        continue
      }
      // origin 里带上绝对路径：多工作区/散文件（scope=root）还原时要靠它定位
      const origin = entry.scope === 'shared'
        ? `artifacts${entry.session === '' ? '' : '/' + entry.session}/${safePath}`
        : entry.scope === 'root'
          ? `root/${safePath}`
          : `${entry.session}/${safePath}`
      const trashId = `${batch.slice(trashRoot.length + 1).replace(/\\/g, '/')}/${origin}`
      const target = join(batch, origin)
      try {
        moveFile(entry.abs, target)
        manifest[trashId] = {
          origin: { scope: entry.scope, session: entry.session, path: safePath, abs: entry.abs },
          name: entry.name,
          size: Number(entry.size) || 0,
          deletedAt: Date.now(),
        }
        moved.push(trashId)
      } catch (error) {
        failed.push({ id: entry.id, code: 'E_IO', message: error?.message || String(error) })
      }
    }

    if (moved.length === 0) {
      try { rmSync(batch, { recursive: true, force: true }) } catch { /* 空目录删不掉也无所谓 */ }
    }
    save()
    return { moved, failed }
  }

  /** 还原：原目录不存在就重建；目标已存在视为冲突（不覆盖用户文件）。 */
  function restore(trashIds) {
    const restored = []
    const conflicts = []
    const missing = []

    for (const trashId of trashIds) {
      const record = manifest[trashId]
      if (record === undefined) { missing.push(trashId); continue }
      const { origin } = record
      // 新版清单带绝对路径（多工作区/散文件），优先用它；老清单回退到 sessions/artifacts 推导
      let target = null
      if (typeof origin.abs === 'string' && origin.abs !== '' && isAbsolute(origin.abs)) {
        target = origin.abs
      } else {
        const rootFor = origin.scope === 'shared' ? join(root, 'artifacts') : join(root, 'sessions')
        // 会话/共享区名字 + 相对路径；共享区顶层的散文件没有 session，直接是文件名
        const rel = origin.session === '' || origin.session === undefined
          ? origin.path
          : `${origin.session}/${origin.path}`
        target = resolveInside(rootFor, rel)
      }
      if (target === null) { missing.push(trashId); continue }
      if (existsSync(target)) { conflicts.push({ id: trashId, code: 'E_CONFLICT' }); continue }
      const source = join(trashRoot, trashId)
      if (!existsSync(source)) { missing.push(trashId); continue }
      try {
        moveFile(source, target)
        delete manifest[trashId]
        restored.push({ trashId, path: target })
        pruneEmptyDirs(dirname(source), trashRoot)
      } catch (error) {
        missing.push(trashId)
        console.error('[dsh-plugin-artifacts] 还原失败：', error?.message || String(error))
      }
    }

    save()
    if (restored.length > 0 && typeof onAfterRestore === 'function') onAfterRestore()
    return { restored, conflicts, missing }
  }

  /** 彻底删除（不可恢复）。 */
  function purge(trashIds) {
    const removed = []
    for (const trashId of trashIds) {
      const record = manifest[trashId]
      if (record === undefined) continue
      const source = join(trashRoot, trashId)
      try {
        if (existsSync(source)) unlinkSync(source)
        pruneEmptyDirs(dirname(source), trashRoot)
        delete manifest[trashId]
        removed.push(trashId)
      } catch (error) {
        console.error('[dsh-plugin-artifacts] 彻底删除失败：', error?.message || String(error))
      }
    }
    if (removed.length > 0) save()
    return { removed }
  }

  function purgeAll() {
    const ids = Object.keys(manifest)
    const result = purge(ids)
    // 清单里没有但磁盘上残留的（崩溃/手工删过）也一并清掉
    try {
      for (const entry of readdirSync(trashRoot, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        rmSync(join(trashRoot, entry.name), { recursive: true, force: true })
      }
    } catch { /* 目录不存在 */ }
    return result
  }

  /** 列出回收站条目（按删除时间倒序）。 */
  function list() {
    const items = Object.entries(manifest).map(([id, record]) => ({
      id,
      name: record.name,
      origin: record.origin,
      size: record.size,
      deletedAt: record.deletedAt,
      scope: record.origin?.scope === 'shared' ? 'shared' : 'session',
      session: record.origin?.session ?? '',
      path: record.origin?.path ?? '',
    }))
    items.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
    return items
  }

  function bytes() {
    let total = 0
    for (const record of Object.values(manifest)) total += Number(record.size) || 0
    return total
  }

  /** 按保留期清理：7 / 30 天，或 forever 不自动清（§9.1）。 */
  function sweep() {
    const retention = settings.get().trashRetention
    if (retention === 'forever') return { removed: 0, retention }
    const days = retention === '7' ? 7 : 30
    const cutoff = Date.now() - days * DAY_MS
    const expired = Object.entries(manifest)
      .filter(([, record]) => (Number(record.deletedAt) || 0) < cutoff)
      .map(([id]) => id)
    if (expired.length === 0) return { removed: 0, retention }

    const result = purge(expired)
    // 清单外的残留目录：超过保留期且没被清单引用的直接清掉
    try {
      for (const entry of readdirSync(trashRoot, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const abs = join(trashRoot, entry.name)
        let mtimeMs = 0
        try { mtimeMs = statSync(abs).mtimeMs } catch { continue }
        if (mtimeMs < cutoff) rmSync(abs, { recursive: true, force: true })
      }
    } catch { /* ignore */ }

    return { removed: result.removed.length, retention }
  }

  load()

  return {
    root: trashRoot,
    move,
    restore,
    purge,
    purgeAll,
    list,
    bytes,
    sweep,
    reload: load,
    itemCount: () => Object.keys(manifest).length,
  }
}
