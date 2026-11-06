/**
 * 离线冒烟：不依赖 DSH、不依赖浏览器，直接测最容易出错的纯逻辑。
 *   npm test        （等价于 node test/smoke.mjs）
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCloud } from '../lib/cloud.js'
import { createIndexer } from '../lib/indexer.js'
import { createRolesStore } from '../lib/roles-file.js'
import { ROLE_LIST, roleOf } from '../lib/roles.js'
import { normalizeSettings, normalizeRoots } from '../lib/settings.js'
import { createSettingsStore } from '../lib/settings.js'
import { KIND_EXTENSIONS, kindOf, normalizeRel, resolveInside } from '../lib/util.js'
import { writeZip } from '../lib/zip.js'

const checks = []
const pending = []
function check(name, fn) {
  pending.push((async () => {
    try {
      await fn()
      checks.push({ name, ok: true })
    } catch (error) {
      checks.push({ name, ok: false, error: String(error?.message || error) })
    }
  })())
}

// ---------------------------------------------------------------- 类型
check('kindOf：12 类映射', () => {
  assert.equal(kindOf('.json'), 'config')
  assert.equal(kindOf('.svg'), 'vector')
  assert.equal(kindOf('.html'), 'web')
  assert.equal(kindOf('.mp3'), 'audio')
  assert.equal(kindOf('.md'), 'doc')
  assert.equal(kindOf('.mjs'), 'code')
  assert.equal(kindOf('.zip'), 'archive')
  assert.equal(kindOf('.unknown-ext'), 'other')
  assert.equal(new Set(Object.values(KIND_EXTENSIONS).flat()).size, Object.values(KIND_EXTENSIONS).flat().length, '一个扩展名只能属于一个类型')
})

// ---------------------------------------------------------------- 角色
check('roleOf：记忆 / 过程 / 素材 / 产物', () => {
  assert.equal(roleOf({ path: 's/MEMORY.md', name: 'MEMORY.md', ext: '.md' }), 'memory')
  assert.equal(roleOf({ path: 's/harness/drive.mjs', name: 'drive.mjs', ext: '.mjs' }), 'scratch')
  assert.equal(roleOf({ path: 's/probe-x.mjs', name: 'probe-x.mjs', ext: '.mjs' }), 'scratch')
  assert.equal(roleOf({ path: 's/live-notes.md', name: 'live-notes.md', ext: '.md' }), 'deliverable', '前缀只对代码类生效')
  assert.equal(roleOf({ path: 's/uploads/a.png', name: 'a.png', ext: '.png' }), 'asset')
  assert.equal(roleOf({ path: 's/报告.md', name: '报告.md', ext: '.md' }), 'deliverable')
})

// ---------------------------------------------------------------- 设置
check('normalizeRoots：去重 / 去嵌套 / 单一 primary / 上限', () => {
  const roots = normalizeRoots([
    { path: 'C:\\a', primary: true },
    { path: 'C:\\a' },
    { path: 'C:\\a\\b' },
    { path: 'C:\\c', label: 'a' },
    'relative/path',
  ])
  assert.equal(roots.length, 2, '去重 + 去掉被包含的 + 丢弃相对路径')
  assert.equal(roots.filter((root) => root.primary).length, 1)
  assert.equal(new Set(roots.map((root) => root.label)).size, roots.length, 'label 必须唯一')
})

check('normalizeSettings：v1 → v2 默认值', () => {
  const conf = normalizeSettings({ trashRetention: '7', showOthers: true }, { defaultRoot: 'C:\\w' })
  assert.equal(conf.trashRetention, '7')
  assert.equal(conf.showOthers, true)
  assert.equal(conf.roots.length, 1)
  assert.equal(conf.roots[0].path, 'C:\\w')
  assert.equal(conf.scan.deliverable, true)
  assert.equal(conf.scan.session, false)
  assert.equal(conf.backup.scope, 'deliverable')
  assert.equal(conf.autoSync.enabled, false)
})

check('settings 迁移不落盘，保存后才写 version 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-artifacts-'))
  try {
    const file = join(dir, '.settings.json')
    writeFileSync(file, JSON.stringify({ trashRetention: '7' }), 'utf8')
    const before = readFileSync(file, 'utf8')
    const store = createSettingsStore(file, { defaultRoot: dir })
    assert.equal(store.migratedFromV1(), true)
    assert.equal(readFileSync(file, 'utf8'), before, '只读不该改文件')
    store.set({ trashRetention: '30' })
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.version, 2)
    assert.equal(store.migratedFromV1(), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 路径安全
check('normalizeRel / resolveInside 挡住穿越', () => {
  assert.equal(normalizeRel('../x'), null)
  assert.equal(normalizeRel('a/../../b'), null)
  assert.equal(normalizeRel('C:\\x'), null)
  assert.equal(normalizeRel('a/b'), 'a/b')
  assert.equal(resolveInside('C:\\root', '../x'), null)
  assert.equal(resolveInside('C:\\root', 'a/b'), join('C:\\root', 'a', 'b'))
})

// ---------------------------------------------------------------- 角色文件
check('roles-file：设置 / 迁移 / 恢复自动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-artifacts-'))
  try {
    const store = createRolesStore(join(dir, '.artifacts.json'))
    store.set(['a.md'], 'scratch')
    assert.equal(store.roleOf('a.md'), 'scratch')
    const migrated = store.migrate('a.md', 'b.md')
    assert.equal(migrated.migrated, true)
    assert.equal(store.roleOf('a.md'), undefined)
    assert.equal(store.roleOf('b.md'), 'scratch')
    store.set(['b.md'], null)
    assert.equal(store.roleOf('b.md'), undefined)
    assert.throws(() => store.set(['c.md'], 'boss'), /未知角色/)
    for (const role of ROLE_LIST) assert.doesNotThrow(() => store.set(['d.md'], role))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- zip
check('zip：写出的文件是合法 zip 头', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-artifacts-'))
  try {
    writeFileSync(join(dir, 'a.txt'), 'hello')
    writeZip(join(dir, 'out.zip'), [{ name: 'a/b.txt', abs: join(dir, 'a.txt') }])
    const buffer = readFileSync(join(dir, 'out.zip'))
    assert.ok(buffer.length > 10)
    assert.equal(buffer.subarray(0, 2).toString('latin1'), 'PK')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 索引（临时目录）
check('indexer：角色过滤 + 人工覆盖不被扫描开关挡住', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-artifacts-'))
  try {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'sessions', 's1'), { recursive: true })
    mkdirSync(join(dir, 'sessions', 's1', 'harness'), { recursive: true })
    writeFileSync(join(dir, 'sessions', 's1', '报告.md'), '# 报告\n')
    writeFileSync(join(dir, 'sessions', 's1', 'MEMORY.md'), '# 记忆\n')
    writeFileSync(join(dir, 'sessions', 's1', 'harness', 'drive.mjs'), '// x\n')
    writeFileSync(join(dir, 'ROOT.md'), '# 根目录\n')

    const settings = createSettingsStore(join(dir, 'sessions', '.settings.json'), { defaultRoot: dir })
    const roles = createRolesStore(join(dir, 'sessions', '.artifacts.json'))
    const indexer = createIndexer({ root: dir, settings, roles, dataDir: join(dir, 'sessions') })
    await indexer.rebuild()

    const ids = indexer.all().map((item) => item.id)
    assert.ok(ids.includes('s1/报告.md'))
    assert.ok(ids.includes('_root/ROOT.md'), '根目录文件要收')
    assert.ok(ids.includes('s1/MEMORY.md'))
    assert.ok(!ids.includes('s1/harness/drive.mjs'), '过程默认不收')

    roles.set(['s1/harness/drive.mjs'], 'deliverable')
    await indexer.rebuild()
    const promoted = indexer.all().find((item) => item.id === 's1/harness/drive.mjs')
    assert.ok(promoted !== undefined, '人工设成产物后要出现')
    assert.equal(promoted.roleSource, 'manual')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 云端记录（纯内存）
check('cloud：migrate / orphans', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-artifacts-'))
  try {
    const cloud = createCloud({ root: dir, dataDir: join(dir, 'sessions'), getCredentials: () => undefined })
    const item = { id: 's1/a.md', scope: 'session', session: 's1', path: 'a.md', name: 'a.md', abs: join(dir, 's1', 'a.md'), size: 3, mtime: 1 }
    assert.equal(cloud.recordedKeyOf(item), undefined)
    // 直接写记录，模拟"已上传"
    const file = join(dir, 'sessions', '.cloud.json')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    writeFileSync(file, JSON.stringify({ enabled: false, config: {}, items: {}, paths: { 's1/a.md': { key: 'k/a.md', size: 3, mtime: 1 } } }), 'utf8')
    cloud.reload()
    assert.equal(cloud.recordedKeyOf(item), 'k/a.md')
    assert.equal(cloud.migrate('s1/a.md', 's1/b.md').migrated, true)
    assert.equal(cloud.recordedKeyOf({ ...item, id: 's1/b.md' }), 'k/a.md')
    assert.deepEqual(cloud.orphanIds(new Set()), ['s1/b.md'])
    assert.deepEqual(cloud.orphanIds(new Set(['s1/b.md'])), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await Promise.all(pending)
const failed = checks.filter((entry) => !entry.ok)
for (const entry of checks) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.ok ? '' : ' :: ' + entry.error}`)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) process.exitCode = 1
