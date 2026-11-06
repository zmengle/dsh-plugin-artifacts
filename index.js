/**
 * dsh-plugin-artifacts — 「我的产物」· Host 半侧
 *
 * 一个侧栏一级入口 + 一个独立页面（Client 半侧），背后是这一层：
 *   - 索引 v2（lib/indexer.js）：白名单扫描、增量、按类型/来源筛；
 *   - 文件操作（本文件）：预览 / 重命名 / 移动 / 删除进回收站 / 还原 / 彻底删除 / 归档 / 下载；
 *   - 回收站（lib/trash.js）与归档（lib/archive.js，自带 zip 写入器）；
 *   - 云端（lib/cloud.js + lib/cos.js）：未配置时一律 `E_CLOUD_DISABLED`，本地完全不受影响。
 *
 * 端点前缀 `/api/dsh-artifacts`，POST JSON，统一 `{ ok, data }` / `{ ok:false, error:{code,message} }`。
 * 刻意不 import `@deepseek-ai/*`：插件装在 profile 里时宿主解析第三方 ESM 的钩子不保证可用，
 * 零依赖最稳。
 */

import { spawn } from 'node:child_process'
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { createArchive } from './lib/archive.js'
import { createAutoSync } from './lib/autosync.js'
import { createCloud } from './lib/cloud.js'
import { createIndexer } from './lib/indexer.js'
import { ROLE_LIST, roleOf } from './lib/roles.js'
import { createRolesStore } from './lib/roles-file.js'
import { createSettingsStore } from './lib/settings.js'
import { createTrash } from './lib/trash.js'
import {
  createSensitiveMatcher, dirnameRel, extOf, isSafeFileName,
  kindOf, normalizeRel, resolveInside, titleOf,
} from './lib/util.js'

export const name = 'dsh-plugin-artifacts'

/** Host 硬依赖：HTTP 通道。 */
export const inject = ['webServer']

const API_PREFIX = '/api/dsh-artifacts'
/** 预览上限（§5 大文件）。 */
const PREVIEW_BYTES = 256 * 1024
/** 单次删除上限（§4.1）。 */
const MAX_DELETE = 200
/** 传输上限 2 GB（§5）。 */
const MAX_TRANSFER = 2 * 1024 * 1024 * 1024
/** 删除令牌有效期。 */
const TOKEN_TTL_MS = 60_000

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yml', '.yaml',
  '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.py', '.ps1', '.log',
])

class AppError extends Error {
  constructor(code, message, status = 400, detail) {
    super(message)
    this.code = code
    this.status = status
    this.detail = detail
  }
}

const codeOf = (error) => (error instanceof AppError ? error.code : (error?.code || 'E_INTERNAL'))

// ---------------------------------------------------------------------------
// 工作区
// ---------------------------------------------------------------------------

/**
 * 单工作区（§1）。解析顺序（前一条命不中才往下走）：
 *   1. `config.workspaceRoot` —— 用户在 cordis.patch.yml 里写死的；
 *   2. `ctx.get('workingDirectory').defaultDirectory` —— 宿主的默认工作目录；
 *   3. `$DSH_HOME/storages/workspace.json` —— 桌面端**持久化**的工作区登记表
 *      （宿主启动早期工作目录服务可能还没就绪，这是最靠谱的兜底）；
 *   4. 环境变量 `DSH_WORKSPACE` / `DSH_WORKSPACE_ROOT`；
 *   5. `process.cwd()`。
 *
 * 第 2/5 条都可能是「DSH 自己的 home / profile 目录」（实测 Electron 下 cwd 就是 profile），
 * 那种路径下没有 sessions/，扫出来是空的 —— 所以这两条都要先过 `looksLikeHostHome` 检查。
 */
function resolveWorkspaceRoot(ctx, config) {
  const fromConfig = typeof config?.workspaceRoot === 'string' ? config.workspaceRoot.trim() : ''
  if (fromConfig !== '') return { root: fromConfig, source: 'config' }

  const usable = (value) => {
    const dir = typeof value === 'string' ? value.trim() : ''
    if (dir === '') return false
    if (looksLikeHostHome(dir)) return false
    try {
      return statSync(dir).isDirectory()
    } catch {
      return false
    }
  }

  try {
    const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (usable(service?.defaultDirectory)) {
      return { root: String(service.defaultDirectory).trim(), source: 'workingDirectory' }
    }
  } catch { /* 服务不存在就是不存在 */ }

  const stored = workspaceFromStore()
  if (stored !== '') return { root: stored, source: 'workspace-store' }

  const fromEnv = String(process.env.DSH_WORKSPACE || process.env.DSH_WORKSPACE_ROOT || '').trim()
  if (usable(fromEnv)) return { root: fromEnv, source: 'env' }

  const cwd = process.cwd()
  if (usable(cwd)) return { root: cwd, source: 'cwd' }

  // 都不像工作区：宁可指向已登记的 workspace，也不要往 profile 里写索引
  return { root: stored || cwd, source: stored !== '' ? 'workspace-store' : 'cwd' }
}

/** DSH 自己的 home / profile 目录不是工作区。 */
function looksLikeHostHome(dir) {
  try {
    const home = resolveHostHome()
    const target = resolve(dir).toLowerCase()
    const base = resolve(home).toLowerCase()
    return target === base || target.startsWith(base + sep) || target.startsWith(join(base, 'profiles').toLowerCase())
  } catch {
    return false
  }
}

