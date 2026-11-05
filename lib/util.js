/**
 * 产物管理 · 公共工具：类型分类、路径安全、标题推导、格式化。
 *
 * 这一层刻意不碰任何 IO（除了标题推导要读文件开头几 KB），
 * 因为「路径能不能用」和「条目标成什么类型」是两件最容易被测试覆盖的事。
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

// ---------------------------------------------------------------------------
// 类型（设计文档 §2.3）
// ---------------------------------------------------------------------------

/** 类型 → 扩展名。顺序即 UI 类型条顺序（`other` 永远在最后，藏在「更多」里）。 */
export const KIND_EXTENSIONS = {
  doc: ['.md', '.mdx', '.txt', '.pdf', '.docx', '.odt', '.rtf', '.epub'],
  sheet: ['.csv', '.tsv', '.xlsx', '.xls', '.ods'],
  slides: ['.pptx', '.ppt', '.odp', '.key'],
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.ico'],
  vector: ['.svg'],
  video: ['.mp4', '.webm', '.mov', '.m4v', '.mkv'],
  audio: ['.mp3', '.wav', '.m4a', '.ogg', '.flac'],
  code: [
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.ps1', '.sh', '.bat',
    '.sql', '.css', '.scss', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  ],
  config: ['.json', '.yaml', '.yml', '.toml', '.ini', '.env', '.xml', '.conf', '.properties'],
  web: ['.html', '.htm'],
  archive: ['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar'],
  other: [],
}

/** 类型条上的中文名。 */
export const KIND_LABEL = {
  doc: '文档',
  sheet: '表格',
  slides: '幻灯片',
  image: '图片',
  vector: '矢量',
  video: '视频',
  audio: '音频',
  code: '代码',
  config: '配置',
  web: '网页',
  archive: '压缩包',
  other: '其他',
}

/** 类型条展示的顺序；`other` 永远折叠进「更多」。 */
export const PRIMARY_KINDS = ['doc', 'sheet', 'slides', 'image', 'video', 'code', 'web']
export const SECONDARY_KINDS = ['vector', 'audio', 'config', 'archive', 'other']

const EXT_TO_KIND = new Map()
for (const [kind, exts] of Object.entries(KIND_EXTENSIONS)) {
  for (const ext of exts) EXT_TO_KIND.set(ext, kind)
}

/** 由扩展名推类型；未知扩展名一律 `other`（默认不显示）。 */
export function kindOf(ext) {
  return EXT_TO_KIND.get(String(ext || '').toLowerCase()) || 'other'
}

/** 运行时垃圾的扩展名 —— 归 other，默认隐藏（设计文档 §2.4 第 3 条）。 */
export const RUNTIME_EXTENSIONS = new Set([
  '.log', '.err', '.out', '.tmp', '.db', '.db-journal', '.sqlite', '.sqlite3', '.binarypb',
])

/** 扫描时整目录跳过的名字。 */
export const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.thumbs', '.mobile-profile', '.cache',
  '__pycache__', '.venv', 'venv', '.trash', '.archive', '.dsh-artifacts',
  'dist', 'build', 'out', 'coverage', '.next', '.nuxt', 'playwright-report',
])

/** 含这些文件的目录视为「独立项目」：扫描工作区时整段跳过，需单独加为工作区。 */
export const PROJECT_MARKERS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', '*.csproj']

/** 默认敏感文件模式（设计文档 §2.6 / §5）：不入列表、不可上传。 */
export const DEFAULT_SENSITIVE = ['.env*', '*.key', '*.pem', 'credentials*']

/** 单会话条目上限，超出截断并在 UI 提示（§2.4 第 4 条）。 */
export const MAX_ITEMS_PER_SESSION = 5000

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

/**
 * 把外部给来的相对路径收敛成 posix 相对路径。
 * 拒绝：绝对路径、盘符、`..` 段、空段、Windows 保留片段。
 * @returns {string|null} 合法时返回 `a/b/c`，否则 null
 */
export function normalizeRel(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim().replace(/\\/g, '/')
  if (raw === '') return null
  if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) return null
  const parts = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    if (segment.includes('\u0000')) return null
    parts.push(segment)
  }
  if (parts.length === 0) return null
  return parts.join('/')
}

/** Windows 上大小写不敏感，路径包含判断必须按同一口径。 */
const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)

/**
 * 把一个相对路径解析到 root 下，并确认没有逃逸。
 * @returns {string|null} 绝对路径，或 null（越界/非法）
 */
export function resolveInside(root, rel) {
  const normalized = normalizeRel(rel)
  if (normalized === null) return null
  const base = resolve(root)
  const target = resolve(base, normalized)
  const prefix = fold(base.endsWith(sep) ? base : base + sep)
  if (!fold(target).startsWith(prefix)) return null
  return target
}

