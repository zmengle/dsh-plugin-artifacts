/**
 * 产物管理 · 归档（设计文档 §9.2）。
 *
 * 归档 = 生成 `archive/<year>/<name>-<timestamp>.zip`，**原目录保留**，只记一个「归档时间点」。
 * 条目是否显示「已归档」由比较决定：`item.mtime <= record.at` 才算 —— 目录里又有新写入时
 * mtime 会超过归档时间点，角标自动消失，不用手工撤销。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { writeZip } from './zip.js'

const RECORD_VERSION = 1

/** 归档记录文件放在 sessions/ 下，和索引、设置作伴。 */
export function createArchive({ root, dataDir }) {
  const dataRoot = typeof dataDir === 'string' && dataDir !== '' ? dataDir : join(root, 'sessions')
  const archiveRoot = join(root, 'archive')
  const recordPath = join(dataRoot, '.archive.json')

  /** @type {Record<string, {at:number, zip:string, count:number, bytes:number}>} */
  let records = {}

  function load() {
    if (!existsSync(recordPath)) {
      records = {}
      return
    }
    try {
      const raw = JSON.parse(readFileSync(recordPath, 'utf8'))
      records = raw?.version === RECORD_VERSION && raw.items !== null && typeof raw.items === 'object' ? raw.items : {}
    } catch {
      records = {}
    }
  }

  function save() {
    try {
      mkdirSync(dirname(recordPath), { recursive: true })
      const tmp = `${recordPath}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: RECORD_VERSION, items: records }, null, 2), 'utf8')
      renameSync(tmp, recordPath)
    } catch (error) {
      console.error('[dsh-plugin-artifacts] 归档记录写入失败：', error?.message || String(error))
    }
  }

  /** 归档键：会话目录名 / `artifacts/<name>`。 */
  const keyOf = (item) => (item.scope === 'shared' ? `artifacts/${item.session}` : item.session)

  const isArchived = (item) => {
    const record = records[keyOf(item)]
    if (record === undefined) return false
    if ((Number(item.mtime) || 0) > (Number(record.at) || 0)) return false
    // 只归档了部分条目时记 ids：没被归档的同会话文件不该显示角标
    if (Array.isArray(record.ids)) return record.ids.includes(item.id)
    return true
  }

  function safeName(value) {
    return String(value || 'archive')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'archive'
  }

  /** 本地时间戳：`20261104-081530`，排序友好。 */
  function stamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0')
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  }

  /**
   * 把一组条目打成一个 zip。
   * @param {object} spec
   * @param {Array<object>} spec.items 索引条目（同属一个 sessionKey）
   * @param {string} spec.key 归档键
   * @param {string} spec.label 文件名里的可读名字
   * @param {boolean} [spec.subset] 只归档了其中部分条目（记 ids，角标只打这些）
   */
  function create({ items, key, label, subset }) {
    const usable = items.filter((item) => typeof item.abs === 'string' && existsSync(item.abs))
    if (usable.length === 0) {
      throw Object.assign(new Error('没有可归档的文件'), { code: 'E_NOT_FOUND' })
    }

    const now = new Date()
    const year = String(now.getFullYear())
    const dir = join(archiveRoot, year)
    mkdirSync(dir, { recursive: true })

    // 同一秒内归档同一会话两次会撞名 —— 加序号，别把上一个 zip 覆盖掉
    const base = `${safeName(label)}-${stamp(now)}`
    let zipName = `${base}.zip`
    let attempt = 2
    while (existsSync(join(dir, zipName))) {
      zipName = `${base}-${attempt}.zip`
      attempt += 1
    }
    const outPath = join(dir, zipName)

    const entries = usable.map((item) => ({
      abs: item.abs,
      // zip 内保留「会话/相对路径」的结构，解开就是原来的目录
      name: item.scope === 'shared'
        ? (item.session === '' ? item.path : `artifacts/${item.session}/${item.path}`)
        : `${item.session}/${item.path}`,
    }))

    const result = writeZip(outPath, entries)
    const bytes = statSync(outPath).size
    records[key] = {
      at: now.getTime(),
      zip: `archive/${year}/${zipName}`,
      count: result.files,
      bytes,
      skipped: result.skipped.length,
      ids: subset === true ? usable.map((item) => item.id) : undefined,
    }
    save()

    return {
      zip: records[key].zip,
      abs: outPath,
      files: result.files,
      bytes,
      skipped: result.skipped,
    }
  }

  /** 记录里指向的 zip 已经被人删了 —— 清掉记录，否则角标永远挂着。 */
  function prune() {
    let changed = false
    for (const [key, record] of Object.entries(records)) {
      const abs = join(root, record.zip)
      if (!existsSync(abs)) {
        delete records[key]
        changed = true
      }
    }
    if (changed) save()
    return changed
  }

  function list() {
    return Object.entries(records)
      .map(([key, record]) => ({ key, ...record }))
      .sort((a, b) => (b.at || 0) - (a.at || 0))
  }

  load()

  return { create, isArchived, list, prune, keyOf, recordPath }
}
