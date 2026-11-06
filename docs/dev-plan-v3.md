# 产物管理 v3 开发计划

> 状态：**开发中**。规划稿见 `plugin-design-v3-artifact-model.md`。
> 本文是落地版：锁定的决策、schema、迁移、任务清单、测试与回滚。

---

## 1. 锁定的决策（来自你的确认）

| # | 决策 |
|---|---|
| D1 | **工作区是设置项**：安装时默认当前工作区，用户可增删，支持**多个**工作区路径 |
| D2 | **不假定目录规范**：可能没有 `sessions/`，也可能所有文件都堆在根目录 —— 扫描必须自适应 |
| D3 | **扫描类型可勾选**：`会话` / `记忆` / `产物`，默认 **产物 + 记忆** |
| D4 | 记忆文件「不一定有」→ 没有就是 0 条，不做特殊处理、不报错 |
| D5 | 分类用于**查询**与**备份**：备份范围由「角色」决定，默认只备份产物 |

### 1.1 三个扫描类型到底是什么

| 开关 | 收录什么 | 默认 | 说明 |
|---|---|---|---|
| **产物** `deliverable` | 根目录下任意位置、**通过产物规则**的文件 | ✅ | 不要求 `sessions/` 结构；`<root>/报告.md`、`<root>/proj/out.pdf` 都算 |
| **记忆** `memory` | 文件名匹配 `MEMORY*` / `PERSONA*` / `HANDOFF*`，或路径含 `memory/` | ✅ | 与位置无关，任意根下都收 |
| **会话** `session` | 结构化会话目录里的**全部**文件（含脚本、截图、夹具） | ❌ | 只有存在 `<root>/sessions/<会话>/` 或注册过的会话目录时才生效；这是噪声源，默认关 |

> 直觉解释：**产物 = 你要的东西，记忆 = 上下文，会话 = 过程现场**。前两个默认开，过程现场要看再开。

### 1.2 角色与扫描开关的关系

- 扫描开关决定 **收不收**；角色决定 **怎么显示/怎么备份**。
- 只开「产物」时：进索引的都是 `role=deliverable`。
- 开「会话」时：会话目录里的文件按规则再分 `deliverable / scratch`，`scratch` 只在「全部/过程」视图里出现。
- 「记忆」开时：`role=memory`。

---

## 2. 设置 schema v2

文件位置：**主工作区的数据目录**

```
<primaryRoot>/sessions/.settings.json      # 有 sessions/ 时（现状，零迁移）
<primaryRoot>/.dsh-artifacts/settings.json # 没有 sessions/ 时（兜底，隐藏目录，不参与索引）
```

```json
{
  "version": 2,
  "roots": [
    { "id": "r1", "path": "D:\\workspace\\dsh", "label": "工作区", "primary": true },
    { "id": "r2", "path": "D:\\work\\notes", "label": "笔记" }
  ],
  "scan": { "deliverable": true, "memory": true, "session": false },
  "trashRetention": "30",
  "sensitiveExcludes": ["..."],
  "showOthers": false
}
```

- **迁移**：v1 没有 `roots`/`scan` → 自动补 `roots=[{path: 当前工作区, primary:true}]`、`scan` 用默认值。迁移**只在内存**完成，用户不动设置就不落盘（保持"零改动"承诺）。
- **校验**：每个 root 必须绝对路径、存在、是目录；最多 8 个；不允许互相包含（保留更外层）；不允许等于 DSH home。
- **增删**：删除 root 只影响索引，不动磁盘；主根不可删除（可改路径）。
- 所有**数据文件**（`.index.json` / `.trash` / `.cloud.json`）仍然只落在主根数据目录。

---

## 3. 索引 v3

### 3.1 id 规则（必须向后兼容）

