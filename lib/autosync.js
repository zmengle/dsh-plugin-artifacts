/**
 * 产物管理 · 定时自动同步。
 *
 * 保守版语义（用户确认过的范围）：**只重传「已经传过、但本地又改过」的文件**。
 *   - 候选 = 有云端记录（`recordedKeyOf` 存在）且 `stateOf === 'conflict'`（size 或 mtime 变了）；
 *   - 范围 = 设置里的 `backup.scope`（产物 / 产物+记忆），过程与素材永不上传；
 *   - 从不主动上传「没传过的新文件」——避免把随手写的敏感文件悄悄传上去。
 *
 * 行为约束：默认关闭、单飞、每轮最多 20 个、失败只记录不重试放大、云端关掉立即停表。
 */

const MAX_PER_RUN = 20
const MIN_INTERVAL_MS = 60_000

export function createAutoSync({ settings, indexer, cloud }) {
  let timer = null
  let running = null
  let last = { at: 0, uploaded: 0, failed: 0, skipped: 0, errors: [] }

  function scopeAllows(item, scope) {
    if (item.role === 'deliverable') return true
    if (item.role === 'memory') return scope === 'deliverable+memory'
    return false
  }

  /** 本轮要处理的条目：范围对 + 有云端记录 + 本地改过。 */
  function candidates() {
    const scope = settings.get().backup?.scope ?? 'deliverable'
    return indexer.all().filter((item) => {
      if (!scopeAllows(item, scope)) return false
      if (cloud.recordedKeyOf(item) === undefined) return false
      return cloud.stateOf(item) === 'conflict'
    })
  }

  async function runOnce() {
    if (running !== null) return running
    const job = (async () => {
      const cloudStatus = cloud.status()
      if (cloudStatus.enabled !== true) {
        last = { at: Date.now(), uploaded: 0, failed: 0, skipped: 0, errors: [{ id: '', message: '云端未启用' }] }
        return last
      }
      const list = candidates()
      const errors = []
      let uploaded = 0
      let failed = 0
      for (const item of list.slice(0, MAX_PER_RUN)) {
        try {
          await cloud.upload(item)
          uploaded += 1
        } catch (error) {
          failed += 1
          if (errors.length < 10) errors.push({ id: item.id, message: String(error?.message || error) })
        }
      }
      last = { at: Date.now(), uploaded, failed, skipped: Math.max(0, list.length - MAX_PER_RUN), errors }
      return last
    })()
      .catch((error) => {
        last = { at: Date.now(), uploaded: 0, failed: 0, skipped: 0, errors: [{ id: '', message: String(error?.message || error) }] }
        return last
      })
      .finally(() => { running = null })
    running = job
    return job
  }

  function stop() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /** 按当前设置重排定时器（设置改动后调用）。关闭状态下只是清表。 */
  function schedule() {
    stop()
    const conf = settings.get().autoSync ?? {}
    if (conf.enabled !== true) return
    const interval = Math.max(MIN_INTERVAL_MS, (Number(conf.intervalMinutes) || 15) * 60_000)
    timer = setTimeout(async () => {
      timer = null
      try { await runOnce() } catch { /* 已在内部记录 */ }
      schedule()
    }, interval)
    // 不阻止进程退出
    if (typeof timer.unref === 'function') timer.unref()
  }

  function status() {
    const conf = settings.get().autoSync ?? {}
    // 有记录但文件已不在的（删除 / 移出扫描范围）—— 自动同步处理不了，单独报出来
    const visible = new Set(indexer.all().map((item) => item.id))
    const orphans = cloud.orphanIds(visible).length
    return {
      enabled: conf.enabled === true,
      intervalMinutes: Number(conf.intervalMinutes) || 15,
      running: running !== null,
      last,
      candidates: candidates().length,
      orphans,
    }
  }

  return { start: schedule, stop, runOnce, status, reconfigure: schedule, candidates }
}
