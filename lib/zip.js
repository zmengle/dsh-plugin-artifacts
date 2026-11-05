/**
 * 产物管理 · 最小 ZIP 写入器（零依赖）。
 *
 * 为什么自己写：插件在 profile 里加载时不保证能解析第三方包，`archiver` 那种依赖链一旦
 * 装不上，「打包归档」就整块不可用。ZIP 的「不压缩 + deflate」子集只用 `node:zlib` 就够，
 * 生成的文件 Windows 资源管理器 / macOS 归档工具 / `unzip` 都能直接打开。
 *
 * 只支持单个文件 < 4 GB、总量 < 4 GB（不写 ZIP64），超了就明确报 E_TOO_LARGE。
 */

import { closeSync, openSync, readFileSync, statSync, writeSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const FLAG_UTF8 = 0x0800
/** 单文件 / 总量上限（ZIP32 的字段是 32 位）。 */
const LIMIT = 3_900_000_000

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

/** DOS 时间：秒精度 2 秒一档，1980 年前夹到 1980。 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
  }
}

/** zip 内的路径统一用 `/`，并去掉开头的斜杠。 */
function normalizeEntryName(name) {
  return String(name).replace(/\\/g, '/').replace(/^\/+/, '')
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

/**
 * 把一组文件写成一个 zip。
 * @param {string} outPath 目标 zip 绝对路径
 * @param {Array<{ abs: string, name: string }>} entries
 * @returns {{ bytes: number, files: number, skipped: Array<{name:string,reason:string}> }}
 */
export function writeZip(outPath, entries) {
  const fd = openSync(outPath, 'w')
  const skipped = []
  const central = []
  let offset = 0
  let files = 0

  const write = (buffer) => {
    writeSync(fd, buffer, 0, buffer.length, offset)
    offset += buffer.length
  }

  try {
    for (const entry of entries) {
      const name = normalizeEntryName(entry.name)
      let raw
      let stat
      try {
        stat = statSync(entry.abs)
        if (!stat.isFile()) { skipped.push({ name, reason: 'E_NOT_FILE' }); continue }
        if (stat.size >= LIMIT) { skipped.push({ name, reason: 'E_TOO_LARGE' }); continue }
        raw = readFileSync(entry.abs)
      } catch {
        skipped.push({ name, reason: 'E_NOT_FOUND' })
        continue
      }

      const crc = crc32(raw)
      let method = 8
      let body = deflateRawSync(raw, { level: 6 })
      if (body.length >= raw.length) {
        method = 0
        body = raw
      }
      if (offset + body.length >= LIMIT) throw Object.assign(new Error('归档超过 4 GB，请分批归档'), { code: 'E_TOO_LARGE' })

      const nameBytes = Buffer.from(name, 'utf8')
      const { time, date } = dosDateTime(stat.mtime)

      const local = Buffer.alloc(30)
      local.writeUInt32LE(SIG_LOCAL, 0)
      local.writeUInt16LE(20, 4)          // version needed
      local.writeUInt16LE(FLAG_UTF8, 6)   // 文件名是 UTF-8
      local.writeUInt16LE(method, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(body.length, 18)
      local.writeUInt32LE(raw.length, 22)
      local.writeUInt16LE(nameBytes.length, 26)
      local.writeUInt16LE(0, 28)          // extra field 长度

      const headerOffset = offset
      write(local)
      write(nameBytes)
      write(body)

      const centralHeader = Buffer.alloc(46)
      centralHeader.writeUInt32LE(SIG_CENTRAL, 0)
      centralHeader.writeUInt16LE(20, 4)  // version made by
      centralHeader.writeUInt16LE(20, 6)  // version needed
      centralHeader.writeUInt16LE(FLAG_UTF8, 8)
      centralHeader.writeUInt16LE(method, 10)
      centralHeader.writeUInt16LE(time, 12)
      centralHeader.writeUInt16LE(date, 14)
      centralHeader.writeUInt32LE(crc, 16)
      centralHeader.writeUInt32LE(body.length, 20)
      centralHeader.writeUInt32LE(raw.length, 24)
      centralHeader.writeUInt16LE(nameBytes.length, 28)
      centralHeader.writeUInt16LE(0, 30)  // extra
      centralHeader.writeUInt16LE(0, 32)  // comment
      centralHeader.writeUInt16LE(0, 34)  // disk start
      centralHeader.writeUInt16LE(0, 36)  // internal attrs
      centralHeader.writeUInt32LE(0, 38)  // external attrs
      centralHeader.writeUInt32LE(headerOffset, 42)
      central.push({ header: centralHeader, nameBytes })
      files += 1
    }

    const centralStart = offset
    for (const entry of central) {
      write(entry.header)
      write(entry.nameBytes)
    }
    const centralSize = offset - centralStart

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(SIG_EOCD, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(files, 8)
    eocd.writeUInt16LE(files, 10)
    eocd.writeUInt32LE(centralSize, 12)
    eocd.writeUInt32LE(centralStart, 16)
    eocd.writeUInt16LE(0, 20)
    write(eocd)
  } finally {
    closeSync(fd)
  }

  return { bytes: offset, files, skipped }
}
