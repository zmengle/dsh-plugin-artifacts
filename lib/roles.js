/**
 * 产物管理 · 角色判定。
 *
 * 角色回答的是「这东西要不要留、要不要备份」，和「类型」（文件格式）正交：
 *   deliverable 产物   —— 用户要的交付物（默认视图 / 默认备份范围）
 *   scratch     过程   —— 测试脚本、截图、夹具、日志（噪声源）
 *   memory      记忆   —— MEMORY / PERSONA / HANDOFF
 *   asset       素材   —— 用户提供的输入（参考图、样例数据）
 *
 * 规则只负责「先摆好」，用户的手动标注（`.artifacts.json`）永远优先，见 lib/roles-file.js。
 * 判定必须是纯函数、可解释：同样的路径永远得到同样的角色。
 */

export const ROLE_LIST = ['deliverable', 'scratch', 'memory', 'asset']

export const ROLE_LABEL = {
  deliverable: '产物',
  scratch: '过程',
  memory: '记忆',
  asset: '素材',
}

/** 记忆文件命名族：MEMORY.md / MEMORY.archive.md / PERSONA.md / HANDOFF.md / memory-xxx.md */
const MEMORY_NAME = /^(MEMORY|PERSONA|HANDOFF)([._-]|$)/i
const MEMORY_DIR = /(^|\/)(memory|memories|记忆)(\/|$)/i

/** 过程目录：整段匹配（`harness-notes` 不算）。 */
const SCRATCH_DIRS = new Set([
  'screenshots', 'screenshot', 'shots', 'shot', 'harness', 'tests', 'test',
  'fixtures', 'fixture', 'tmp', 'temp', 'cache', 'node_modules', 'dist', 'build',
  'out', 'coverage', '__pycache__', 'venv', '.venv', '.cache', 'playwright-report',
])

/** 过程文件名前缀：probe-xxx.mjs / diag_1.mjs / verify-x.test.mjs */
const SCRATCH_NAME = /^(probe|diag|debug|check|test|verify|shoot|shot|closeup|narrow|arrange|fixture|grep|inspect|sweep|live)[-_.]/i

/** 这些前缀只对**代码类**文件生效：`live-notes.md` 是文档，`live-cloud.mjs` 才是过程脚本。 */
const SCRIPT_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.ps1', '.sh', '.bat', '.sql'])

/** 素材目录：用户放输入的常见命名。 */
const ASSET_DIRS = new Set(['uploads', 'upload', 'assets', 'asset', 'input', 'inputs', 'raw', '素材', '参考'])

/** 运行时垃圾：永远算过程，避免出现在任何"产物"里。 */
const RUNTIME_EXT = new Set(['.log', '.err', '.out', '.tmp', '.db', '.sqlite', '.sqlite3'])

const segmentsOf = (relPath) => String(relPath).replace(/\\/g, '/').split('/').filter(Boolean)

/**
 * 由「相对路径 + 文件名 + 扩展名」推角色。纯函数，不碰磁盘。
 * @param {{ path: string, name: string, ext: string }} input
 * @returns {'deliverable'|'scratch'|'memory'|'asset'}
 */
export function roleOf(input) {
  const rel = String(input?.path ?? '').replace(/\\/g, '/')
  const name = String(input?.name ?? '')
  const ext = String(input?.ext ?? '').toLowerCase()
  const parts = segmentsOf(rel)
  const dirs = parts.slice(0, -1)

  if (MEMORY_NAME.test(name) || MEMORY_DIR.test(dirs.join('/') + '/')) return 'memory'
  if (RUNTIME_EXT.has(ext)) return 'scratch'
  // 锁文件/依赖锁：属于过程（重装即可再生成）
  if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock)$/i.test(name)) return 'scratch'

  if (dirs.some((segment) => SCRATCH_DIRS.has(segment.toLowerCase()))) return 'scratch'
  if (SCRIPT_EXT.has(ext) && SCRATCH_NAME.test(name)) return 'scratch'

  if (dirs.some((segment) => ASSET_DIRS.has(segment.toLowerCase()))) return 'asset'

  return 'deliverable'
}

/** 角色是否被当前扫描开关收录。 */
export function roleEnabled(role, scan) {
  if (role === 'memory') return scan.memory === true
  if (role === 'scratch') return scan.session === true
  if (role === 'asset') return scan.deliverable === true || scan.session === true
  return scan.deliverable === true
}
