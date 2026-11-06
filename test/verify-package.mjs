/**
 * 发布前自检：不跑功能测试，只检查"这个包能不能被好好安装/展示"。
 *   npm run verify
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const ok = []
const check = (name, condition, detail) => {
  if (condition) ok.push(name)
  else problems.push(name + (detail === undefined ? '' : ' :: ' + detail))
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')

// ---- 安装硬性条件（见 publish-guide.md §0）
check('dsh.bundle.patch 已声明', typeof pkg.dsh?.bundle?.patch === 'string' && pkg.dsh.bundle.patch !== '')
check('patch 文件存在', existsSync(join(ROOT, pkg.dsh?.bundle?.patch ?? 'missing')))
check('带前端 UI 时声明了 dsh.client.platform', pkg.dsh?.client?.platform === 'web')
check('main 指向的文件存在', existsSync(join(ROOT, pkg.main ?? 'missing')))

// ---- 包内容
check('license 字段是 SPDX 标识', typeof pkg.license === 'string' && pkg.license.length > 0)
check('LICENSE 文件存在', existsSync(join(ROOT, 'LICENSE')))
check('CHANGELOG 存在且在 files 里', existsSync(join(ROOT, 'CHANGELOG.md')) && (pkg.files ?? []).includes('CHANGELOG.md'))
check('docs 在 files 里（否则 npm 页面截图全裂）', (pkg.files ?? []).includes('docs'))
check('description 不是占位文案', typeof pkg.description === 'string' && pkg.description.length > 20)

// ---- README 质量
const imageRefs = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1])
const localRefs = imageRefs.filter((ref) => !/^https?:\/\//.test(ref))
check('README 至少有一张截图', imageRefs.length > 0, imageRefs.length)
check('README 图片都用绝对地址（npm 页面不会裂图）', localRefs.length === 0, localRefs.slice(0, 3))
check('README 有英文摘要（目录站是英文向）', /English \(TL;DR\)/i.test(readme))
check('README 写明最低 DSH 版本', /DSH\s*≥\s*\d/.test(readme), '缺少「需要 DSH ≥ x.y.z」')

// ---- screenshots.json
const shotsFile = join(ROOT, 'screenshots.json')
check('screenshots.json 存在', existsSync(shotsFile))
if (existsSync(shotsFile)) {
  const shots = JSON.parse(readFileSync(shotsFile, 'utf8'))
  check('截图为 1–8 张', Array.isArray(shots) && shots.length >= 1 && shots.length <= 8, shots.length)
  for (const shot of shots) check(`截图存在：${shot}`, existsSync(join(ROOT, shot)))
  check('截图体积合理（< 1.5 MB/张）', shots.every((shot) => !existsSync(join(ROOT, shot)) || statSync(join(ROOT, shot)).size < 1.5 * 1024 * 1024))
}

// ---- 不该发出去的东西
check('.gitignore 里有 node_modules', /node_modules/.test(readFileSync(join(ROOT, '.gitignore'), 'utf8')))
check('没有把密钥文件带进包', ![...(pkg.files ?? [])].some((file) => /secret|\.env/i.test(file)))

for (const name of ok) console.log('ok   ' + name)
for (const problem of problems) console.log('FAIL ' + problem)
console.log(`\n${ok.length}/${ok.length + problems.length} passed`)
if (problems.length > 0) {
  console.error('\n发布前还有 ' + problems.length + ' 项要处理')
  process.exitCode = 1
} else {
  console.log('\n发布物料检查通过')
}