| 位置 | id | 兼容性 |
|---|---|---|
| `<root>/sessions/<S>/<rel>` | `<S>/<rel>` | **保持不变**（现有 142 条、云端记录全用它） |
| `<root>/artifacts/<A>/<rel>` | `_shared/<A>/<rel>` | 保持不变 |
| 主根其它位置 `<root>/<rel>` | `_root/<rel>` | 新增 |
| 扩展根 `<root2>/<rel>` | `@<label>/<rel>` | 新增（label 去重，冲突加序号） |

- `_root/` 与 `@label/` 是**保留命名空间**：真实会话目录叫 `_root` 或 `@x` 时加后缀 `~`。
- 云端 key 同步扩展：`v3/<namespace>/<rel>`；**已有记录仍用记录的 key**（老 key 不动）。

### 3.2 条目形状（新增字段）

```js
{
  id, scope: 'session'|'shared'|'root', session, sessionTitle,
  path, name, title, kind, ext, size, mtime, mtimeIso,
  role: 'deliverable'|'scratch'|'memory'|'asset',
  roleSource: 'auto'|'manual',
  rootId: 'r1',
  thumb, archived
}
```

`kind` 走 §4 的新 12 类；`role` 走 §5 的规则。

### 3.3 扫描流程

```
for each root in roots:
  读 root；若含 sessions/ 且 scan.session → 逐会话 walk（可增量）
  再 walk 整棵树（跳过 sessions/、artifacts/、忽略目录）
    每个文件：type ← kindOf(ext)；role ← roleOf(...)
    收录条件：role=memory && scan.memory
             role=deliverable && scan.deliverable
             role=scratch && scan.session
```

- **预算**：全局 `maxFiles`（默认 4000）+ 每目录 2000 上限，超出记 `truncated`。
- **忽略表**（新增）：`node_modules`, `.git`, `dist`, `build`, `out`, `coverage`, `__pycache__`, `.venv`, `venv`, `.next`, `.cache`, `.dsh-artifacts`, 以及点目录。
- **自适应**：没有 `sessions/` 时整棵树按产物/记忆规则收，不依赖任何约定。

### 3.4 增量与全量

- 现状已有 `mtime+size` 复用；多根后按 `rootId` 分别比对，逻辑不变。
- 设置变更（roots/scan 变化）→ 强制 `full: true` 重建。

---

## 4. 类型（12 类）

| kind | 扩展名 |
|---|---|
| doc | md, mdx, txt, pdf, docx, rtf, epub |
| sheet | csv, tsv, xlsx, xls, ods |
| slides | pptx, ppt, key, odp |
| image | png, jpg, jpeg, webp, gif, bmp, avif, ico |
| vector | svg |
| video | mp4, webm, mov, m4v, mkv |
| audio | mp3, wav, m4a, ogg, flac |
| code | js, mjs, cjs, jsx, ts, tsx, py, ps1, sh, bat, sql, css, scss, go, rs, java, c, cpp, h |
| config | json, yaml, yml, toml, ini, env, xml, conf, lock |
| web | html, htm |
| archive | zip, tar, gz, tgz, 7z, rar |
| other | 其余 |

> ⚠️ 兼容：`.json` 由 `code` 改判为 `config`，会让"代码"计数下降。UI 里 `code` 与 `config` 都归到「代码」大类显示，避免用户困惑；底层 kind 保留细分。

---

## 5. 角色规则

```
1. manual（.artifacts.json）                       最高
2. memory  : ^(MEMORY|PERSONA|HANDOFF) 或 /memory/ 或 /记忆/
3. scratch : 目录 screenshots|shots|harness|tests?|fixtures?|tmp|cache|node_modules|dist|build
             或名字 ^(probe|diag|debug|check|test|verify|shoot|shot|closeup|narrow|arrange|fixture|grep|inspect|live)[-_.]
             或 *.log|*.tmp|package-lock.json
4. asset   : 目录 uploads|assets|input|素材|参考
5. 其余     → deliverable
```

