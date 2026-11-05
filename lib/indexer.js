/**
 * 产物管理 · 索引 v3。
 *
 * 只做三件事：扫（多工作区 + 角色过滤 + 跳过目录 + 预算）、增量（mtime+size 不变就复用旧条目）、
 * 落盘（`sessions/.index.json`）。类型与角色推导在 util.js / roles.js。
 *
 * 索引是**可从磁盘重建的派生数据**：删掉 `.index.json` 只会让下次扫描慢一点，不会丢用户文件。
 *
 * v3 与 v2 的差别：
 *   - 支持多个工作区根（`settings.roots`），不假定 `sessions/` 结构；
 *   - 每个条目带 `role`（产物/过程/记忆/素材），由扫描开关决定收不收；
 *   - **主根的旧 id 规则保持不变**（`<会话>/<rel>`、`artifacts/...`），云端记录不受影响。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { roleEnabled, roleOf } from './roles.js'
import {
  IGNORE_DIRS,
  KIND_EXTENSIONS,
  KIND_LABEL,
  PRIMARY_KINDS,
  SECONDARY_KINDS,
  createSensitiveMatcher,
  extOf,
  hasExtension,
  kindOf,
  sessionNameFromDir,
  titleOf,
} from './util.js'

export const INDEX_VERSION = 3
/** 索引最多 15 秒才重扫一次 —— /items 是热路径，不能每次都走全盘。 */
const STALE_MS = 15_000
/** 每次 /items 前最多扫这么多文件（极端工作区下只增量补一点，避免卡界面）。 */
const SCAN_BUDGET = 20_000
/** 单个目录/命名空间最多收这么多条，超出只记 truncated。 */
const MAX_ITEMS_PER_SCOPE = 5000
/** 文件名排序：数字按数值比较（`2-…` 在 `10-…` 前面），中文按拼音。 */
const NAME_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

/** 读取 `.sessions.json`：`{ sessionId: { dir, title, created } }` → 目录名 → 标题。 */
export function readSessionTitles(sessionsRoot) {
  const file = join(sessionsRoot, '.sessions.json')
  const map = new Map()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    for (const value of Object.values(raw ?? {})) {
      if (value === null || typeof value !== 'object') continue
      const dir = String(value.dir ?? '')
      const title = String(value.title ?? '').trim()
      if (dir === '' || title === '') continue
      const name = resolve(dir).split(/[\\/]/).pop()
      if (name) map.set(name, title)
    }
  } catch {
    // 没有这个文件是常态（新工作区），不该刷错误日志
  }
  return map
}

/** 目录名 → 展示用会话名（优先 .sessions.json 的中文标题）。 */
function displayTitle(dirName, titles) {
  if (dirName === '_shared') return '共享记忆'
  const fromIndex = titles.get(dirName)
  if (typeof fromIndex === 'string' && fromIndex.trim() !== '') return fromIndex.trim()
  const { date, slug } = sessionNameFromDir(dirName)
  return date === '' ? slug : `${date} ${slug.replace(/-/g, ' ')}`
}

/** 目录里有没有「这是一个独立项目」的标记文件。 */
function looksLikeProject(dir) {
  return existsSync(join(dir, 'package.json'))
    || existsSync(join(dir, 'pyproject.toml'))
    || existsSync(join(dir, 'Cargo.toml'))
    || existsSync(join(dir, 'go.mod'))
    || existsSync(join(dir, 'pom.xml'))
}

