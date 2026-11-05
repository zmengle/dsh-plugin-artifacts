/**
 * 产物管理 · 云端（COS）—— 设计文档 §2.5 / §6。
 *
 * 三层责任分清：
 *   1. `.cloud.json`：**只有** provider / bucket / region / prefix / allowRemoteDelete 和映射表，
 *      永远不存密钥。
 *   2. credentials：secretId / secretKey 落在 DSH 的凭据服务里（`ctx.credentials`），
 *      这个文件只记引用名。
 *   3. `cos.js`：懒加载。它加载失败（用户没装/文件损坏）只影响云端功能，
 *      本地列表、预览、删除、归档一律照常 —— §6.4 的「未配置也不影响本地」。
 *
 * 上传一律手动触发，没有定时器、没有后台同步（§6.1）。
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { dirname, join, basename } from 'node:path'

const CLOUD_VERSION = 1
export const SECRET_ID_REF = 'DSH_ARTIFACTS_COS_SECRET_ID'
export const SECRET_KEY_REF = 'DSH_ARTIFACTS_COS_SECRET_KEY'
/** ≥ 20 MB 用分片；内置客户端用单次 PUT，这里只用来给 UI 提示预计耗时。 */
const BIG_FILE = 20 * 1024 * 1024

const emptyConfig = () => ({
  provider: 'cos',
  enabled: false,
  // downloadDir：用户选过的默认落地目录；为空表示每次下载都问
  config: { bucket: '', region: '', prefix: 'dsh/', allowRemoteDelete: false, downloadDir: '' },
  items: {},
  paths: {},
})

/** 只保留 4 位尾号用于回显。 */
function tailOf(value, keep = 4) {
  const text = String(value || '')
  if (text.length <= keep * 2) return text === '' ? '' : '*'.repeat(text.length)
  return `${text.slice(0, 2)}${'*'.repeat(Math.max(4, text.length - keep - 2))}${text.slice(-keep)}`
}

