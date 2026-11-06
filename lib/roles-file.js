/**
 * 产物管理 · 人工角色标注（`.artifacts.json`）。
 *
 * 规则（lib/roles.js）只能给初值，用户的一票永远优先：
 *   { "version": 1, "roles": { "<id>": "deliverable|scratch|memory|asset" }, "onboarded": true }
 *
 * 只存**人工覆盖**，不复制整张表 —— 规则升级不会改用户的判断，删掉文件也只是留下一条无用记录。
 * 与 `.settings.json` / `.index.json` 同放在数据目录（`sessions/` 或 `.dsh-artifacts/`）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { ROLE_LIST } from './roles.js'

const VERSION = 1
const MAX_ROLES = 50_000

export function normalizeRolesFile(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const input = src.roles !== null && typeof src.roles === 'object' ? src.roles : {}
  const roles = {}
  let count = 0
  for (const [id, role] of Object.entries(input)) {
    if (count >= MAX_ROLES) break
    if (typeof id !== 'string' || id === '') continue
    if (!ROLE_LIST.includes(role)) continue
    roles[id] = role
    count += 1
  }
  return { version: VERSION, roles, onboarded: src.onboarded === true }
}

export function createRolesStore(filePath) {
  let current = normalizeRolesFile({})

  function load() {
    if (!existsSync(filePath)) {
      current = normalizeRolesFile({})
      return current
    }
    try {
      current = normalizeRolesFile(JSON.parse(readFileSync(filePath, 'utf8')))
    } catch (error) {
      console.error('[dsh-plugin-artifacts] 角色标注读取失败，按自动判定处理：', error?.message || String(error))
      current = normalizeRolesFile({})
    }
    return current
  }

  function save() {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8')
      renameSync(tmp, filePath)
    } catch (error) {
      try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
      throw error
    }
  }

  load()

  return {
    file: filePath,
    /** 单条覆盖；没有就返回 undefined。 */
    roleOf: (id) => current.roles[id],
    /** id → role 的只读快照（扫描时批量套用）。 */
    all: () => ({ ...current.roles }),
    /**
     * 批量设置；`role === null` 表示「恢复自动判定」（删掉覆盖）。
     * @param {string[]} ids
     * @param {string|null} role
     */
    set(ids, role) {
      if (role !== null && !ROLE_LIST.includes(role)) throw Object.assign(new Error('未知角色'), { code: 'E_INVALID' })
      let changed = 0
      for (const id of ids) {
        if (typeof id !== 'string' || id === '') continue
        if (role === null) {
          if (current.roles[id] !== undefined) { delete current.roles[id]; changed += 1 }
        } else if (current.roles[id] !== role) {
          current.roles[id] = role
          changed += 1
        }
      }
      if (changed > 0) save()
      return { changed, roles: { ...current.roles } }
    },
    /** 重命名/移动时把覆盖迁到新 id；不迁就等于「标了个寂寞」。 */
    migrate(oldId, newId) {
      const role = current.roles[oldId]
      if (role === undefined || oldId === newId || current.roles[newId] !== undefined) return { migrated: false }
      current.roles[newId] = role
      delete current.roles[oldId]
      save()
      return { migrated: true, role }
    },
    stat: () => ({
      manual: Object.keys(current.roles).length,
      onboarded: current.onboarded === true,
    }),
    markOnboarded() {
      if (current.onboarded === true) return
      current.onboarded = true
      save()
    },
    reload: load,
  }
}
