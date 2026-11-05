/**
 * 产物管理 · 设置读写（v2）。
 *
 * v2 引入两件事：
 *   1. `roots`：多个工作区路径（安装时默认当前工作区），可增删；
 *   2. `scan` ：扫描类型开关（产物 / 记忆 / 会话），默认「产物 + 记忆」。
 *
 * 设置仍然落在主工作区的数据目录，文件不存在时用默认值**内存生效**但不落盘。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { DEFAULT_SENSITIVE } from './util.js'

export const RETENTION_CHOICES = ['7', '30', 'forever']
export const MAX_ROOTS = 8

/** 三个扫描类型。默认只要产物 + 记忆：过程现场（会话目录）噪声最大。 */
export const DEFAULT_SCAN = Object.freeze({ deliverable: true, memory: true, session: false })

/** 备份范围：产物 / 产物+记忆。过程与素材永不上传。 */
export const BACKUP_SCOPES = ['deliverable', 'deliverable+memory']
export const DEFAULT_BACKUP = Object.freeze({ scope: 'deliverable' })

/** 自动同步：默认关闭，只重传「已同步过、但本地改过」的文件。 */
export const AUTOSYNC_INTERVALS = [5, 15, 30, 60]
export const DEFAULT_AUTOSYNC = Object.freeze({ enabled: false, intervalMinutes: 15 })

export const DEFAULT_SETTINGS = Object.freeze({
  version: 2,
  roots: [],
  scan: { ...DEFAULT_SCAN },
  backup: { ...DEFAULT_BACKUP },
  autoSync: { ...DEFAULT_AUTOSYNC },
  trashRetention: '30',
  sensitiveExcludes: [...DEFAULT_SENSITIVE],
  showOthers: false,
})

const normPath = (value) => {
  const text = String(value ?? '').trim()
  if (text === '' || !isAbsolute(text)) return ''
  return resolve(text)
}

/** 路径比较统一小写（Windows）；其它平台保持原样。 */
export const samePath = (a, b) => (process.platform === 'win32'
  ? String(a).toLowerCase() === String(b).toLowerCase()
  : a === b)