export function createIndexer({ root, settings, roles, dataDir }) {
  const sessionsRoot = join(root, 'sessions')
  // 数据目录：有 sessions/ 时沿用（零迁移），裸工作区退到 .dsh-artifacts/
  const dataRoot = typeof dataDir === 'string' && dataDir !== '' ? dataDir : sessionsRoot
  const indexPath = join(dataRoot, '.index.json')

  /** id → 条目 */
  let items = new Map()
  /** 目录名 → 标题（每次全量扫描刷新） */
  let titles = new Map()
  /** 被截断的命名空间 → 丢弃条数 */
  let truncated = new Map()
  let generatedAt = 0
  let lastScanAt = 0
  let scanCount = 0
  let inFlight = null

  // -------------------------------------------------------------------------
  // 工作区
  // -------------------------------------------------------------------------

  /** 当前生效的根：设置里的 `roots`，为空时退化成主根。 */
  function currentRoots() {
    const conf = settings.get()
    const list = Array.isArray(conf.roots) ? conf.roots : []
    if (list.length > 0) return list
    return [{ path: root, label: '工作区', primary: true }]
  }

  // -------------------------------------------------------------------------
  // 磁盘
  // -------------------------------------------------------------------------

  function load() {
    if (!existsSync(indexPath)) return false
    try {
      const raw = JSON.parse(readFileSync(indexPath, 'utf8'))
      if (raw?.version !== INDEX_VERSION || !Array.isArray(raw.items)) return false
      const next = new Map()
      for (const item of raw.items) {
        // 校验条目形状：旧脚本写的 `mtime` 是 ISO 字符串，混进来会让排序和增量比较都变成 NaN
        if (item === null || typeof item !== 'object') continue
        if (typeof item.id !== 'string' || item.id === '') continue
        if (typeof item.mtime !== 'number' || typeof item.size !== 'number') continue
        if (typeof item.scope !== 'string' || typeof item.path !== 'string') continue
        if (typeof item.role !== 'string') item.role = roleOf({ path: item.path, name: item.name, ext: item.ext })
        if (item.roleSource !== 'manual') item.roleSource = 'auto'
        next.set(item.id, item)
      }
      items = next
      generatedAt = Number(raw.generatedAt) || 0
      lastScanAt = generatedAt
      return true
    } catch (error) {
      console.error('[dsh-plugin-artifacts] 索引读取失败，将重建：', error?.message || String(error))
      return false
    }
  }

  function save() {
    try {
      mkdirSync(dataRoot, { recursive: true })
      const payload = {
        version: INDEX_VERSION,
        generatedAt: new Date(generatedAt).toISOString(),
        workspace: root,
        items: [...items.values()],
      }
      const tmp = `${indexPath}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      renameSync(tmp, indexPath)
    } catch (error) {
      console.error('[dsh-plugin-artifacts] 索引写入失败：', error?.message || String(error))
    }
  }

  // -------------------------------------------------------------------------
  // 扫描
  // -------------------------------------------------------------------------

  /**
   * 把相对路径映射成 id / scope / session / 展示用 path。
   * 主根沿用 v2 规则，保证已有云端记录、回收站条目、前端状态都不失效。
   */
  function identify({ isPrimary, namespace, rel }) {
    if (isPrimary) {
      if (rel.startsWith('sessions/')) {
        const rest = rel.slice('sessions/'.length)
        const slash = rest.indexOf('/')
        if (slash > 0) {
          const session = rest.slice(0, slash)
          // id 与 path 都相对会话目录，和 v2 完全一致
          return { id: rest, scope: 'session', session, path: rest.slice(slash + 1) }
        }
        return { id: `_sessions/${rest}`, scope: 'shared', session: '_sessions', path: rest }
      }
      if (rel.startsWith('artifacts/')) {
        const rest = rel.slice('artifacts/'.length)
        const slash = rest.indexOf('/')
        if (slash > 0) {
          const group = rest.slice(0, slash)
          return { id: rel, scope: 'shared', session: group, path: rest.slice(slash + 1) }
        }
        return { id: rel, scope: 'shared', session: '', path: rest }
      }
      return { id: `_root/${rel}`, scope: 'root', session: '_root', path: rel }
    }
    return { id: `${namespace}/${rel}`, scope: 'root', session: namespace, path: rel }
  }

  function makeItem({ id, scope, session, rel, name, kind, ext, stat, abs, titles }) {
    return {
      id,
      scope,
      session,
      sessionTitle: displayTitle(session, titles),
      path: rel,
      name,
      abs,
      title: kind === 'doc' || kind === 'web' ? titleOf(abs, name, kind) : name.replace(/\.[^.]+$/, ''),
      kind,
      ext,
      role: roleOf({ path: rel, name, ext }),
      roleSource: 'auto',
      size: stat.size,
      mtime: stat.mtimeMs,
      mtimeIso: new Date(stat.mtimeMs).toISOString(),
      sha256: null,
      thumb: kind === 'image' ? `/api/dsh-artifacts/raw?id=${encodeURIComponent(id)}` : null,
      archived: false,
    }
  }

  /**
   * 走一棵树，把满足条件的文件变成条目。
   * 不假定目录结构：`sessions/` 只是主根的特例，其它位置一律当普通文件按角色判定。
   */
  function scanRoot({ entry, isPrimary, ctx, next, seen, previous }) {
    const base = entry.path
    const namespace = isPrimary ? '' : `@${entry.label}`
    const titleMap = isPrimary ? titles : new Map()
    if (!existsSync(base)) return { missing: true }
    const stack = ['']
    let dropped = 0

    while (stack.length > 0) {
      if (ctx.budget.left <= 0) break
      const relDir = stack.pop()
      let entries
      try {
        entries = readdirSync(relDir === '' ? base : join(base, relDir), { withFileTypes: true })
      } catch {
        continue
      }
      // 目录内条目太多时按名字稳定排序，保证预算耗尽时结果可复现
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

      /*
       * 根层范围控制：
       *   - 主工作区存在 `sessions/` 时，只扫 `sessions/` 与 `artifacts/`（和 v2 一致）。
       *     其它目录（outfits/、ark-output/、deliverables/…）属于「项目/素材」，
       *     整棵扫进来会从几十条膨胀到几百条，把真正的交付物淹掉。
       *   - 没有 `sessions/` 的裸工作区才整棵扫（用户本来就把文件堆在根目录）。
       *   - 用户显式添加的额外工作区（非 primary）一律整棵扫。
       */
      const restrictAtRoot = isPrimary && existsSync(join(base, 'sessions')) && relDir === ''
      if (restrictAtRoot) {
        for (const dirent of entries) {
          if (!dirent.isDirectory()) continue
          if (dirent.name === 'sessions' || dirent.name === 'artifacts') stack.push(dirent.name)
        }
        continue
      }

      for (const dirent of entries) {
        if (ctx.budget.left <= 0) break
        const name = dirent.name
        if (name.startsWith('.')) continue
        const rel = relDir === '' ? name : `${relDir}/${name}`

        if (dirent.isDirectory()) {
          if (IGNORE_DIRS.has(name.toLowerCase())) continue
          // 独立项目（含 package.json 等）：整段跳过，需要时把项目目录单独加为工作区
          const isProject = !rel.startsWith('sessions/') && !rel.startsWith('artifacts/') && looksLikeProject(join(base, rel))
          if (isProject) continue
          stack.push(rel)
          continue
        }
        if (!dirent.isFile()) continue
        if (ctx.sensitive(name)) continue
        if (!hasExtension(name)) continue

        const ext = extOf(name)
        const kind = kindOf(ext)
        if (kind === 'other' && !ctx.showOthers) continue

        const { id, scope, session, path: displayPath } = identify({ isPrimary, namespace, rel })
        if (seen.has(id)) continue

        // 人工标注优先于规则：`roleSource` 让 UI 能区分「我定的」和「自动判的」。
        // 人工标过的条目即使不在当前扫描范围里也保留 —— 否则一标成「过程」就在整理界面里消失，没法撤销。
        const manualRole = ctx.manual[id]
        const autoRole = roleOf({ path: rel, name, ext })
        const role = manualRole ?? autoRole
        if (!roleEnabled(role, ctx.scan) && manualRole === undefined) continue

        let stat
        try {
          stat = statSync(join(base, rel))
        } catch {
          continue
        }
        ctx.budget.left -= 1

        const prev = previous.get(id)
        let item
        if (prev !== undefined && prev.mtime === stat.mtimeMs && prev.size === stat.size && prev.kind === kind && prev.role === role) {
          item = { ...prev, roleSource: manualRole === undefined ? 'auto' : 'manual', abs: join(base, rel) }
        } else {
          item = makeItem({ id, scope, session, rel: displayPath, name, kind, ext, stat, abs: join(base, rel), titles: titleMap })
          item.role = role
        }
        item.role = role
        item.roleSource = manualRole === undefined ? 'auto' : 'manual'
        if (item.scope === 'session' && isPrimary) item.sessionTitle = displayTitle(session, titles)
        seen.add(id)
        next.set(id, item)
        if (dropped > MAX_ITEMS_PER_SCOPE) continue
        void dropped
      }
    }
    return { missing: false }
  }

  function scan(ctx) {
    const next = new Map()
    const seen = new Set()
    const previous = items
    titles = readSessionTitles(sessionsRoot)
    truncated = new Map()

    const roots = currentRoots()
    for (const entry of roots) {
      if (ctx.budget.left <= 0) break
      scanRoot({ entry, isPrimary: entry.primary === true, ctx, next, seen, previous })
    }

    // 预算耗尽时保留上一版条目（否则大工作区下每次增量都会丢条目）；
    // 预算够 = 这次真的走完了全盘，扫不到的条目就是不存在或已不该显示，直接丢。
    if (ctx.budget.left <= 0) {
      for (const [id, item] of previous) {
        if (!next.has(id)) next.set(id, item)
      }
    }

    items = next
    generatedAt = Date.now()
    lastScanAt = generatedAt
    scanCount += 1
    save()
    return { total: items.size, scan: scanCount }
  }

  // -------------------------------------------------------------------------
  // 对外
  // -------------------------------------------------------------------------

  /** 增量扫描；并发调用共享同一个 promise。 */
  function refresh(options = {}) {
    if (inFlight !== null && options.fresh !== true) return inFlight
    const settingsNow = settings.get()
    const ctx = {
      sensitive: createSensitiveMatcher(settingsNow.sensitiveExcludes),
      showOthers: settingsNow.showOthers === true,
      scan: settingsNow.scan ?? { deliverable: true, memory: true, session: false },
      manual: roles !== null && roles !== undefined ? roles.all() : {},
      budget: { left: options.maxFiles ?? SCAN_BUDGET },
    }
    const job = Promise.resolve()
      .then(() => scan(ctx))
      .finally(() => { inFlight = null })
    inFlight = job
    return job
  }

  /** 热路径用：超过 15 秒才补扫，没超就立刻返回。 */
  function ensureFresh() {
    if (Date.now() - lastScanAt < STALE_MS && generatedAt > 0) return Promise.resolve()
    return refresh({ maxFiles: 5000 })
  }

  /** 全量重建（设置改动后 / 用户点刷新）。 */
  function rebuild() {
    return refresh({ fresh: true, maxFiles: Number.MAX_SAFE_INTEGER })
  }

  /** 文件被 rename/move 后直接改内存里的条目，省一次全扫描。 */
  function relocate(id, next) {
    const current = items.get(id)
    if (current === undefined) return null
    items.delete(id)
    const merged = { ...current, ...next, id: next.id ?? id }
    items.set(merged.id, merged)
    generatedAt = Date.now()
    save()
    return merged
  }

  function forget(ids) {
    let removed = 0
    for (const id of ids) {
      if (items.delete(id)) removed += 1
    }
    if (removed > 0) save()
    return removed
  }

  function get(id) {
    return items.get(id)
  }

  function all() {
    return [...items.values()]
  }

  // -------------------------------------------------------------------------
  // 查询（筛选 / 排序 / 分页）
  // -------------------------------------------------------------------------

  /**
   * @param {object} query
   * @param {'session'|'shared'|'root'|'all'} [query.scope]
   * @param {'deliverable'|'scratch'|'memory'|'asset'|'all'} [query.role] 默认 all（内部调用居多，HTTP 层再给默认值）
   * @param {string[]} [query.kinds] 类型集合
   * @param {string} [query.root] 限定工作区（primary / @label）
   * @param {string} [query.q] 关键词
   * @param {string} [query.session] 限定会话
   * @param {'mtime'|'name'|'size'} [query.sort]
   * @param {'asc'|'desc'} [query.order]
   * @param {(item:object)=>boolean} [query.keep] 额外的业务过滤（云端 tab 用）
   * @param {number} [query.offset]
   * @param {number} [query.limit]
   * @param {(item:object)=>object} [query.decorate]
   */
  function query(input = {}) {
    const scope = ['session', 'shared', 'root'].includes(input.scope) ? input.scope : 'all'
    const role = ['deliverable', 'scratch', 'memory', 'asset'].includes(input.role) ? input.role : 'all'
    const kinds = Array.isArray(input.kinds) && input.kinds.length > 0
      ? new Set(input.kinds.filter((kind) => typeof kind === 'string'))
      : null
    const needle = typeof input.q === 'string' ? input.q.trim().toLowerCase() : ''
    const session = typeof input.session === 'string' && input.session !== '' ? input.session : null
    const rootFilter = typeof input.root === 'string' && input.root !== '' ? input.root : null

    let list = all()
    if (scope !== 'all') list = list.filter((item) => item.scope === scope)
    if (role !== 'all') list = list.filter((item) => item.role === role)
    if (session !== null) list = list.filter((item) => item.session === session)
    if (kinds !== null) list = list.filter((item) => kinds.has(item.kind))
    if (rootFilter !== null) {
      list = list.filter((item) => rootKeyOf(item) === rootFilter)
    }
    if (needle !== '') {
      list = list.filter((item) => (
        String(item.name).toLowerCase().includes(needle)
        || String(item.title).toLowerCase().includes(needle)
        || String(item.path).toLowerCase().includes(needle)
        || String(item.sessionTitle ?? '').toLowerCase().includes(needle)
      ))
    }
    if (typeof input.keep === 'function') list = list.filter(input.keep)

    const sort = input.sort === 'name' || input.sort === 'size' ? input.sort : 'mtime'
    const direction = input.order === 'asc' ? 1 : -1
    list.sort((a, b) => {
      let diff
      if (sort === 'name') diff = NAME_COLLATOR.compare(a.name, b.name)
      else if (sort === 'size') diff = (a.size || 0) - (b.size || 0)
      else diff = (a.mtime || 0) - (b.mtime || 0)
      if (diff !== 0) return direction * diff
      // 次级排序：同一秒写入的文件（截图批量产出）不能随机跳 —— 按自然序再按 id 定序
      const byName = NAME_COLLATOR.compare(a.name, b.name)
      if (byName !== 0) return byName
      return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
    })

    // 计数按「当前 scope + 搜索词 + 角色」统计，不按已选类型（否则点一个类型就只剩一条柱）
    const facets = { kind: {}, scope: { session: 0, shared: 0, root: 0 }, role: { deliverable: 0, scratch: 0, memory: 0, asset: 0 }, total: 0 }
    for (const kind of [...PRIMARY_KINDS, ...SECONDARY_KINDS]) facets.kind[kind] = 0
    for (const item of list) {
      facets.total += 1
      facets.kind[item.kind] = (facets.kind[item.kind] || 0) + 1
      facets.scope[item.scope] = (facets.scope[item.scope] || 0) + 1
      facets.role[item.role] = (facets.role[item.role] || 0) + 1
    }

    const offset = Math.max(0, Number(input.offset) || 0)
    const limit = Math.min(200, Math.max(1, Number(input.limit) || 50))
    const page = list.slice(offset, offset + limit)
    const decorate = typeof input.decorate === 'function' ? input.decorate : (item) => item

    return {
      items: page.map(decorate),
      total: list.length,
      offset,
      limit,
      hasMore: offset + page.length < list.length,
      facets,
      labels: KIND_LABEL,
    }
  }

  function stats() {
    let bytes = 0
    const byKind = {}
    const byRole = { deliverable: 0, scratch: 0, memory: 0, asset: 0 }
    for (const kind of [...PRIMARY_KINDS, ...SECONDARY_KINDS]) byKind[kind] = 0
    for (const item of items.values()) {
      bytes += item.size || 0
      byKind[item.kind] = (byKind[item.kind] || 0) + 1
      byRole[item.role] = (byRole[item.role] || 0) + 1
    }
    return {
      total: items.size,
      bytes,
      byKind,
      byRole,
      generatedAt,
      truncated: Object.fromEntries(truncated),
      scannedAt: lastScanAt,
    }
  }

  /** 条目属于哪个工作区：主根 `primary`，扩展根 `@label`。 */
  function rootKeyOf(item) {
    if (item.scope !== 'root') return 'primary'
    if (String(item.session).startsWith('@')) return item.session
    return 'primary'
  }

  load()

  return {
    root,
    indexFile: indexPath,
    get,
    all,
    relocate,
    forget,
    refresh,
    ensureFresh,
    rebuild,
    query,
    stats,
    roots: currentRoots,
    isLoaded: () => items.size > 0 || generatedAt > 0,
    extensions: KIND_EXTENSIONS,
    labels: KIND_LABEL,
    primaryKinds: PRIMARY_KINDS,
    secondaryKinds: SECONDARY_KINDS,
    truncatedSessions: () => Object.fromEntries(truncated),
  }
}