- 只在**会话目录内**才判 scratch（避免把 `_root/reports/harness-notes.md` 误伤）？
  → 不：规则对全树生效，但 `harness`/`screenshots` 这类目录名**必须整词匹配**（`harness-notes` 不命中）。
- `.artifacts.json`：`{ "version": 1, "roles": { "<id>": "deliverable|scratch|memory|asset" }, "onboarded": true }`，只存人工覆盖。

---

## 6. 接口变更

| 接口 | 变更 |
|---|---|
| `POST /status` | `roots: [{id,path,label,primary,exists,count}]`、`scan`、`counts: {deliverable,scratch,memory,asset}` |
| `POST /items` | 新参数 `role`（默认 `deliverable`；`all` 表示全部）、`type`、`root`；返回条目新字段；`facets.role/type/root` |
| `POST /settings` | 支持 `roots`（整表替换，带校验）、`scan`（三开关）；变更后强制重建 |
| `POST /artifacts/roles` | 批量设置/重置角色（P3） |
| `POST /index/refresh` | `{ full: true }` 依旧；`{ root: 'r2' }` 只刷某根（P2） |

错误码沿用：`E_INVALID`（参数/路径非法）、`E_FORBIDDEN`（路径在禁止区）、`E_NOT_FOUND`。

---

## 7. UI 变更

1. **设置面板改成分区**：`工作区`（列表：路径、条目数、主根标记、删除、添加…）/ `扫描类型`（三个开关）/ `显示与回收站`。
2. **主视图角色 chips**：`产物 N | 全部 N | 记忆 N | 会话 N`（会话 = 过程，未开扫描时置灰并提示"未启用会话扫描"）。
3. **类型 chips 变第二排**（只在结果里出现过的类型 + 计数）。
4. **卡片**：`全部` 视图下显示角色角标（过程/记忆/素材）；标题区右侧显示来源根（多根时）。
5. **空态**：无根/根不存在/扫描全关时给出明确指引（而不是"没有产物"）。
6. **整理模式**（P3）：按目录/会话批量设角色。

---

## 8. 备份范围

- 设置里多一项：`备份范围：仅产物（默认）/ 产物+记忆`
- 自动同步、批量上传都按此过滤；过程/素材永不上传。
- 云端 key：新文件用 `v3/<namespace>/<rel>`；老记录不动。

---

## 9. 任务清单

### P1 · host（✅ 已完成）
- [x] `lib/settings.js`：v2 schema（roots/scan）+ 迁移 + 校验（路径存在性、去重、包含检测、最多 8 个）
- [x] `lib/roles.js`（新）：`roleOf` 纯函数规则 + `roleEnabled`
- [x] `lib/util.js`：`kindOf` 12 类、忽略表扩充、项目标记
- [x] `lib/indexer.js`：多根扫描、自适应布局（无 `sessions/` 也能扫）、role 收录过滤、id 规则、条目带 `abs`
- [x] `index.js`：`/status`（roots/scan/byRole）、`/items`（role/type/root，默认产物）、`/settings`（roots/scan 校验 + 重建）
- [x] `lib/trash.js`：清单记录 `origin.abs`，多工作区/散文件可正确还原
- [x] 测试：`roots-test.mjs` **17 项**全过；`api-test` **87**、`drive` **46** 回归通过

### P2 · client（✅ 基本完成）
- [x] 设置面板分区：工作区列表（添加/移除/主标记）+ 扫描类型三开关
- [x] 角色 chips（产物/全部/过程/记忆）+ 类型 chips 第二排
- [x] 卡片角色角标（非产物时显示）
- [x] 空态：未勾扫描 / 只有过程文件 / 没有工作区，三种文案分开
- [ ] `sweep-buttons` 增补新控件（工作区添加/移除、扫描开关）