export function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(absPath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export function createCloud({ root, getCredentials, dataDir }) {
  // 数据目录：有 sessions/ 时沿用，裸工作区退到 .dsh-artifacts/
  const dataRoot = typeof dataDir === 'string' && dataDir !== '' ? dataDir : join(root, 'sessions')
  const cloudPath = join(dataRoot, '.cloud.json')

  let store = emptyConfig()
  /** 懒加载的 cos.js；undefined = 还没试过，null = 加载失败 */
  let cosModule
  let cosClient = null
  let cosClientKey = ''

  function load() {
    if (!existsSync(cloudPath)) {
      store = emptyConfig()
      return
    }
    try {
      const raw = JSON.parse(readFileSync(cloudPath, 'utf8'))
      const base = emptyConfig()
      store = {
        ...base,
        ...raw,
        config: { ...base.config, ...(raw?.config ?? {}) },
        items: raw?.items !== null && typeof raw?.items === 'object' ? raw.items : {},
        paths: raw?.paths !== null && typeof raw?.paths === 'object' ? raw.paths : {},
      }
    } catch (error) {
      console.error('[dsh-plugin-artifacts] .cloud.json 读取失败：', error?.message || String(error))
      store = emptyConfig()
    }
  }

  function save() {
    try {
      mkdirSync(dirname(cloudPath), { recursive: true })
      const tmp = `${cloudPath}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
      renameSync(tmp, cloudPath)
    } catch (error) {
      console.error('[dsh-plugin-artifacts] .cloud.json 写入失败：', error?.message || String(error))
    }
  }

  // -------------------------------------------------------------------------
  // 密钥（只走 credentials）
  // -------------------------------------------------------------------------

  async function readSecrets() {
    const service = getCredentials()
    if (service === undefined || service === null) return { secretId: '', secretKey: '', writable: false }
    const [idInfo, keyInfo] = await Promise.all([
      service.describe?.(SECRET_ID_REF).catch(() => undefined),
      service.describe?.(SECRET_KEY_REF).catch(() => undefined),
    ])
    const [idValue, keyValue] = await Promise.all([
      service.resolve?.(SECRET_ID_REF).catch(() => undefined),
      service.resolve?.(SECRET_KEY_REF).catch(() => undefined),
    ])
    return {
      secretId: idValue?.value ?? '',
      secretKey: keyValue?.value ?? '',
      writable: Boolean(idInfo?.writable || keyInfo?.writable),
    }
  }

  async function writeSecrets(secretId, secretKey) {
    const service = getCredentials()
    if (service === undefined || service === null) {
      throw Object.assign(new Error('当前宿主没有凭据服务，无法安全保存密钥'), { code: 'E_CLOUD_AUTH' })
    }
    try {
      if (typeof secretId === 'string' && secretId.trim() !== '') await service.set(SECRET_ID_REF, secretId.trim())
      if (typeof secretKey === 'string' && secretKey.trim() !== '') await service.set(SECRET_KEY_REF, secretKey.trim())
    } catch (error) {
      throw Object.assign(new Error('保存密钥失败：' + (error?.message || String(error))), { code: 'E_CLOUD_AUTH' })
    }
  }

  // -------------------------------------------------------------------------
  // 客户端
  // -------------------------------------------------------------------------

  async function requireClient() {
    if (store.enabled !== true) {
      throw Object.assign(new Error('云端未启用'), { code: 'E_CLOUD_DISABLED' })
    }
    const { bucket, region, prefix } = store.config
    if (!bucket || !region) throw Object.assign(new Error('云端配置不完整'), { code: 'E_CLOUD_DISABLED' })

    const secrets = await readSecrets()
    if (secrets.secretId === '' || secrets.secretKey === '') {
      throw Object.assign(new Error('缺少 COS 密钥，请先在云端配置里填写'), { code: 'E_CLOUD_AUTH' })
    }

    const key = [secrets.secretId, secrets.secretKey, bucket, region, prefix].join('|')
    if (cosClient !== null && cosClientKey === key) return cosClient

    if (cosModule === undefined) {
      try {
        cosModule = await import('./cos.js')
      } catch (error) {
        cosModule = null
        console.error('[dsh-plugin-artifacts] cos.js 加载失败：', error?.message || String(error))
      }
    }
    if (cosModule === null || typeof cosModule.createCosClient !== 'function') {
      throw Object.assign(new Error('COS 客户端不可用（lib/cos.js 未就绪）'), { code: 'E_CLOUD_DISABLED' })
    }

    cosClient = cosModule.createCosClient({
      secretId: secrets.secretId,
      secretKey: secrets.secretKey,
      bucket,
      region,
      prefix,
    })
    cosClientKey = key
    return cosClient
  }

  // -------------------------------------------------------------------------
  // 配置
  // -------------------------------------------------------------------------

  async function publicConfig() {
    const secrets = await readSecrets()
    return {
      provider: 'cos',
      enabled: store.enabled === true,
      bucket: store.config.bucket ?? '',
      region: store.config.region ?? '',
      prefix: store.config.prefix || 'dsh/',
      allowRemoteDelete: store.config.allowRemoteDelete === true,
      downloadDir: store.config.downloadDir || '',
      secretIdTail: tailOf(secrets.secretId),
      secretKeyTail: tailOf(secrets.secretKey),
      hasSecretId: secrets.secretId !== '',
      hasSecretKey: secrets.secretKey !== '',
      writableSecrets: secrets.writable,
      cloudFile: 'sessions/.cloud.json',
      uploadedCount: Object.keys(store.paths).length,
    }
  }

  /** 保存配置；密钥只进 credentials，`.cloud.json` 里不出现。 */
  async function saveConfig(patch = {}) {
    const next = {
      bucket: typeof patch.bucket === 'string' ? patch.bucket.trim() : store.config.bucket,
      region: typeof patch.region === 'string' ? patch.region.trim() : store.config.region,
      prefix: typeof patch.prefix === 'string' ? patch.prefix.trim() : store.config.prefix,
      allowRemoteDelete: typeof patch.allowRemoteDelete === 'boolean' ? patch.allowRemoteDelete : store.config.allowRemoteDelete,
      downloadDir: typeof patch.downloadDir === 'string' ? patch.downloadDir.trim() : (store.config.downloadDir || ''),
    }
    if (next.prefix !== '' && !next.prefix.endsWith('/')) next.prefix += '/'
    if (next.bucket !== '' && !/^[a-z0-9][a-z0-9-]*-\d+$/i.test(next.bucket)) {
      throw Object.assign(new Error('Bucket 应形如 `name-1250000000`'), { code: 'E_INVALID' })
    }
    if (next.region !== '' && !/^ap-[a-z]+$|^[a-z]+-[a-z]+$/i.test(next.region)) {
      throw Object.assign(new Error('Region 应形如 `ap-guangzhou`'), { code: 'E_INVALID' })
    }
    // 默认下载目录：留空 = 每次下载都问；给了就必须是个存在的绝对路径
    if (next.downloadDir !== '') {
      let stat
      try {
        stat = statSync(next.downloadDir)
      } catch {
        throw Object.assign(new Error('默认下载目录不存在：' + next.downloadDir), { code: 'E_INVALID' })
      }
      if (!stat.isDirectory() || !isAbsolute(next.downloadDir)) {
        throw Object.assign(new Error('默认下载目录必须是绝对路径的目录'), { code: 'E_INVALID' })
      }
    }

    if (typeof patch.secretId === 'string' && patch.secretId.trim() !== '') {
      await writeSecrets(patch.secretId, undefined)
    }
    if (typeof patch.secretKey === 'string' && patch.secretKey.trim() !== '') {
      await writeSecrets(undefined, patch.secretKey)
    }
    if (patch.clearSecretId === true || patch.clearSecretKey === true) {
      const service = getCredentials()
      try {
        if (patch.clearSecretId === true) await service?.unset?.(SECRET_ID_REF)
        if (patch.clearSecretKey === true) await service?.unset?.(SECRET_KEY_REF)
      } catch { /* 清不掉的密钥不影响其它配置保存 */ }
    }

    store.config = next
    if (typeof patch.enabled === 'boolean') {
      if (patch.enabled) {
        const secrets = await readSecrets()
        if (next.bucket === '' || next.region === '' || secrets.secretId === '' || secrets.secretKey === '') {
          throw Object.assign(new Error('启用前请先填好 Bucket、Region、SecretId、SecretKey'), { code: 'E_INVALID' })
        }
      }
      store.enabled = patch.enabled
    }
    save()
    return publicConfig()
  }

  // -------------------------------------------------------------------------
  // 映射与状态
  // -------------------------------------------------------------------------

  const shaKey = (sha) => `sha256:${sha}`

  /** key 第一次上传时确定并写进 `.cloud.json`，之后改目录名也不重算（§12 第 2 条）。 */
  function keyFor(item) {
    const existing = store.paths[item.id]
    if (existing !== undefined && typeof existing.key === 'string' && existing.key !== '') return existing.key

    // v2：固定前缀只留「版本 + 会话」两段，对象树和本地目录一一对应，能直接看出是哪个会话的哪个文件。
    // （v1 是 `v1/sessions/<8hex>-<目录>/<rel>`：多两段、还把目录名和 id 各写一遍，太啰嗦。）
    const prefix = store.config.prefix || 'dsh/'
    if (item.scope === 'shared') {
      const base = item.session === '' ? `${prefix}v2/_shared` : `${prefix}v2/_shared/${item.session}`
      return `${base}/${item.path}`
    }
    return `${prefix}v2/${item.session}/${item.path}`
  }

  /** 已记录的远端 key（没有就返回 undefined，不生成新的）。 */
  function recordedKeyOf(item) {
    const record = store.paths[item.id]
    return record !== undefined && typeof record.key === 'string' && record.key !== '' ? record.key : undefined
  }

  /**
   * 列表用状态：只看本地记录与文件指纹，不做哈希、不联网。
   * 冲突 = 上传之后本地文件变了：大小变了，或 mtime 变了（同尺寸的编辑也能抓到）。
   */
  function stateOf(item, cachedSha) {
    if (store.enabled !== true) return 'disabled'
    const record = store.paths[item.id]
    if (record === undefined) return 'local-only'
    if (Number(record.size) !== Number(item.size)) return 'conflict'
    if (record.mtime !== undefined && record.mtime !== null && Number(record.mtime) !== Number(item.mtime)) return 'conflict'
    if (cachedSha !== undefined && cachedSha !== null && record.sha256 !== cachedSha) return 'conflict'
    return 'synced'
  }

  // -------------------------------------------------------------------------
  // 操作
  // -------------------------------------------------------------------------

  async function test() {
    const client = await requireClient()
    const started = Date.now()
    const result = await client.test()
    return { ...result, elapsedMs: Date.now() - started }
  }

  async function upload(item) {
    const client = await requireClient()
    const stat = statSync(item.abs)
    if (stat.size > 2 * 1024 * 1024 * 1024) {
      throw Object.assign(new Error('单个文件超过 2 GB，不支持上传'), { code: 'E_TOO_LARGE' })
    }
    const sha256 = item.sha256 ?? await sha256File(item.abs)
    const record = store.items[shaKey(sha256)]
    const key = record?.key ?? keyFor(item)

    const body = readFileSync(item.abs)
    const result = await client.put(key, body, { sha256 })
    const head = await client.head(key)
    if (head === null || Number(head.size) !== body.length) {
      throw Object.assign(new Error('上传后校验失败（远端大小不一致）'), { code: 'E_CLOUD_FAILED' })
    }

    store.items[shaKey(sha256)] = {
      key,
      etag: result.etag || head.etag || '',
      size: body.length,
      uploadedAt: new Date().toISOString(),
    }
    store.paths[item.id] = {
      sha256,
      key,
      size: body.length,
      mtime: item.mtime,
      uploadedAt: new Date().toISOString(),
    }
    save()
    return { key, bytes: body.length, sha256, state: 'synced' }
  }

  /** 同名文件已存在时加序号（`报告 (2).pdf`），不覆盖。 */
  function uniquePath(target) {
    if (!existsSync(target)) return target
    const index = target.lastIndexOf('.')
    const slash = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
    const hasExt = index > slash + 1
    const stem = hasExt ? target.slice(0, index) : target
    const ext = hasExt ? target.slice(index) : ''
    for (let n = 2; n < 1000; n++) {
      const candidate = `${stem} (${n})${ext}`
      if (!existsSync(candidate)) return candidate
    }
    throw Object.assign(new Error('目标目录里同名文件太多'), { code: 'E_CONFLICT' })
  }

  async function download(item) {
    const client = await requireClient()
    const record = store.paths[item.id]
    if (record === undefined) throw Object.assign(new Error('这个条目还没有上传过'), { code: 'E_NOT_FOUND' })
    const body = await client.get(record.key)

    // 落地位置优先级：本次指定的目录 → 配置里的默认下载目录 → 原文件旁边
    const dir = typeof item.targetDir === 'string' && item.targetDir !== ''
      ? item.targetDir
      : (store.config.downloadDir || '')
    let target
    if (dir !== '') {
      target = uniquePath(join(dir, basename(item.abs)))
    } else {
      target = item.abs
      if (existsSync(target)) target = target + `.remote.${Date.now()}`
    }
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, body)
    renameSync(tmp, target)
    return { path: target, bytes: body.length }
  }

  async function removeRemote(item) {
    if (store.config.allowRemoteDelete !== true) {
      throw Object.assign(new Error('远端删除默认关闭，请先在云端配置里打开'), { code: 'E_FORBIDDEN' })
    }
    const client = await requireClient()
    const record = store.paths[item.id]
    if (record === undefined) throw Object.assign(new Error('没有远端副本'), { code: 'E_NOT_FOUND' })
    await client.remove(record.key)
    delete store.paths[item.id]
    save()
    return { key: record.key }
  }

  /**
   * 对账：列出远端 `prefix` 下的所有对象，和本地映射表比。
   * （不要写死某个版本目录 —— key 前缀会随版本变，按记录里的 key 比对才准。）
   */
  async function reconcile(items) {
    const client = await requireClient()
    const prefix = store.config.prefix || 'dsh/'
    const remote = new Map()
    let marker
    let pages = 0
    do {
      const page = await client.list(prefix, marker)
      for (const entry of page.keys) remote.set(entry.key, entry)
      marker = page.nextMarker
      pages += 1
    } while (marker !== undefined && marker !== '' && pages < 50)

    const byKey = new Map()
    for (const item of items) byKey.set(store.paths[item.id]?.key ?? keyFor(item), item)

    const synced = []
    const localOnly = []
    const conflicts = []
    for (const item of items) {
      const record = store.paths[item.id]
      if (record === undefined) { localOnly.push(item.id); continue }
      const entry = remote.get(record.key)
      if (entry === undefined) { localOnly.push(item.id); continue }
      if (Number(entry.size) !== Number(record.size)) { conflicts.push({ id: item.id, code: 'E_CONFLICT' }); continue }
      synced.push(item.id)
      remote.delete(record.key)
    }

    const remoteOnly = [...remote.values()].map((entry) => ({ key: entry.key, size: entry.size, lastModified: entry.lastModified }))
    return {
      counts: { synced: synced.length, localOnly: localOnly.length, conflicts: conflicts.length, remoteOnly: remoteOnly.length },
      localOnly: localOnly.slice(0, 200),
      conflicts: conflicts.slice(0, 200),
      remoteOnly: remoteOnly.slice(0, 200),
      pages,
    }
  }

  /** 记录里有、但当前索引里可能看不到的条目 id（用于把数字和列表对齐）。 */
  function recordedIds() {
    return Object.keys(store.paths)
  }

  function status() {
    return {
      provider: 'cos',
      enabled: store.enabled === true,
      bucket: store.config.bucket || '',
      region: store.config.region || '',
      prefix: store.config.prefix || 'dsh/',
      uploaded: Object.keys(store.paths).length,
      bigFileHint: BIG_FILE,
    }
  }

  load()

  return {
    file: cloudPath,
    status,
    recordedIds,
    stateOf,
    keyFor,
    recordedKeyOf,
    publicConfig,
    saveConfig,
    test,
    upload,
    download,
    removeRemote,
    reconcile,
    reload: load,
    forget: (id) => {
      if (store.paths[id] !== undefined) {
        delete store.paths[id]
        save()
      }
    },
  }
}