function resolveHostHome() {
  const fromEnv = String(process.env.DSH_HOME || '').trim()
  if (fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * 从桌面端的工作区登记表里读路径。
 * 结构：`{ global: { workspaceIds: [...] }, tables: { workspaces: { [id]: { path, title } } } }`
 * 多个工作区时优先选真的有 `sessions/` 的那个（就是当前在用的工作区）。
 */
function workspaceFromStore() {
  const file = join(resolveHostHome(), 'storages', 'workspace.json')
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const table = raw?.tables?.workspaces ?? {}
    const order = Array.isArray(raw?.global?.workspaceIds) && raw.global.workspaceIds.length > 0
      ? raw.global.workspaceIds
      : Object.keys(table)
    const candidates = order
      .map((id) => table[id])
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string' && entry.path.trim() !== '')
      .map((entry) => entry.path.trim())
    if (candidates.length === 0) return ''
    const withSessions = candidates.find((dir) => existsSync(join(dir, 'sessions')) || existsSync(join(dir, 'artifacts')))
    return withSessions ?? candidates[0]
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > maxBytes) throw new AppError('E_TOO_LARGE', '请求体过大')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new AppError('E_INVALID', '请求不是合法 JSON')
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

const ok = (res, data) => sendJson(res, 200, { ok: true, data })
const fail = (res, error) => {
  const code = codeOf(error)
  const status = error?.status ?? (code === 'E_NOT_FOUND' ? 404 : code === 'E_FORBIDDEN' ? 403 : 400)
  sendJson(res, status, { ok: false, error: { code, message: error?.message || String(error), detail: error?.detail } })
}

/** 需要 `{ ids: [] }` 的批量端点。 */
function readIds(body, field = 'ids') {
  const raw = Array.isArray(body?.[field]) ? body[field] : []
  const ids = raw.filter((id) => typeof id === 'string' && id !== '')
  if (ids.length === 0) throw new AppError('E_INVALID', '缺少 ' + field)
  return ids
}

/**
 * 用户在系统目录选择器里挑的目标目录。
 * 允许工作区之外的绝对路径（这是用户主动选的），但仍要确认它是个存在的目录。
 */
function readTargetDir(body, required = false) {
  const raw = typeof body?.targetDir === 'string' ? body.targetDir.trim() : ''
  if (raw === '') {
    if (required) throw new AppError('E_INVALID', '缺少目标目录')
    return undefined
  }
  if (!isAbsolute(raw)) throw new AppError('E_INVALID', '目标目录必须是绝对路径')
  let stat
  try {
    stat = statSync(raw)
  } catch {
    throw new AppError('E_NOT_FOUND', '目标目录不存在')
  }
  if (!stat.isDirectory()) throw new AppError('E_INVALID', '目标路径不是目录')
  return resolve(raw)
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx, passedConfig) {
  const config = (passedConfig !== null && typeof passedConfig === 'object')
    ? passedConfig
    : (ctx?.config !== null && typeof ctx?.config === 'object' ? ctx.config : {})
  const initialRoot = resolveWorkspaceRoot(ctx, config)
  let root = initialRoot.root
  let rootSource = initialRoot.source
  /** @type {ReturnType<typeof createStores>|null} */
  let stores = null

  function createStores(baseRoot) {
    // 数据目录：优先 `<root>/sessions/`（现状，零迁移），没有就退到隐藏目录 `.dsh-artifacts/`
    const dataDir = existsSync(join(baseRoot, 'sessions'))
      ? join(baseRoot, 'sessions')
      : join(baseRoot, '.dsh-artifacts')
    const settings = createSettingsStore(join(dataDir, '.settings.json'), { defaultRoot: baseRoot })
    const roles = createRolesStore(join(dataDir, '.artifacts.json'))
    const indexer = createIndexer({ root: baseRoot, settings, roles, dataDir })
    const archive = createArchive({ root: baseRoot, dataDir })
    const trash = createTrash({
      root: baseRoot,
      settings,
      onAfterRestore: () => { indexer.refresh({ maxFiles: 4000 }).catch(() => {}) },
    })
    const cloud = createCloud({
      root: baseRoot,
      dataDir,
      getCredentials: () => {
        try {
          return typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
        } catch {
          return undefined
        }
      },
    })
    const autoSync = createAutoSync({ settings, indexer, cloud })
    autoSync.start()
    return { settings, roles, indexer, archive, trash, cloud, autoSync }
  }

  function ensureStores(force = false) {
    const next = resolveWorkspaceRoot(ctx, config)
    if (force || stores === null || next.root !== root) {
      root = next.root
      rootSource = next.source
      stores = createStores(next.root)
    }
    return stores
  }

  // ---- 条目 ↔ 绝对路径 ----

  function absOf(item) {
    // 新索引直接带绝对路径（多工作区/散文件都靠它定位）；老索引回退到路径推导
    if (typeof item.abs === 'string' && item.abs !== '' && isAbsolute(item.abs)) return item.abs
    const rel = item.scope === 'shared' ? item.id : `sessions/${item.id}`
    return resolveInside(root, rel)
  }

  function itemOrThrow(id) {
    const { indexer } = ensureStores()
    const item = indexer.get(id)
    if (item === undefined) throw new AppError('E_NOT_FOUND', '条目不存在（可能已被手动删除）', 404)
    const abs = absOf(item)
    if (abs === null || !existsSync(abs)) throw new AppError('E_NOT_FOUND', '文件已不在磁盘上', 404)
    return { ...item, abs }
  }

  function decorate(item) {
    const { archive, cloud } = ensureStores()
    return {
      ...item,
      archived: archive.isArchived(item),
      // key 只回「已上传的那一份」：本地还没传过就不编一个假路径出来
      cloud: { state: cloud.stateOf(item), key: cloud.recordedKeyOf(item) ?? null },
    }
  }

  // ---- 删除令牌 ----

  /** @type {Map<string, { ids: Set<string>, expiresAt: number }>} */
  const tokens = new Map()

  function issueToken(ids) {
    const token = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    tokens.set(token, { ids: new Set(ids), expiresAt: Date.now() + TOKEN_TTL_MS })
    // 顺手清过期令牌，别让 Map 长草
    for (const [key, value] of tokens) {
      if (value.expiresAt < Date.now()) tokens.delete(key)
    }
    return token
  }

  function consumeToken(token, ids) {
    const record = tokens.get(token)
    if (record === undefined) throw new AppError('E_INVALID', '删除令牌无效，请重新确认')
    if (record.expiresAt < Date.now()) {
      tokens.delete(token)
      throw new AppError('E_INVALID', '删除令牌已过期（60 秒有效）')
    }
    const wanted = new Set(ids)
    if (record.ids.size !== wanted.size || ![...wanted].every((id) => record.ids.has(id))) {
      throw new AppError('E_FORBIDDEN', '令牌与要删除的条目不匹配')
    }
    tokens.delete(token)
    return true
  }

  // -------------------------------------------------------------------------
  // 端点实现
  // -------------------------------------------------------------------------

  async function status() {
    const { indexer, trash, cloud, settings, archive, roles } = ensureStores()
    if (!indexer.isLoaded()) await indexer.refresh({ maxFiles: 4000 })
    const stats = indexer.stats()
    const conf = settings.get()
    return {
      workspace: root,
      workspaceSource: rootSource,
      workspaceHasSessions: existsSync(join(root, 'sessions')),
      roots: conf.roots.map((entry) => ({
        ...entry,
        exists: existsSync(entry.path),
      })),
      scan: conf.scan,
      items: stats.total,
      bytes: stats.bytes,
      byKind: stats.byKind,
      byRole: stats.byRole,
      generatedAt: stats.generatedAt,
      truncated: stats.truncated,
      trash: { items: trash.itemCount(), bytes: trash.bytes() },
      archive: { count: archive.list().length },
      cloud: (() => {
        const summary = cloud.status()
        // 数字按「当前索引里能看到的」算：被扫成过程而没收录的，不该让「云端 4」对着空列表
        const visible = new Set(indexer.all().map((item) => item.id))
        const recorded = cloud.recordedIds().filter((id) => visible.has(id))
        // 记录有、但索引里没有：再分两种——文件还在（只是扫描类型没收录）vs 真的没了
        const missing = cloud.orphanIds(visible)
        const orphans = missing.filter((id) => {
          const abs = indexer.resolveId(id)
          return abs === null || !existsSync(abs)
        })
        const hidden = missing.length - orphans.length
        return {
          ...summary,
          uploaded: recorded.length,
          recordedTotal: summary.uploaded,
          orphans: orphans.length,
          hidden,
        }
      })(),
      settings: conf,
      roles: roles.stat(),
      autoSync: ensureStores().autoSync.status(),
      kinds: indexer.primaryKinds,
      labels: indexer.labels,
      version: 2,
    }
  }

  /** 云端 tab 只列「有云端副本」的条目：仅本地的不该混进来，否则会让人以为云端有东西。 */
  const CLOUD_STATES = new Set(['synced', 'conflict', 'remote-only'])

  /**
   * 搜索语法：`type:code` / `role:scratch` / `session:<目录名>` 可以混在关键词里。
   * 解析后从文本里剔除，剩下的仍按文件名/标题/路径模糊匹配。
   */
  function parseQuery(raw) {
    const text = []
    const parsed = { kinds: undefined, role: undefined, session: undefined }
    for (const token of String(raw ?? '').split(/\s+/)) {
      const match = /^(type|role|session):(\S+)$/i.exec(token)
      if (match === null) {
        if (token !== '') text.push(token)
        continue
      }
      const key = match[1].toLowerCase()
      const value = match[2]
      if (key === 'type') parsed.kinds = value.split(',').filter((kind) => kind !== '')
      else if (key === 'role') {
        // 非法角色直接忽略这个 token（搜索框边打字边请求，返回 400 会一直弹错误）
        if (ROLE_LIST.includes(value) || value === 'all') parsed.role = value
      }
      else parsed.session = value
    }
    return { q: text.join(' '), ...parsed }
  }

  async function items(body) {
    const { indexer, cloud } = ensureStores()
    // `fresh: true` = 页面轮询时主动要一次增量扫描；否则走 15 秒的陈旧窗口
    if (body?.fresh === true) await indexer.refresh({ maxFiles: 20000 })
    else await indexer.ensureFresh()
    const parsed = parseQuery(body?.q)
    const kinds = Array.isArray(body?.kinds)
      ? body.kinds
      : (typeof body?.kind === 'string' && body.kind !== '' && body.kind !== 'all' ? [body.kind] : parsed.kinds)
    const cloudOnly = body?.cloudOnly === true
    // 默认只看产物；云端 tab 例外（它关心的是"有没有云端副本"，与角色无关）
    const roleInput = parsed.role ?? (typeof body?.role === 'string' && body.role !== '' ? body.role : (cloudOnly ? 'all' : 'deliverable'))
    const result = indexer.query({
      scope: body?.scope,
      role: roleInput,
      kinds,
      root: body?.root,
      q: parsed.q,
      session: parsed.session ?? body?.session,
      sort: body?.sort,
      order: body?.order,
      offset: body?.offset,
      limit: body?.limit,
      keep: cloudOnly ? (item) => CLOUD_STATES.has(cloud.stateOf(item)) : undefined,
      decorate,
    })
    return {
      ...result,
      role: roleInput,
      truncated: indexer.truncatedSessions(),
    }
  }

  async function refreshIndex(body) {
    const { indexer } = ensureStores()
    const result = body?.full === true
      ? await indexer.rebuild()
      : await indexer.refresh({ maxFiles: 20000 })
    return { ...result, status: await status() }
  }

  async function readItem(body) {
    const id = String(body?.id ?? '')
    const item = itemOrThrow(id)
    const limit = Math.min(PREVIEW_BYTES, Math.max(1024, Number(body?.maxBytes) || PREVIEW_BYTES))
    const ext = extOf(item.name)
    const textLike = TEXT_EXTENSIONS.has(ext) || item.kind === 'code'
    const abs = item.abs
    const { cloud } = ensureStores()
    // 云端副本的 key（没上传过就是 null）—— 云端的"文件在哪"和本地路径是两回事
    const cloudKey = cloud.recordedKeyOf(item) ?? null
    const cloudState = cloud.stateOf(item)

    if (!textLike) {
      return {
        id, kind: item.kind, ext, binary: true, abs, cloudKey, cloudState,
        previewUrl: `/api/dsh-artifacts/raw?id=${encodeURIComponent(id)}`, title: item.title,
      }
    }

    const size = statSync(abs).size
    if (size > MAX_TRANSFER) throw new AppError('E_TOO_LARGE', '文件超过 2 GB，不支持预览')

    // 只读开头 limit 字节 —— 预览一个 800 MB 的日志不能把整文件塞进内存
    const buffer = Buffer.alloc(Math.min(limit, size))
    let read = 0
    let fd
    try {
      fd = openSync(abs, 'r')
      read = readSync(fd, buffer, 0, buffer.length, 0)
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* ignore */ }
      }
    }
    return {
      id,
      kind: item.kind,
      ext,
      binary: false,
      abs,
      cloudKey,
      cloudState,
      title: item.title,
      truncated: size > limit,
      bytes: size,
      content: buffer.subarray(0, read).toString('utf8'),
    }
  }

  /** 重命名 / 移动：`to` 不含斜杠 = 同目录改名；含斜杠 = 移到本会话内的目标目录。 */
  async function moveOrRename(body) {
    const id = String(body?.id ?? '')
    const item = itemOrThrow(id)
    const requested = String(body?.to ?? '').trim().replace(/\\/g, '/')
    if (requested === '') throw new AppError('E_INVALID', '缺少目标名称')

    const { indexer, cloud, settings } = ensureStores()
    const sensitive = createSensitiveMatcher(settings.get().sensitiveExcludes)

    // item.path 是「相对本会话/共享区」的路径，item.id 前面还挂着会话名 —— 取目录要从 path 取
    const currentDir = dirnameRel(item.path)
    let targetName
    let targetDir
    if (!requested.includes('/')) {
      targetName = requested
      targetDir = currentDir
    } else {
      const normalized = normalizeRel(requested)
      if (normalized === null) throw new AppError('E_FORBIDDEN', '目标路径越界')
      targetName = basename(normalized)
      targetDir = dirnameRel(normalized)
    }

    if (!isSafeFileName(targetName)) throw new AppError('E_INVALID', '文件名不合法')
    if (sensitive(targetName)) throw new AppError('E_FORBIDDEN', '敏感文件不允许出现在产物里')

    // 目标绝对路径：会话/共享按固定布局算；散文件（scope=root）按它所属工作区算
    let baseDir = null
    if (item.scope === 'session') baseDir = join(root, 'sessions', item.session)
    else if (item.scope === 'shared') baseDir = item.session === '' ? join(root, 'artifacts') : join(root, 'artifacts', item.session)
    else {
      const conf = ensureStores().settings.get()
      const extra = conf.roots.find((entry) => `@${entry.label}` === item.session)
      baseDir = extra !== undefined ? extra.path : root
    }
    const targetPath = targetDir === '' ? targetName : `${targetDir}/${targetName}`
    const targetAbs = resolveInside(baseDir, targetPath)
    if (targetAbs === null) throw new AppError('E_FORBIDDEN', '目标路径越界')
    if (existsSync(targetAbs) && targetAbs !== item.abs) throw new AppError('E_CONFLICT', '目标位置已有同名文件')

    mkdirSync(dirname(targetAbs), { recursive: true })
    renameSync(item.abs, targetAbs)

    const nextId = item.scope === 'session'
      ? `${item.session}/${targetPath}`
      : item.scope === 'shared'
        ? `artifacts/${item.session === '' ? targetPath : `${item.session}/${targetPath}`}`
        : item.session === '_root'
          ? `_root/${targetPath}`
          : `${item.session}/${targetPath}`
    const stat = statSync(targetAbs)
    const kind = kindOf(extOf(targetName))

    const nextExt = extOf(targetName)
    // 重命名 = 同一个文件换个名字：云端记录和人工标注都要**跟着迁移**，
    // 否则会变成「仅本地」+ 桶里留一份孤儿（曾经的 bug）。
    const cloudMigrated = cloud.migrate(id, nextId)
    const roleMigrated = ensureStores().roles.migrate(id, nextId)
    const manualRole = ensureStores().roles.roleOf(nextId)

    indexer.relocate(id, {
      id: nextId,
      path: targetPath,
      name: targetName,
      abs: targetAbs,
      ext: nextExt,
      kind,
      role: manualRole ?? roleOf({ path: targetPath, name: targetName, ext: nextExt }),
      roleSource: manualRole === undefined ? 'auto' : 'manual',
      size: stat.size,
      mtime: stat.mtimeMs,
      mtimeIso: new Date(stat.mtimeMs).toISOString(),
      title: titleOf(targetAbs, targetName, kind),
      thumb: kind === 'image' ? `/api/dsh-artifacts/raw?id=${encodeURIComponent(nextId)}` : null,
      sha256: null,
    })

    return {
      id: nextId, name: targetName, path: targetPath, abs: targetAbs,
      cloudMigrated: cloudMigrated.migrated === true,
      roleMigrated: roleMigrated.migrated === true,
    }
  }

  async function deleteItems(body) {
    const ids = readIds(body)
    if (ids.length > MAX_DELETE) throw new AppError('E_INVALID', `一次最多删除 ${MAX_DELETE} 个文件`)
    consumeToken(String(body?.token ?? ''), ids)

    const { indexer, trash } = ensureStores()
    const entries = []
    for (const id of ids) {
      const item = indexer.get(id)
      if (item === undefined) continue
      const abs = absOf(item)
      if (abs === null || !existsSync(abs)) continue
      entries.push({ ...item, abs })
    }
    const result = trash.move(entries)
    indexer.forget(entries.map((entry) => entry.id))
    return { moved: result.moved.length, failed: result.failed, ids }
  }

  async function trashList() {
    const { trash, settings } = ensureStores()
    trash.reload()
    return {
      items: trash.list(),
      bytes: trash.bytes(),
      retention: settings.get().trashRetention,
    }
  }

  async function restoreItems(body) {
    const ids = readIds(body)
    const { trash, indexer } = ensureStores()
    trash.reload()
    const result = trash.restore(ids)
    if (result.restored.length > 0) await indexer.refresh({ maxFiles: 5000 })
    return result
  }

  async function purgeItems(body) {
    const { trash } = ensureStores()
    trash.reload()
    if (body?.all === true) {
      const result = trash.purgeAll()
      return { removed: result.removed.length, all: true }
    }
    const ids = readIds(body)
    const result = trash.purge(ids)
    return { removed: result.removed.length, all: false }
  }

  async function archiveItems(body) {
    const { indexer, archive } = ensureStores()
    await indexer.ensureFresh()

    const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string') : []
    const bySession = ids.length === 0
    let chosen = []
    if (!bySession) {
      chosen = ids.map((id) => indexer.get(id)).filter((item) => item !== undefined)
    } else if (typeof body?.session === 'string' && body.session !== '') {
      chosen = indexer.all().filter((item) => item.session === body.session)
    } else {
      throw new AppError('E_INVALID', '需要 ids 或 session')
    }
    if (chosen.length === 0) throw new AppError('E_NOT_FOUND', '没有可归档的文件')
    if (chosen.length > 2000) throw new AppError('E_INVALID', '一次最多归档 2000 个文件')

    const key = archive.keyOf(chosen[0])
    const label = chosen[0].scope === 'shared' ? `shared-${chosen[0].session || 'root'}` : chosen[0].session
    const enriched = chosen.map((item) => ({ ...item, abs: absOf(item) })).filter((item) => item.abs !== null)
    // 勾选部分文件时只给这些打角标；整会话归档才按「会话级」标记
    const result = archive.create({ items: enriched, key, label, subset: !bySession })
    return { ...result, key, count: enriched.length }
  }

  async function settingsEndpoint(method, body) {
    const { settings, indexer } = ensureStores()
    if (method === 'GET') {
      const conf = settings.get()
      const stats = indexer.stats()
      return {
        ...conf,
        migratedFromV1: settings.migratedFromV1(),
        rootsInfo: conf.roots.map((entry) => ({
          ...entry,
          exists: existsSync(entry.path),
          items: stats.total,
        })),
        counts: stats.byRole,
        total: stats.total,
      }
    }
    const patch = {}
    if (typeof body?.trashRetention === 'string') patch.trashRetention = body.trashRetention
    if (Array.isArray(body?.sensitiveExcludes)) patch.sensitiveExcludes = body.sensitiveExcludes
    if (typeof body?.showOthers === 'boolean') patch.showOthers = body.showOthers
    if (Array.isArray(body?.roots)) patch.roots = body.roots
    if (body?.scan !== null && typeof body?.scan === 'object') patch.scan = body.scan
    if (body?.backup !== null && typeof body?.backup === 'object') patch.backup = body.backup
    if (body?.autoSync !== null && typeof body?.autoSync === 'object') patch.autoSync = body.autoSync
    if (Object.keys(patch).length === 0) throw new AppError('E_INVALID', '没有可保存的设置项')

    // 根必须存在且是目录；不存在就明确报错，而不是"保存成功但列表空"
    if (Array.isArray(patch.roots)) {
      for (const entry of patch.roots) {
        const path = String(entry?.path ?? '').trim()
        if (path === '') continue
        if (!existsSync(path)) throw new AppError('E_INVALID', `工作区不存在：${path}`)
        let stat = null
        try { stat = statSync(path) } catch { /* 下面统一报错 */ }
        if (stat === null || !stat.isDirectory()) throw new AppError('E_INVALID', `不是目录：${path}`)
      }
    }

    const next = settings.set(patch)
    // 可见范围/同步设置变了：重扫 + 重排定时器
    ensureStores().autoSync.reconfigure()
    await indexer.rebuild()
    // 保存后这个标记一定是 false（已经按 v2 结构落盘了），带上是为了让客户端逻辑统一
    return { ...next, migratedFromV1: settings.migratedFromV1() }
  }

  /**
   * 人工角色标注：整理模式的读写口。
   * POST `{ ids: [...], role: 'deliverable'|'scratch'|'memory'|'asset'|null }`
   *   role = null 表示「恢复自动判定」。
   */
  async function rolesEndpoint(method, body) {
    const { roles, indexer } = ensureStores()
    if (method === 'GET') return { ...roles.stat(), overrides: roles.all() }
    const ids = readIds(body)
    const role = body?.role === null ? null : String(body?.role ?? '')
    if (role !== null && !['deliverable', 'scratch', 'memory', 'asset'].includes(role)) {
      throw new AppError('E_INVALID', '未知角色：' + role)
    }
    const result = roles.set(ids, role)
    // 角色变了要重扫：扫描开关是按角色过滤的，条目可能整体进出
    await indexer.rebuild()
    return { ...result, ...roles.stat() }
  }

  /**
   * 自动同步：读状态 / 改开关 / 立即跑一轮。
   * POST `{ enabled?, intervalMinutes?, runNow?: true }`
   */
  async function autoSyncEndpoint(method, body) {
    const { settings, autoSync } = ensureStores()
    if (method === 'GET') return autoSync.status()
    const patch = {}
    if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled
    if (body?.intervalMinutes !== undefined) patch.intervalMinutes = Number(body.intervalMinutes)
    if (Object.keys(patch).length > 0) {
      const current = settings.get().autoSync ?? {}
      settings.set({ autoSync: { ...current, ...patch } })
      autoSync.reconfigure()
    }
    if (body?.runNow === true) await autoSync.runOnce()
    return autoSync.status()
  }

  /**
   * 孤儿记录：有 `.cloud.json` 记录、但索引里已经没有对应文件（删除/挪走）。
   * GET 列出；POST `{ purge: true }` 清掉（只删本地记录，不动桶里的对象）。
   */
  async function orphansEndpoint(method, body) {
    const { cloud, indexer } = ensureStores()
    const visible = new Set(indexer.all().map((item) => item.id))
    // 只算「文件真的不在了」的；文件还在、只是扫描类型没收录的（hidden）留给状态里单独说明
    const ids = cloud.orphanIds(visible).filter((id) => {
      const abs = indexer.resolveId(id)
      return abs === null || !existsSync(abs)
    })
    if (method === 'GET') {
      return { ids, items: ids.map((id) => ({ id, key: cloud.recordedKeyOf({ id }) ?? '' })) }
    }
    const target = Array.isArray(body?.ids) && body.ids.length > 0 ? readIds(body) : ids
    let removed = 0
    for (const id of target) {
      cloud.forget(id)
      removed += 1
    }
    return { removed, remaining: ids.filter((id) => cloud.recordedKeyOf({ id }) !== undefined).length }
  }

  /**
   * 在系统文件管理器里定位文件。
   * 注意：spawn 的失败是**异步 error 事件**，不挂监听会变成未捕获异常（整个宿主进程挂掉），
   * 所以这里用 Promise 等「spawn 成功 / error」，而不是外层 try/catch。
   */
  function revealItem(body) {
    const id = String(body?.id ?? '')
    const item = itemOrThrow(id)
    const command = process.platform === 'win32'
      ? { file: 'explorer.exe', args: ['/select,', item.abs] }
      : process.platform === 'darwin'
        ? { file: 'open', args: ['-R', item.abs] }
        : { file: 'xdg-open', args: [dirname(item.abs)] }

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        if (error) reject(new AppError('E_INTERNAL', '打开文件管理器失败：' + (error?.message || String(error))))
        else resolve({ opened: true })
      }
      let child
      try {
        child = spawn(command.file, command.args, { detached: true, stdio: 'ignore' })
      } catch (error) {
        finish(error)
        return
      }
      child.once('error', (error) => finish(error))
      // 能成功拉起就立刻返回，不阻塞请求（explorer 会一直运行）
      child.once('spawn', () => {
        try { child.unref() } catch { /* ignore */ }
        finish(null)
      })
      // 极少数平台不触发 spawn 事件，给个兜底
      setTimeout(() => finish(null), 1500).unref?.()
    })
  }

  // ---- 云端 ----

  async function cloudCall(action, body) {
    const { cloud } = ensureStores()
    if (action === 'config') {
      if (body?.save === true) return { config: await cloud.saveConfig(body) }
      return { config: await cloud.publicConfig() }
    }
    // 没配置一律 E_CLOUD_DISABLED（§6.4）—— 批量端点不能退化成「每条都失败」的 200 响应
    if (cloud.status().enabled !== true) {
      throw new AppError('E_CLOUD_DISABLED', '云端尚未配置：先在「云端」页填好 COS 信息并启用', 400)
    }
    if (action === 'test') {
      const result = await cloud.test()
      return { ...result, config: await cloud.publicConfig() }
    }
    if (action === 'upload') {
      const { indexer, settings } = ensureStores()
      // `scope: 'backup'` = 把当前备份范围内的产物全部传一遍（过程/素材永不包含）
      let ids
      if (body?.scope === 'backup') {
        const scope = settings.get().backup?.scope ?? 'deliverable'
        ids = indexer.all()
          .filter((item) => item.role === 'deliverable' || (scope === 'deliverable+memory' && item.role === 'memory'))
          .map((item) => item.id)
        if (ids.length > 500) ids = ids.slice(0, 500)
      } else {
        ids = readIds(body)
      }
      const uploaded = []
      const failed = []
      // 并发 3（§5）
      const queue = [...ids]
      const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length > 0) {
          const id = queue.shift()
          const item = indexer.get(id)
          if (item === undefined) { failed.push({ id, code: 'E_NOT_FOUND', message: '条目不存在' }); continue }
          const abs = absOf(item)
          if (abs === null) { failed.push({ id, code: 'E_FORBIDDEN', message: '路径非法' }); continue }
          try {
            const result = await cloud.upload({ ...item, abs })
            indexer.relocate(id, { sha256: result.sha256 })
            uploaded.push({ id, ...result })
          } catch (error) {
            failed.push({ id, code: codeOf(error), message: error?.message || String(error) })
          }
        }
      })
      await Promise.all(workers)
      return { uploaded, failed }
    }
    if (action === 'download') {
      const ids = readIds(body)
      const targetDir = readTargetDir(body)
      const { indexer } = ensureStores()
      const downloaded = []
      const failed = []
      for (const id of ids) {
        const item = indexer.get(id)
        if (item === undefined) { failed.push({ id, code: 'E_NOT_FOUND', message: '条目不存在' }); continue }
        const abs = absOf(item) ?? join(root, 'sessions', item.id)
        try {
          downloaded.push({ id, ...(await cloud.download({ ...item, abs, targetDir })) })
        } catch (error) {
          failed.push({ id, code: codeOf(error), message: error?.message || String(error) })
        }
      }
      return { downloaded, failed }
    }
    if (action === 'reconcile') {
      const { indexer } = ensureStores()
      const all = indexer.all().map((item) => ({ ...item, abs: absOf(item) })).filter((item) => item.abs !== null)
      return await cloud.reconcile(all)
    }
    if (action === 'delete-remote') {
      const ids = readIds(body)
      const { indexer } = ensureStores()
      const removed = []
      const failed = []
      for (const id of ids) {
        const item = indexer.get(id)
        if (item === undefined) { failed.push({ id, code: 'E_NOT_FOUND' }); continue }
        try {
          removed.push({ id, ...(await cloud.removeRemote(item)) })
        } catch (error) {
          failed.push({ id, code: codeOf(error), message: error?.message || String(error) })
        }
      }
      return { removed, failed }
    }
    throw new AppError('E_INVALID', '未知云端操作 ' + action)
  }

  // -------------------------------------------------------------------------
  // 二进制端点（GET）
  // -------------------------------------------------------------------------

  /**
   * 允许内联打开的类型。**故意不含 html / svg**：工作区里的这两个类型可能带脚本，
   * 内联到宿主同源上下文就等于把页面交出去。它们一律走 attachment。
   */
  const INLINE_SAFE = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif',
    '.mp4', '.webm', '.mov', '.pdf',
    '.txt', '.md', '.mdx', '.csv', '.tsv', '.json', '.log',
  ])

  function serveBinary(req, res, id, disposition) {
    const item = itemOrThrow(id)
    let stat
    try {
      stat = statSync(item.abs)
    } catch {
      throw new AppError('E_NOT_FOUND', '文件已不在磁盘上', 404)
    }
    if (stat.size > MAX_TRANSFER) throw new AppError('E_TOO_LARGE', '文件超过 2 GB，不支持直接传输')

    const inline = disposition === 'inline' && INLINE_SAFE.has(extOf(item.name))
    const encoded = encodeURIComponent(item.name)
    const headers = {
      'content-type': contentTypeOf(item.name),
      'content-length': String(stat.size),
      'cache-control': 'no-store',
      'accept-ranges': 'none',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
      'x-content-type-options': 'nosniff',
    }
    // 内联的文本（txt/md/json…）也在宿主同源里渲染：给它们套一层沙箱 CSP
    if (inline) headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"
    res.writeHead(200, headers)
    const stream = createReadStream(item.abs)
    stream.on('error', () => { try { res.destroy() } catch { /* ignore */ } })
    stream.pipe(res)
  }

  const CONTENT_TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  }
  const contentTypeOf = (name) => CONTENT_TYPES[extOf(name)] || 'application/octet-stream'

  // -------------------------------------------------------------------------
  // 路由
  // -------------------------------------------------------------------------

  async function handle(req, res) {
    const route = (req.url || '').split('?')[0]
    const query = new URL(req.url || '/', 'http://127.0.0.1').searchParams
    const action = route.startsWith(API_PREFIX) ? route.slice(API_PREFIX.length) : route

    // GET：raw / download 走流式，其余走统一 JSON
    if (req.method === 'GET' && (action === '/raw' || action === '/download')) {
      const id = query.get('id') || ''
      if (id === '') throw new AppError('E_INVALID', '缺少 id')
      serveBinary(req, res, id, action === '/raw' ? 'inline' : 'attachment')
      return
    }
    if (req.method === 'GET' && action === '/settings') {
      ok(res, await settingsEndpoint('GET'))
      return
    }
    if (req.method === 'GET' && action === '/artifacts/roles') {
      ok(res, await rolesEndpoint('GET'))
      return
    }
    if (req.method === 'GET' && action === '/cloud/autosync') {
      ok(res, await autoSyncEndpoint('GET'))
      return
    }
    if (req.method === 'GET' && action === '/cloud/orphans') {
      ok(res, await orphansEndpoint('GET'))
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' })
      res.end('method not allowed')
      return
    }

    const body = await readJson(req)
    ensureStores()

    switch (action) {
      case '/status':
        ok(res, await status())
        return
      case '/index/refresh':
        ok(res, await refreshIndex(body))
        return
      case '/items':
        ok(res, await items(body))
        return
      case '/item/read':
        ok(res, await readItem(body))
        return
      case '/item/rename':
      case '/item/move':
        ok(res, await moveOrRename(body))
        return
      case '/delete-token':
        ok(res, { token: issueToken(readIds(body)), expiresAt: Date.now() + TOKEN_TTL_MS })
        return
      case '/item/delete':
        ok(res, await deleteItems(body))
        return
      case '/trash/list':
        ok(res, await trashList())
        return
      case '/trash/size':
        ok(res, { items: ensureStores().trash.itemCount(), bytes: ensureStores().trash.bytes() })
        return
      case '/item/restore':
        ok(res, await restoreItems(body))
        return
      case '/item/purge':
        ok(res, await purgeItems(body))
        return
      case '/archive':
        ok(res, await archiveItems(body))
        return
      case '/reveal':
        ok(res, await revealItem(body))
        return
      case '/settings':
        ok(res, await settingsEndpoint('POST', body))
        return
      case '/artifacts/roles':
        ok(res, await rolesEndpoint('POST', body))
        return
      case '/cloud/config':
        ok(res, await cloudCall('config', body))
        return
      case '/cloud/test':
        ok(res, await cloudCall('test', body))
        return
      case '/cloud/upload':
        ok(res, await cloudCall('upload', body))
        return
      case '/cloud/download':
        ok(res, await cloudCall('download', body))
        return
      case '/cloud/reconcile':
        ok(res, await cloudCall('reconcile', body))
        return
      case '/cloud/delete-remote':
        ok(res, await cloudCall('delete-remote', body))
        return
      case '/cloud/autosync':
        ok(res, await autoSyncEndpoint('POST', body))
        return
      case '/cloud/orphans':
        ok(res, await orphansEndpoint('POST', body))
        return
      default:
        throw new AppError('E_NOT_FOUND', `未知端点 ${action || '/'}`, 404)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        await handle(req, res)
      } catch (error) {
        if (!res.headersSent) fail(res, error)
        else {
          try { res.destroy() } catch { /* ignore */ }
        }
      }
    },
  }), 'dsh-plugin-artifacts: http')

  // -------------------------------------------------------------------------
  // 启动任务：首扫 + 回收站过期清理（§9.1：启动扫一次 + 每天一次）
  // -------------------------------------------------------------------------

  const boot = () => {
    try {
      const { indexer, trash, archive, settings } = ensureStores()
      settings.reload()
      archive.prune()
      if (!existsSync(join(root, 'sessions')) && !existsSync(join(root, 'artifacts'))) {
        console.warn(`[dsh-plugin-artifacts] 工作区 ${root} 下没有 sessions/ 与 artifacts/（来源 ${rootSource}），列表会是空的；可在 cordis.patch.yml 里用 config.workspaceRoot 指定`)
      }
      indexer.refresh({ maxFiles: 20000 })
        .then((result) => console.log(`[dsh-plugin-artifacts] 索引就绪：${result.total} 条（${root}，来源 ${rootSource}）`))
        .catch((error) => console.error('[dsh-plugin-artifacts] 首扫失败：', error?.message || String(error)))
      const sweep = () => {
        try {
          const result = trash.sweep()
          if (result.removed > 0) console.log(`[dsh-plugin-artifacts] 回收站清理 ${result.removed} 项（保留期 ${result.retention}）`)
        } catch (error) {
          console.error('[dsh-plugin-artifacts] 回收站清理失败：', error?.message || String(error))
        }
      }
      sweep()
      const timer = setInterval(sweep, 24 * 60 * 60 * 1000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    } catch (error) {
      console.error('[dsh-plugin-artifacts] 启动任务失败：', error?.message || String(error))
      return undefined
    }
  }

  if (typeof ctx.effect === 'function') {
    let stop
    try {
      ctx.effect(() => {
        stop = boot()
        return () => { if (typeof stop === 'function') stop() }
      }, 'dsh-plugin-artifacts: boot')
    } catch (error) {
      console.error('[dsh-plugin-artifacts] 注册启动任务失败：', error?.message || String(error))
      boot()
    }
  } else {
    boot()
  }

  console.log(`[dsh-plugin-artifacts] 就绪：${API_PREFIX}（工作区 ${root}，来源 ${rootSource}）`)
}

/** 给本地回归用的内部函数（不影响插件行为）。 */
export const __internals = { resolveWorkspaceRoot, workspaceFromStore, looksLikeHostHome }