### P3 · 整理模式 + 手动标注（✅ 已完成）
- [x] `lib/roles-file.js`：`.artifacts.json` 读写 + 批量设置 + 恢复自动 + `onboarded`
- [x] `indexer`：扫描时套用人工覆盖，`roleSource` 回传；人工条目不受扫描开关过滤
- [x] `/artifacts/roles`（GET 读标注 / POST 批量设置、null 恢复自动）
- [x] 整理弹层：按「会话 · 目录」分组、单行三态、整组批量、完成/关闭、Esc
- [x] 测试：`curate-test.mjs` **29 项**全过

### P4 · 备份与同步（✅ 已完成）
- [x] 设置：`backup.scope`（仅产物 / 产物+记忆）、`autoSync.enabled/intervalMinutes`
- [x] `lib/autosync.js`：只重传已同步过且冲突的条目、单飞、每轮 20、云端关闭即停
- [x] `/cloud/autosync`（GET 状态 / POST 开关 / `runNow`）；`/cloud/upload { scope:'backup' }` 按范围批量
- [x] UI：设置面板「备份范围 / 自动同步 / 同步间隔 / 立即同步 / 上次结果」
- [x] 真机验证：`autosync-real.mjs` **8 项**全过（改文件 → runNow → 自动重传 → 回到 synced → 再跑不重复）

---

## 10. 测试计划

| 用例 | 断言 | 状态 |
|---|---|---|
| 迁移 | v1 设置文件 → 自动补 roots/scan，不落盘；保存后标记翻成 false | ✅ `migration-test` 11 项 |
| 多根 | 两个根（一个有 sessions、一个纯散文件）都能出条目；id 不冲突 | ✅ 17 项 |
| 无规范 | 根下直接放 `报告.md`、`图.png` → 产物可见 | ✅ |
| 扫描开关 | 只开产物时，`MEMORY.md` 不出现；开记忆后出现；会话目录内 `harness/*.mjs` 只有开会话才有 | ✅ |
| 类型 | `.json`→config、`.svg`→vector、`.html`→web | ✅ |
| 角色 | `screenshots/a.png`→scratch；`MEMORY.md`→memory；根目录 `设计稿.md`→deliverable | ✅ |
| 兼容 | 现有条目的 id 不变（尤其云端有记录的 4 条） | ✅ 主根 id 规则未动 |
| 预算 | 4000 条上限、超限 `truncated` 标记 | ✅ 沿用 |
| 裸工作区 | 没有 `sessions/` 时数据目录退到 `.dsh-artifacts/`、不凭空建 `sessions/`、隐藏目录不参与索引、`.trash` 删除/还原可用 | ✅ `bare-workspace-test` 16 项 |
| 人工标注 | 标成过程后默认视图消失、「全部」里仍在、恢复自动后回来 | ✅ `curate-test` 13 项 |
| 整理 UI | 分组、整组批量、恢复自动、Esc/完成关闭 | ✅ `curate-test` 16 项 |
| 自动同步 | 改文件 → runNow → 重传 1 个 → 回到 synced；无改动不重复传 | ✅ 真机 8 项 |
| 按钮巡检 | 57 个控件点一遍无错误 toast / 控制台异常 | ✅ `sweep-buttons` 57 |
| 真机（重启后） | `live-api-sweep` **25 项全过**（含 roots/scan/byRole/roles/autoSync 五个新字段）；真实工作区 53 条 = 产物 35 + 记忆 18；云端 1/4 可见 | ✅ 2026-11-06 03:25 |

---

## 11. 风险与回滚

| 风险 | 处理 |
|---|---|
| 默认只开产物+记忆 → 用户"文件变少了" | 升级后弹一次说明；「全部」里给"开会话扫描"入口 |
| id 规则改动破坏云端记录 | 主根沿用旧 id；新 id 只用于新位置；云端老记录原样保留 |
| 多根导致扫描变慢 | 忽略表 + 预算 + 增量；根数量上限 8 |
| 设置文件位置变化 | 有 `sessions/` 就还用原路径，零迁移 |

**回滚**：设置 v2 兼容 v1 字段；索引重建即可；不动用户文件。