/** 标签：去掉不安全字符，空则用目录名。 */
function cleanLabel(text, fallbackPath) {
  const raw = String(text ?? '').trim()
  const base = raw !== '' ? raw : (fallbackPath.split(/[\\/]/).filter(Boolean).pop() ?? '')
  const safe = base.replace(/[\\/:*?"<>|@]/g, '-').slice(0, 24).trim()
  return safe === '' ? 'root' : safe
}

/**
 * 收敛工作区列表：
 * - 只留绝对路径、去重（Windows 大小写不敏感）、去掉被外层包含的；
 * - 最多 MAX_ROOTS 个；
 * - 恰好一个 primary（显式指定的那个，否则第一个）。
 */
export function normalizeRoots(list) {
  const input = Array.isArray(list) ? list : []
  const seen = new Set()
  const roots = []
  for (const entry of input) {
    if (roots.length >= MAX_ROOTS) break
    const path = normPath(typeof entry === 'string' ? entry : entry?.path)
    if (path === '') continue
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) continue
    seen.add(key)
    roots.push({
      path,
      label: cleanLabel(typeof entry === 'string' ? '' : entry?.label, path),
      primary: typeof entry === 'object' && entry !== null && entry.primary === true,
    })
  }

  // 去掉被其它根包含的（保留更外层），primary 例外
  const kept = []
  for (const root of roots) {
    const nested = roots.some((other) => other !== root
      && (process.platform === 'win32'
        ? root.path.toLowerCase().startsWith(other.path.toLowerCase() + '\\')
        : root.path.startsWith(other.path + '/')))
    if (nested && root.primary !== true) continue
    kept.push(root)
  }

  if (kept.length > 0) {
    const explicit = kept.findIndex((root) => root.primary === true)
    const primaryIndex = explicit >= 0 ? explicit : 0
    kept.forEach((root, index) => { root.primary = index === primaryIndex })
  }

  // label 去重：重名追加序号，避免命名空间（@label）撞车
  const used = new Map()
  for (const root of kept) {
    const count = used.get(root.label) ?? 0
    used.set(root.label, count + 1)
    if (count > 0) root.label = `${root.label}-${count + 1}`
  }
  return kept
}

/** 把任意外部输入收敛成一份合法设置（未知字段丢弃，越界值回退默认）。 */
export function normalizeSettings(raw, options = {}) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const retention = RETENTION_CHOICES.includes(String(src.trashRetention))
    ? String(src.trashRetention)
    : DEFAULT_SETTINGS.trashRetention

  const patterns = Array.isArray(src.sensitiveExcludes)
    ? src.sensitiveExcludes.filter((p) => typeof p === 'string' && p.trim() !== '').slice(0, 50)
    : [...DEFAULT_SETTINGS.sensitiveExcludes]

  let roots = normalizeRoots(src.roots)
  if (roots.length === 0 && typeof options.defaultRoot === 'string' && options.defaultRoot !== '') {
    // v1 升级 / 首次安装：默认就是当前工作区
    roots = normalizeRoots([{ path: options.defaultRoot, primary: true }])
  }

  const scanSrc = src.scan !== null && typeof src.scan === 'object' ? src.scan : {}
  const scan = {
    deliverable: scanSrc.deliverable === undefined ? DEFAULT_SCAN.deliverable : scanSrc.deliverable === true,
    memory: scanSrc.memory === undefined ? DEFAULT_SCAN.memory : scanSrc.memory === true,
    session: scanSrc.session === undefined ? DEFAULT_SCAN.session : scanSrc.session === true,
  }

  const backupSrc = src.backup !== null && typeof src.backup === 'object' ? src.backup : {}
  const backup = {
    scope: BACKUP_SCOPES.includes(String(backupSrc.scope)) ? String(backupSrc.scope) : DEFAULT_BACKUP.scope,
  }

  const syncSrc = src.autoSync !== null && typeof src.autoSync === 'object' ? src.autoSync : {}
  const interval = Number(syncSrc.intervalMinutes)
  const autoSync = {
    enabled: syncSrc.enabled === true,
    intervalMinutes: AUTOSYNC_INTERVALS.includes(interval) ? interval : DEFAULT_AUTOSYNC.intervalMinutes,
  }

  return {
    version: 2,
    roots,
    scan,
    backup,
    autoSync,
    trashRetention: retention,
    sensitiveExcludes: patterns,
    showOthers: src.showOthers === true,
  }
}

export function createSettingsStore(settingsPath, options = {}) {
  const defaultRoot = typeof options.defaultRoot === 'string' ? options.defaultRoot : ''
  let current = normalizeSettings({}, { defaultRoot })
  let onDisk = false
  let loadedRaw = null

  function load() {
    if (!existsSync(settingsPath)) {
      current = normalizeSettings({}, { defaultRoot })
      onDisk = false
      loadedRaw = null
      return current
    }
    try {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'))
      loadedRaw = raw
      current = normalizeSettings(raw, { defaultRoot })
      onDisk = true
    } catch (error) {
      console.error('[dsh-plugin-artifacts] 读取设置失败，退回默认值：', error?.message || String(error))
      current = normalizeSettings({}, { defaultRoot })
      onDisk = false
      loadedRaw = null
    }
    return current
  }

  function save(next) {
    current = normalizeSettings({ ...current, ...next }, { defaultRoot })
    mkdirSync(dirname(settingsPath), { recursive: true })
    const tmp = `${settingsPath}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8')
      renameSync(tmp, settingsPath)
      onDisk = true
      loadedRaw = current
    } catch (error) {
      try { rmSync(tmp, { force: true }) } catch { /* 清理失败无所谓 */ }
      throw error
    }
    return current
  }

  load()

  return {
    get: () => ({ ...current, roots: current.roots.map((root) => ({ ...root })), scan: { ...current.scan } }),
    set: (patch) => save(patch),
    reload: () => load(),
    /** 从未落过盘（用于「卸载后工作区零改动」的说法）。 */
    isPersisted: () => onDisk,
    /** 磁盘上还是 v1（没有 roots/scan）—— 用于提示「已按默认值迁移」。 */
    migratedFromV1: () => onDisk && loadedRaw !== null && !Array.isArray(loadedRaw.roots),
  }
}