/** 相对路径的父目录（posix），根下文件返回 ''。 */
export function dirnameRel(rel) {
  const index = rel.lastIndexOf('/')
  return index === -1 ? '' : rel.slice(0, index)
}

/** 相对路径的文件名。 */
export function basenameRel(rel) {
  const index = rel.lastIndexOf('/')
  return index === -1 ? rel : rel.slice(index + 1)
}

/** 扩展名（小写，含点）。 */
export function extOf(name) {
  const index = name.lastIndexOf('.')
  return index <= 0 ? '' : name.slice(index).toLowerCase()
}

/** 去掉扩展名的展示名。 */
export function stemOf(name) {
  const ext = extOf(name)
  return ext === '' ? name : name.slice(0, -ext.length)
}

// ---------------------------------------------------------------------------
// 敏感文件
// ---------------------------------------------------------------------------

/** 把 glob（只支持 `*` 与 `?`）编译成正则。 */
function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
}

/** 敏感文件判定器；patterns 来自设置，非法项忽略。 */
export function createSensitiveMatcher(patterns) {
  const list = (Array.isArray(patterns) ? patterns : DEFAULT_SENSITIVE)
    .filter((p) => typeof p === 'string' && p.trim() !== '')
  let regs = []
  try {
    regs = list.map(globToRegExp)
  } catch {
    regs = DEFAULT_SENSITIVE.map(globToRegExp)
  }
  return (name) => {
    const lower = String(name || '')
    if (lower.startsWith('.env')) return true
    return regs.some((re) => re.test(lower))
  }
}

// ---------------------------------------------------------------------------
// 标题推导（md 取首个 # 标题；html 取 <title>；否则文件名）
// ---------------------------------------------------------------------------

const HEAD_BYTES = 8192

/** 只读文件开头几 KB —— 大文件上推标题不能整文件读。 */
function readHead(absPath, bytes = HEAD_BYTES) {
  let fd
  try {
    fd = openSync(absPath, 'r')
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* 关不掉就算了 */ }
    }
  }
}

const stripComment = (line) => {
  const index = line.indexOf('<!--')
  return index === -1 ? line : line.slice(0, index)
}

/**
 * 推导条目标题。
 * @param {string} absPath 绝对路径
 * @param {string} name 文件名
 * @param {string} kind 类型
 */
export function titleOf(absPath, name, kind) {
  const fallback = stemOf(name)
  if (kind !== 'doc' && kind !== 'web') return fallback
  const ext = extOf(name)
  if (ext !== '.md' && ext !== '.html' && ext !== '.htm' && ext !== '.markdown') return fallback

  const head = readHead(absPath)
  if (head === '') return fallback

  if (ext === '.md' || ext === '.markdown') {
    for (const line of head.split(/\r?\n/)) {
      const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
      if (match !== null) {
        const title = match[1].replace(/[*_`~]/g, '').trim()
        if (title !== '') return clip(title, 120)
      }
    }
    return fallback
  }

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)
  if (titleMatch !== null) {
    const title = decodeEntities(stripComment(titleMatch[1])).replace(/\s+/g, ' ').trim()
    if (title !== '') return clip(title, 120)
  }
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(head)
  if (h1 !== null) {
    const title = decodeEntities(h1[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    if (title !== '') return clip(title, 120)
  }
  return fallback
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' }
function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

/** 截断字符串（按字符，不切半个代理对）。 */
export function clip(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return value.slice(0, Math.max(0, max - 1)) + '…'
}

/** 人能读的字节数。 */
export function humanBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return n + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return (value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')) + ' ' + units[unit]
}

/** 是否有扩展名（无扩展名的是运行时垃圾大户，直接归 other）。 */
export function hasExtension(name) {
  return extOf(name) !== ''
}

/** 目录名 → 人类可读的会话名：`2026-11-03-sticky-wall-plugin` → `sticky wall plugin`。 */
export function sessionNameFromDir(dirName) {
  const match = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(dirName)
  if (match !== null) return { date: match[1], slug: match[2] }
  return { date: '', slug: dirName }
}

/** 安全的文件名（rename / 新目录用）：不允许斜杠、控制字符、Windows 保留名。 */
export function isSafeFileName(name) {
  if (typeof name !== 'string') return false
  const value = name.trim()
  if (value === '' || value === '.' || value === '..') return false
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(value)) return false
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value)) return false
  if (value.endsWith('.') || value.endsWith(' ')) return false
  return value.length <= 180
}

/** 统计目录里文件总大小（跟随文件系统，跳过不可读项）。 */
export function directorySize(absDir) {
  let total = 0
  const stack = [absDir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) stack.push(child)
      else if (entry.isFile()) {
        try { total += statSync(child).size } catch { /* 跳过读不到的文件 */ }
      }
    }
  }
  return total
}
