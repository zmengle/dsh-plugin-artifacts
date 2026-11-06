window.__ModuleLoader__.load({ id: 'dsh-plugin-artifacts', factory: (require) => {
  'use strict'

  // 运行时只依赖 react（平台种子表提供）：不引其它包、不假设构建步骤。
  const React = require('react')
  const exports = {}
  const h = React.createElement

  exports.name = 'dsh-plugin-artifacts'

  /** 侧栏 id = main 面板 key（点侧栏图标 → shell 派发同名 key）。 */
  const PANEL_ID = 'artifacts'
  const API = '/api/dsh-artifacts'
  const PACKAGE = 'dsh-plugin-artifacts'
  const STYLE_ID = 'dsh-plugin-artifacts/styles'
  /** 首次使用提示条点掉后记这个 key（只存本地，不上报） */
  const ONBOARD_KEY = 'dsh-artifacts.onboarded'

  /** 类型条顺序（与 host 的 util.js 保持一致；`其他` 永远在「更多」里）。 */
  const PRIMARY_KINDS = ['doc', 'sheet', 'slides', 'image', 'video', 'code', 'web']
  const SECONDARY_KINDS = ['vector', 'audio', 'config', 'archive', 'other']
  const KIND_LABEL = {
    doc: '文档', sheet: '表格', slides: '幻灯片', image: '图片', vector: '矢量',
    video: '视频', audio: '音频', code: '代码', config: '配置', web: '网页',
    archive: '压缩包', other: '其他',
  }
  /** 角色：决定「要不要留、要不要备份」，和类型正交。 */
  const ROLE_LABEL = { deliverable: '产物', scratch: '过程', memory: '记忆', asset: '素材' }
  /** 每类的强调色（卡片图标底、角标），用色相区分而不是全灰。 */
  const KIND_HUE = {
    doc: '#4a6fa5', sheet: '#2f9e6b', slides: '#d9743a', image: '#2f9e9e', vector: '#3f8f7a',
    video: '#b5548f', audio: '#b5843f', code: '#7b61c9', config: '#6b7a8f', web: '#2f7dd1',
    archive: '#8a6d3b', other: '#68707a',
  }
  const CLOUD_LABEL = {
    disabled: '云端关闭', 'local-only': '仅本地', synced: '已同步', conflict: '有冲突', 'remote-only': '仅远端',
  }
  const RETENTION_LABEL = { '7': '7 天', '30': '30 天', forever: '永久' }

  // =========================================================================
  // 样式
  // =========================================================================

  const CSS = `
.ap-root{position:relative;display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%;width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.ap-head{flex:none;display:flex;align-items:flex-start;gap:16px;padding:18px 22px 12px}
.ap-titles{min-width:0;flex:1 1 auto}
.ap-title{margin:0;font-size:19px;line-height:1.35;font-weight:650;letter-spacing:.2px}
.ap-sub{margin:4px 0 0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.ap-headActions{flex:none;display:flex;align-items:center;gap:8px;padding-top:2px}
.ap-search{position:relative;display:flex;align-items:center}
.ap-search>svg{position:absolute;left:9px;opacity:.45;pointer-events:none}
.ap-search input{width:210px;height:30px;box-sizing:border-box;padding:0 28px 0 30px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit;font-size:12.5px;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s,background .15s}
.ap-search input::placeholder{color:var(--dsw-alias-label-secondary)}
.ap-search input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent)}
.ap-search-clear{position:absolute;right:6px;width:18px;height:18px;display:flex;align-items:center;justify-content:center;border:0;padding:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;line-height:1}
.ap-search-clear:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ap-iconbtn{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;padding:0;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.ap-iconbtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ap-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ap-iconbtn[aria-expanded="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ap-tabs{flex:none;display:flex;align-items:center;gap:22px;padding:0 22px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ap-tab{position:relative;display:inline-flex;align-items:center;gap:7px;height:38px;padding:0 1px;border:0;background:none;color:var(--dsw-alias-label-secondary);font-size:13px;font-family:inherit;cursor:pointer;transition:color .15s}
.ap-tab:hover{color:var(--dsw-alias-label-primary)}
.ap-tab[data-active="true"]{color:var(--dsw-alias-label-primary);font-weight:600}
.ap-tab[data-active="true"]::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary)}
.ap-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
.ap-tabCount{font-size:11px;line-height:1.6;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-weight:500}
.ap-tab[data-active="true"] .ap-tabCount{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-label-primary)}
.ap-tab[disabled]{opacity:.45;cursor:not-allowed}
.ap-filters{flex:none;display:flex;flex-direction:column;gap:8px;padding:9px 22px 8px}
.ap-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
/* 两排筛选：第一排角色（产物/全部/过程/记忆）+ 右侧控件，第二排类型 */
.ap-filterRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ap-chip--type{font-size:11.5px;opacity:.92}
.ap-chip{display:inline-flex;align-items:center;gap:6px;height:27px;padding:0 11px;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.ap-chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ap-chip[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent);color:var(--dsw-alias-label-primary);font-weight:600}
.ap-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ap-chipCount{font-size:10.5px;opacity:.62;font-variant-numeric:tabular-nums}
.ap-spacer{flex:1 1 auto;min-width:4px}
.ap-seg{display:inline-flex;padding:2px;gap:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.ap-segBtn{height:24px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-family:inherit;cursor:pointer;transition:background .15s,color .15s}
.ap-segBtn:hover{color:var(--dsw-alias-label-primary)}
.ap-segBtn[data-active="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.12);font-weight:600}
.ap-select{height:28px;padding:0 24px 0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit;font-size:11.5px;font-family:inherit;cursor:pointer;outline:none;appearance:none;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 13px) 12px,calc(100% - 9px) 12px;background-size:4px 4px,4px 4px;background-repeat:no-repeat;opacity:.9}
.ap-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ap-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:4px 22px 88px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.ap-body::-webkit-scrollbar{width:10px;height:10px}
.ap-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border:3px solid transparent;border-radius:8px;background-clip:content-box}
.ap-body::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));background-clip:content-box}
.ap-body::-webkit-scrollbar-track{background:transparent}
.ap-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:16px 14px;padding-top:12px;align-items:stretch}
/* 入场只做透明度：一旦给卡片加 transform（哪怕是 identity matrix），它就会变成 fixed 菜单的
   containing block，菜单坐标会按卡片算、整体跑出视口 */
.ap-card{position:relative;display:flex;flex-direction:column;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);overflow:visible;transition:border-color .16s,box-shadow .16s;animation:apCardIn .2s ease-out both}
.ap-card:hover{border-color:var(--dsw-alias-border-l2);box-shadow:0 8px 22px -12px rgba(0,0,0,.4)}
.ap-card[data-selected="true"]{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary)}
.ap-thumb{position:relative;aspect-ratio:16/10;border-radius:10px 10px 0 0;overflow:hidden;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--ap-hue,var(--dsw-alias-label-secondary)) 6%,var(--dsw-alias-bg-layer-2));border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);cursor:zoom-in;border:0;padding:0;width:100%;font-family:inherit;flex:none}
.ap-thumb:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.ap-thumb img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .25s cubic-bezier(.2,.8,.2,1)}
.ap-thumb:hover img{transform:scale(1.03)}
.ap-thumbScrim{position:absolute;left:0;right:0;bottom:0;height:52px;background:linear-gradient(to top,rgba(0,0,0,.34),transparent);opacity:0;transition:opacity .15s;pointer-events:none}
.ap-thumb:hover .ap-thumbScrim{opacity:1}
.ap-thumbGlyph{display:flex;flex-direction:column;align-items:center;gap:6px;color:var(--ap-hue,currentColor)}
.ap-thumbKind{font-size:10.5px;letter-spacing:.4px;opacity:.8}
.ap-cardBody{padding:10px 12px 11px;display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto}
.ap-name{font-size:12.5px;font-weight:600;line-height:1.42;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;word-break:break-word}
/* 元信息必须一行：文件名先让位省略，日期与大小各自 nowrap，绝不折行 */
.ap-meta{display:flex;align-items:center;gap:5px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);min-width:0;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;margin-top:auto}
.ap-meta>span{white-space:nowrap}
.ap-meta>span:not(.ap-metaText){flex:none}
.ap-metaSep{opacity:.5;flex:none}
/* 长文件名先让位：它是唯一可伸缩的，日期和大小永远保持可见 */
.ap-meta>.ap-metaText{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ap-path{font-size:10.5px;line-height:1.4;color:var(--dsw-alias-label-secondary);opacity:.86;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ap-badges{position:absolute;left:7px;bottom:7px;display:flex;gap:4px;z-index:4;pointer-events:none;max-width:calc(100% - 14px);overflow:hidden}
.ap-badge{display:inline-flex;align-items:center;gap:3px;height:19px;padding:0 6px;border-radius:6px;font-size:10px;font-weight:600;letter-spacing:.2px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);backdrop-filter:blur(4px)}
.ap-badge[data-tone="archived"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 20%,var(--dsw-alias-bg-overlay));border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}
.ap-badge[data-tone="synced"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 20%,var(--dsw-alias-bg-overlay));border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}
.ap-badge[data-tone="conflict"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 20%,var(--dsw-alias-bg-overlay));border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.ap-badge[data-tone="role"]{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 18%,var(--dsw-alias-bg-overlay));border-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 40%,transparent);color:var(--dsw-alias-label-primary)}
.ap-check{position:absolute;left:8px;top:8px;z-index:3;width:20px;height:20px;border-radius:6px;border:1.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-base) 75%,transparent);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;color:transparent;transition:opacity .15s,background .15s,border-color .15s,color .15s}
.ap-card:hover .ap-check,.ap-check[data-on="true"]{opacity:1}
.ap-check{opacity:0}
.ap-check[data-on="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.ap-check:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;opacity:1}
/* 右上角两个操作：预览 + 更多。整组一起淡入，避免一个先出现一个后出现 */
.ap-cardTools{position:absolute;right:7px;top:7px;z-index:5;display:flex;align-items:center;gap:6px;opacity:0;transition:opacity .15s}
.ap-card:hover .ap-cardTools,.ap-cardTools:focus-within,.ap-cardTools[data-open="true"]{opacity:1}
.ap-tool{width:24px;height:24px;border-radius:7px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 70%,transparent);padding:0;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 86%,transparent);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s,color .15s,border-color .15s;backdrop-filter:blur(6px)}
.ap-tool:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}
.ap-tool:active{transform:scale(.94)}
.ap-tool:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
/* 菜单用 fixed 定位（坐标由 JS 按按钮 rect 算）：不受 .ap-body 滚动容器裁剪，靠近底部会向上弹 */
.ap-menu{position:fixed;z-index:9000;width:188px;padding:4px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 16px 38px -14px rgba(0,0,0,.5);backdrop-filter:blur(10px);overflow-y:auto;overscroll-behavior:contain;animation:apMenuIn .14s cubic-bezier(.2,.8,.2,1);transform-origin:top right;scrollbar-width:thin}
.ap-menuItem{display:flex;align-items:center;gap:8px;width:100%;height:29px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;text-align:left;cursor:pointer}
.ap-menuItem:hover{background:var(--dsw-alias-bg-layer-2)}
.ap-menuItem:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.ap-menuItem[data-danger="true"]{color:var(--dsw-alias-state-error-primary)}
.ap-menuItem[disabled]{opacity:.4;cursor:not-allowed}
.ap-menuSep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1)}
.ap-list{display:flex;flex-direction:column;padding-top:10px}
/* 时间分组（年/月/日）：标题吸顶，滚动时知道自己在哪一段 */.ap-group{margin-bottom:4px}
.ap-groupHead{position:sticky;top:0;z-index:3;display:flex;align-items:baseline;gap:8px;padding:8px 2px 6px;margin-bottom:2px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 88%,transparent);backdrop-filter:blur(8px)}
.ap-groupTitle{font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary)}
.ap-groupCount{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ap-row{display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:9px;border:1px solid transparent;cursor:default}
.ap-row:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.ap-row[data-selected="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent)}
.ap-rowCheck{flex:none;width:18px;height:18px;border-radius:5px;border:1.5px solid var(--dsw-alias-border-l2);background:transparent;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;color:transparent}
.ap-rowCheck[data-on="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.ap-rowGlyph{flex:none;width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);color:var(--ap-hue,var(--dsw-alias-label-secondary));overflow:hidden}
.ap-rowGlyph img{width:100%;height:100%;object-fit:cover}
.ap-rowMain{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.ap-rowName{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ap-rowSub{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ap-rowMeta{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.ap-rowActions{flex:none;display:flex;gap:4px;opacity:0;transition:opacity .12s}
.ap-row:hover .ap-rowActions,.ap-rowActions:focus-within,.ap-rowActions[data-always="true"]{opacity:1}
.ap-selbar{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:50;display:flex;align-items:center;gap:10px;padding:8px 10px 8px 14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 40px -16px rgba(0,0,0,.5);backdrop-filter:blur(12px);animation:apRise .18s ease-out}
.ap-selCount{font-size:12px;font-weight:600;white-space:nowrap}
.ap-selCount span{color:var(--dsw-alias-label-secondary);font-weight:500}
.ap-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:29px;padding:0 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,transform .08s}
.ap-btn:hover{border-color:var(--dsw-alias-border-l3,#0003);background:var(--dsw-alias-bg-layer-2)}
.ap-btn:active{transform:translateY(1px)}
.ap-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ap-btn[disabled]{opacity:.45;cursor:not-allowed}
.ap-btn[disabled]:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2)}
.ap-btn--primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.ap-btn--primary:hover{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);filter:brightness(1.08)}
.ap-btn--danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 38%,transparent)}
.ap-btn--danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-color:var(--dsw-alias-state-error-primary)}
.ap-btn--ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.ap-btn--ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ap-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:64px 24px;color:var(--dsw-alias-label-secondary)}
.ap-emptyIcon{opacity:.32;margin-bottom:4px}
.ap-emptyTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ap-emptyDesc{font-size:12px;line-height:1.8;max-width:360px}
.ap-loading{display:flex;flex-direction:column;gap:12px;padding-top:14px}
.ap-skel{height:164px;border-radius:11px;background:linear-gradient(100deg,var(--dsw-alias-bg-layer-1) 30%,var(--dsw-alias-bg-layer-2) 50%,var(--dsw-alias-bg-layer-1) 70%);background-size:220% 100%;animation:apShimmer 1.4s infinite linear}
.ap-skelRow{display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:14px}
.ap-more-btn{align-self:center;margin:16px auto 0;display:block}
.ap-panel{margin-top:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px}
.ap-panel--slim{padding:9px 14px}
.ap-panel--slim .ap-panelHead{min-height:22px}
.ap-panelHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ap-panelTitle{font-size:13px;font-weight:650}
.ap-panelDesc{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.7}
.ap-form{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin-top:12px}
.ap-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.ap-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.2px}
.ap-input{height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:inherit;font-size:12px;font-family:inherit;outline:none;min-width:0}
.ap-input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}
.ap-input[data-mono="true"]{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px}
.ap-inputRow{display:flex;align-items:center;gap:6px;min-width:0}
.ap-inputRow .ap-input{flex:1 1 auto;min-width:0}
.ap-inputRow .ap-btn{flex:none}
.ap-checkRow{display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;user-select:none}
.ap-checkRow input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.ap-hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ap-hint[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.ap-hint[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.ap-hint[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.ap-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px}
.ap-kv{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:8px}
.ap-kv b{color:var(--dsw-alias-label-primary);font-weight:600}
.ap-retention{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ap-overlay{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;padding:28px;background:rgba(0,0,0,.42);backdrop-filter:blur(2px);animation:apFade .15s ease-out}
.ap-modal{position:relative;display:flex;flex-direction:column;width:min(880px,100%);max-height:min(84vh,760px);border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 32px 80px -24px rgba(0,0,0,.6);overflow:hidden;animation:apPop .18s cubic-bezier(.2,.8,.2,1)}
.ap-modal--sm{width:min(430px,100%);max-height:none}
.ap-modalHead{flex:none;display:flex;align-items:flex-start;gap:12px;padding:14px 16px 11px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ap-modalTitles{min-width:0;flex:1 1 auto}
.ap-modalTitle{font-size:14px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ap-modalSub{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ap-modalBody{flex:1 1 auto;min-height:0;overflow:auto;padding:0;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.ap-modalBody::-webkit-scrollbar{width:10px;height:10px}
.ap-modalBody::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border:3px solid transparent;border-radius:8px;background-clip:content-box}
.ap-modalBody--pad{padding:16px}
.ap-pre{margin:0;padding:14px 16px;font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;font-size:12px;line-height:1.72;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);tab-size:2}
.ap-imgWrap{display:flex;align-items:center;justify-content:center;padding:18px;background-image:linear-gradient(45deg,var(--dsw-alias-bg-layer-2) 25%,transparent 25%,transparent 75%,var(--dsw-alias-bg-layer-2) 75%),linear-gradient(45deg,var(--dsw-alias-bg-layer-2) 25%,transparent 25%,transparent 75%,var(--dsw-alias-bg-layer-2) 75%);background-size:18px 18px;background-position:0 0,9px 9px}
.ap-imgWrap img{max-width:100%;max-height:56vh;display:block;border-radius:6px;box-shadow:0 6px 24px -10px rgba(0,0,0,.4);animation:apFade .22s ease-out}
.ap-binary{display:flex;flex-direction:column;align-items:center;gap:10px;padding:44px 24px;text-align:center;color:var(--dsw-alias-label-secondary)}
.ap-modalFoot{flex:none;display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.ap-pathBtn{max-width:min(58%,560px);margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.8;color:var(--dsw-alias-label-secondary);background:transparent;border:0;border-radius:6px;padding:1px 6px;cursor:pointer;text-align:right}
.ap-pathBtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ap-pathBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ap-modalCloud{display:inline-flex;align-items:center;gap:5px;margin-top:5px;max-width:100%;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);background:transparent;border:1px dashed color-mix(in srgb,var(--dsw-alias-border-l2) 80%,transparent);border-radius:6px;padding:1px 6px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.ap-modalCloud:hover{border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}
.ap-toast{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);z-index:9500;max-width:min(560px,calc(100% - 48px));padding:9px 15px;border-radius:11px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.6;box-shadow:0 16px 36px -16px rgba(0,0,0,.5);white-space:pre-wrap;animation:apToastIn .18s ease-out;backdrop-filter:blur(10px)}
/* 底部有批量操作栏时把 toast 抬起来，别叠在一起 */
.ap-toast[data-raised="true"]{bottom:86px}
.ap-toast[data-kind="error"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);color:var(--dsw-alias-state-error-primary)}
.ap-toast[data-kind="ok"]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 50%,transparent)}
.ap-pop{position:absolute;z-index:60;min-width:190px;padding:10px 12px;border-radius:11px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 16px 38px -14px rgba(0,0,0,.5);backdrop-filter:blur(12px)}
/* 设置面板：多工作区 + 扫描类型，比普通气泡宽一些 */
.ap-pop--wide{width:320px;max-height:min(70vh,520px);overflow-y:auto;scrollbar-width:thin}
.ap-rootList{display:flex;flex-direction:column;gap:4px;margin-top:8px}
.ap-rootRow{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px}
.ap-rootPath{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-secondary)}
.ap-rootTag{flex:none;font-size:10px;padding:0 5px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-label-primary)}
.ap-iconbtn--sm{width:20px;height:20px}
.ap-scanList{display:flex;flex-direction:column;gap:2px;margin-top:6px}
.ap-scanList .ap-checkRow{align-items:flex-start;flex-wrap:wrap}
/* 整理模式 */
.ap-curateBtn{gap:5px;height:28px;font-size:12px}
.ap-notice{display:flex;align-items:flex-start;gap:7px;margin:0 22px 10px;padding:8px 11px;border-radius:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 70%,transparent);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.6}
/* 首次使用提示条 */.ap-banner{display:flex;align-items:center;gap:8px;margin:0 22px 8px;padding:8px 10px;border-radius:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent);color:var(--dsw-alias-label-primary);font-size:11.5px;line-height:1.6}
.ap-bannerText{flex:1 1 auto;min-width:0}
/* 使用说明 */
.ap-helpBody{display:flex;flex-direction:column;gap:14px}
.ap-helpSection h3{margin:0 0 6px;font-size:12px;font-weight:700;color:var(--dsw-alias-label-primary)}
.ap-helpSection ul{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.75}
.ap-helpSection code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.ap-emptyActions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.ap-curateSearch{padding:8px 16px 0}
.ap-curateSearch .ap-input{width:100%;height:28px}
.ap-curateBody{padding:12px 16px;max-height:min(62vh,560px)}
.ap-curateGroup{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;margin-bottom:10px;overflow:hidden}
.ap-curateHead{display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;flex-wrap:wrap}
.ap-curateTitle{font-weight:600;display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ap-curateRow{display:flex;align-items:center;gap:8px;padding:4px 10px;font-size:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.ap-curateRow:hover{background:var(--dsw-alias-bg-layer-2)}
.ap-curateRow[data-focused="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.ap-curateName{min-width:0;max-width:36%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ap-curateMeta{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.ap-roleBtn{height:22px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;font-family:inherit;cursor:pointer;transition:background .14s,color .14s,border-color .14s}
.ap-roleBtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.ap-roleBtn[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);color:var(--dsw-alias-label-primary);font-weight:600}
.ap-btn--sm{height:24px;padding:0 8px;font-size:11px}
.ap-popRow{display:flex;align-items:center;gap:8px;justify-content:space-between;margin-top:8px}
.ap-popTitle{font-size:11px;font-weight:700;letter-spacing:.4px;color:var(--dsw-alias-label-secondary);text-transform:uppercase}
/* 深色主题：只覆盖少数「内容上的固定色」（遮罩、缩略图图标），其余全部走 --dsw-* 令牌，
   这样宿主切主题时不会出现某种配色只对一半的尴尬 */
[data-ds-dark-theme] .ap-overlay{background:rgba(0,0,0,.58)}
[data-ds-dark-theme] .ap-thumbGlyph{color:color-mix(in srgb,var(--ap-hue) 62%,#fff)}
[data-ds-dark-theme] .ap-card:hover{box-shadow:0 10px 26px -14px rgba(0,0,0,.75)}
[data-ds-dark-theme] .ap-menu,[data-ds-dark-theme] .ap-selbar,[data-ds-dark-theme] .ap-toast{box-shadow:0 18px 40px -18px rgba(0,0,0,.85)}
@keyframes apFade{from{opacity:0}to{opacity:1}}
@keyframes apPop{from{opacity:0;transform:translateY(6px) scale(.99)}to{opacity:1;transform:none}}
@keyframes apMenuIn{from{opacity:0;transform:translateY(-4px) scale(.97)}to{opacity:1;transform:none}}
@keyframes apCardIn{from{opacity:0}to{opacity:1}}
@keyframes apRise{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes apToastIn{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes apShimmer{from{background-position:120% 0}to{background-position:-20% 0}}
@media (prefers-reduced-motion:reduce){
  .ap-card,.ap-btn,.ap-check,.ap-tool,.ap-thumb img,.ap-search input,.ap-selbar,.ap-toast,.ap-modal,.ap-overlay,.ap-skel{animation:none!important;transition:none!important}
}
@media (max-width:720px){
  .ap-head{padding:14px 14px 10px;flex-wrap:wrap}
  .ap-search input{width:150px}
  .ap-tabs,.ap-filters{padding-left:14px;padding-right:14px}
  .ap-body{padding:4px 14px 96px}
  .ap-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
}
`

  function installStyles() {
    if (typeof document === 'undefined') return
    if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return
    const tag = document.createElement('style')
    tag.dataset.plugin = PACKAGE
    tag.dataset.pluginCss = STYLE_ID
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  // =========================================================================
  // 小工具
  // =========================================================================

  async function rpc(action, body) {
    const response = await fetch(API + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      cache: 'no-store',
    })
    let data
    try {
      data = JSON.parse(await response.text())
    } catch {
      throw new Error('服务响应异常（HTTP ' + response.status + '）')
    }
    if (data === null || typeof data !== 'object') throw new Error('服务响应异常')
    if (data.ok === false) {
      const error = new Error(data.error?.message || '请求失败')
      error.code = data.error?.code || 'E_INTERNAL'
      throw error
    }
    return data.data
  }

  const pad2 = (n) => String(n).padStart(2, '0')

  /** `10-27 23:52`；今年的才省年份。 */
  function timeLabel(ms) {
    const value = Number(ms)
    if (!Number.isFinite(value) || value <= 0) return '—'
    const date = new Date(value)
    const now = new Date()
    const base = pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    return date.getFullYear() === now.getFullYear() ? base : date.getFullYear() + '-' + base
  }

  /**
   * 时间分组（像手机相册）：年 / 月 / 日。
   * key 用 `YYYY`、`YYYY-MM`、`YYYY-MM-DD`，既能排序也能直接比较。
   */
  function groupKeyOf(ms, granularity) {
    const value = Number(ms)
    if (!Number.isFinite(value) || value <= 0) return 'unknown'
    const date = new Date(value)
    const year = date.getFullYear()
    if (granularity === 'year') return String(year)
    const month = pad2(date.getMonth() + 1)
    if (granularity === 'month') return `${year}-${month}`
    return `${year}-${month}-${pad2(date.getDate())}`
  }

  /** 分组标题：今天 / 昨天 / 11月5日 / 2026年11月 / 2026年。 */
  function groupLabelOf(key, granularity) {
    if (key === 'unknown') return '时间未知'
    const [year, month, day] = key.split('-')
    if (granularity === 'year') return `${year}年`
    if (granularity === 'month') return `${year}年${Number(month)}月`
    const now = new Date()
    const todayKey = groupKeyOf(now.getTime(), 'day')
    const yesterdayKey = groupKeyOf(now.getTime() - 86_400_000, 'day')
    if (key === todayKey) return '今天'
    if (key === yesterdayKey) return '昨天'
    if (Number(year) === now.getFullYear()) return `${Number(month)}月${Number(day)}日`
    return `${year}年${Number(month)}月${Number(day)}日`
  }

  function relTime(ms) {    const delta = Date.now() - Number(ms)
    if (!Number.isFinite(delta)) return '—'
    if (delta < 60_000) return '刚刚'
    if (delta < 3_600_000) return Math.floor(delta / 60_000) + ' 分钟前'
    if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + ' 小时前'
    if (delta < 7 * 86_400_000) return Math.floor(delta / 86_400_000) + ' 天前'
    return timeLabel(ms)
  }

  function humanBytes(bytes) {
    const n = Number(bytes) || 0
    if (n < 1024) return n + ' B'
    const units = ['KB', 'MB', 'GB', 'TB']
    let value = n / 1024
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
    return (value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')) + ' ' + units[unit]
  }

  function dirOf(path) {
    const index = String(path).lastIndexOf('/')
    return index === -1 ? '' : String(path).slice(0, index)
  }

  /**
   * 卡片主标题：md/html 取到的标题更有信息量时用它，否则直接用文件名。
   * （否则 `logo.svg` 会显示成光秃秃的「logo」，而 `README.md` 又能显示「示例报告」。）
   */
  function displayName(item) {
    const name = String(item.name || '')
    const dot = name.lastIndexOf('.')
    const stem = dot <= 0 ? name : name.slice(0, dot)
    const title = String(item.title || '').trim()
    return title !== '' && title !== stem ? title : name
  }

  /** 卡片上的路径行：`会话名 / 子目录` 或 `共享 / 品牌包`。 */
  function pathLabel(item) {
    if (item.scope === 'shared') return '共享' + (item.session ? ' / ' + item.session : '')
    const title = item.sessionTitle || item.session || ''
    const dir = dirOf(item.path)
    return dir === '' ? title : title + ' / ' + dir
  }

  // =========================================================================
  // 图标
  // =========================================================================

  function Icon({ size = 16, viewBox = '0 0 24 24', strokeWidth = 1.6, children }) {
    return h('svg', {
      width: size, height: size, viewBox, fill: 'none', stroke: 'currentColor',
      strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, focusable: false,
    }, children)
  }

  const dot = (cx, cy, r = 1.1) => h('circle', { cx, cy, r, fill: 'currentColor', stroke: 'none' })
  const path = (d, extra) => h('path', Object.assign({ d }, extra))

  const GLYPHS = {
    web: () => h(React.Fragment, null, h('circle', { cx: 12, cy: 12, r: 8.5 }), path('M3.5 12h17'), path('M12 3.5c2.6 2.4 4 5.4 4 8.5s-1.4 6.1-4 8.5c-2.6-2.4-4-5.4-4-8.5s1.4-6.1 4-8.5Z')),
    slides: () => h(React.Fragment, null, h('rect', { x: 3, y: 4.5, width: 18, height: 12.5, rx: 2 }), path('M9.5 20h5'), path('M12 17v3'), path('M10 8.6l4.2 2.2L10 13z')),
    doc: () => h(React.Fragment, null, path('M6 3.5h7.5L19 9v11.5H6z'), path('M13.5 3.5V9H19'), path('M9 12.5h6'), path('M9 16h4')),
    sheet: () => h(React.Fragment, null, h('rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }), path('M3.5 9.5h17'), path('M3.5 14.5h17'), path('M9.5 4.5v15')),
    video: () => h(React.Fragment, null, h('rect', { x: 3, y: 5.5, width: 18, height: 13, rx: 2.5 }), path('M10.3 9.4l4.7 2.6-4.7 2.6z')),
    image: () => h(React.Fragment, null, h('rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }), h('circle', { cx: 8.7, cy: 9.6, r: 1.5 }), path('M4.2 17.2l4.6-4.4 3.2 3 2.6-2.3 4.8 4.4')),
    code: () => h(React.Fragment, null, path('M9 7.5L4.5 12 9 16.5'), path('M15 7.5L19.5 12 15 16.5'), path('M13.2 5.5l-2.4 13')),
    archive: () => h(React.Fragment, null, h('rect', { x: 3.5, y: 4.5, width: 17, height: 4.5, rx: 1.4 }), path('M5.5 9v10.5h13V9'), path('M10 13h4')),
    other: () => h(React.Fragment, null, path('M6 3.5h7.5L19 9v11.5H6z'), path('M13.5 3.5V9H19')),
  }

  function KindGlyph({ kind, size = 26 }) {
    const render = GLYPHS[kind] || GLYPHS.other
    return h(Icon, { size, strokeWidth: 1.5 }, render())
  }

  const I = {
    search: () => h(React.Fragment, null, h('circle', { cx: 11, cy: 11, r: 6.5 }), path('M16 16l4.5 4.5')),
    more: () => h(React.Fragment, null, dot(12, 5.5, 1.5), dot(12, 12, 1.5), dot(12, 18.5, 1.5)),
    gear: () => h(React.Fragment, null, h('circle', { cx: 12, cy: 12, r: 3.2 }), path('M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z')),
    grid: () => h(React.Fragment, null, h('rect', { x: 4, y: 4, width: 6.5, height: 6.5, rx: 1.2 }), h('rect', { x: 13.5, y: 4, width: 6.5, height: 6.5, rx: 1.2 }), h('rect', { x: 4, y: 13.5, width: 6.5, height: 6.5, rx: 1.2 }), h('rect', { x: 13.5, y: 13.5, width: 6.5, height: 6.5, rx: 1.2 })),
    list: () => h(React.Fragment, null, path('M4 6.5h16'), path('M4 12h16'), path('M4 17.5h16')),
    check: () => path('M5 12.5l4.2 4.2L19 7'),
    close: () => path('M6 6l12 12M18 6L6 18'),
    rename: () => h(React.Fragment, null, path('M4 20h4.5L20 8.5a2.1 2.1 0 0 0-3-3L5.5 17Z'), path('M14.5 6.5l3 3')),
    download: () => h(React.Fragment, null, path('M12 4v10.5'), path('M7.8 10.6L12 14.8l4.2-4.2'), path('M5 19.5h14')),
    upload: () => h(React.Fragment, null, path('M12 20V9.5'), path('M7.8 13.4L12 9.2l4.2 4.2'), path('M5 4.5h14')),
    trash: () => h(React.Fragment, null, path('M4.5 7h15'), path('M9.5 7V4.5h5V7'), path('M6.5 7l1 13h9l1-13'), path('M10.5 11v5'), path('M13.5 11v5')),
    restore: () => h(React.Fragment, null, path('M4 10.5A8 8 0 1 1 12 20'), path('M4 4.5v6h6')),
    archive: () => h(React.Fragment, null, h('rect', { x: 3.5, y: 4.5, width: 17, height: 4.5, rx: 1.4 }), path('M5.5 9v10.5h13V9'), path('M10 13h4')),
    eye: () => h(React.Fragment, null, path('M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12Z'), h('circle', { cx: 12, cy: 12, r: 3 })),
    folder: () => h(React.Fragment, null, path('M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.5h8A1.5 1.5 0 0 1 20.5 10v8A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18Z')),
    cloud: () => h(React.Fragment, null, path('M7.5 18.5h9a3.8 3.8 0 0 0 .6-7.55A5.2 5.2 0 0 0 7 9.6a4.5 4.5 0 0 0 .5 8.9Z')),
    refresh: () => h(React.Fragment, null, path('M20 11.5A8 8 0 1 0 18.4 17'), path('M20 5v6h-6')),
    info: () => h(React.Fragment, null, h('circle', { cx: 12, cy: 12, r: 8.5 }), path('M12 11v5.5'), dot(12, 7.8, 1.2)),
    help: () => h(React.Fragment, null, h('circle', { cx: 12, cy: 12, r: 8.5 }), path('M9.5 9.3a2.6 2.6 0 1 1 3.6 2.4c-.9.4-1.3 1.1-1.3 2'), dot(12, 16.9, 1.1)),
    box: () => h(React.Fragment, null, path('M4 8.2L12 4l8 4.2v7.6L12 20l-8-4.2z'), path('M4 8.2l8 4.3 8-4.3'), path('M12 12.5V20')),
    empty: () => h(React.Fragment, null, path('M4.5 9.5 12 4l7.5 5.5v8L12 20l-7.5-2.5z'), path('M8.5 14.5h7'), path('M9.5 11h5')),
    chevronDown: () => path('M6 9.5l6 6 6-6'),
    chevronUp: () => path('M6 14.5l6-6 6 6'),
    remote: () => h(React.Fragment, null, path('M7.5 18.5h9a3.8 3.8 0 0 0 .6-7.55A5.2 5.2 0 0 0 7 9.6a4.5 4.5 0 0 0 .5 8.9Z'), path('M9 14l3 3 3-3'), path('M12 11v6')),
  }

  /** 侧栏图标：一只打开的产物盒子（currentColor 跟随选中态）。 */
  function SidebarIcon({ size = 18 }) {
    return h('svg', {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      'aria-hidden': true, focusable: false,
    },
      h('path', {
        d: 'M3.4 8.1 12 3.4l8.6 4.7v7.8L12 20.6 3.4 15.9z',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round',
        fill: 'currentColor', fillOpacity: 0.1,
      }),
      h('path', { d: 'M3.4 8.1 12 12.9l8.6-4.8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
      h('path', { d: 'M12 12.9v7.7', stroke: 'currentColor', strokeWidth: 1.6 }),
      h('path', { d: 'M8.2 10.5v3.4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
  }

  // =========================================================================
  // store
  // =========================================================================

  const INITIAL = {
    phase: 'loading',          // loading | ready | error
    error: '',
    tab: 'local',              // local | cloud | trash
    // 角色（主维度）：产物 / 全部 / 过程 / 记忆。默认只看产物 —— 打开就是干净的。
    role: 'deliverable',
    kind: 'all',
    moreOpen: false,
    scope: 'all',              // all | session | shared
    root: 'all',               // all | primary | @label
    sort: 'mtime',             // mtime | created | name | size
    group: 'month',            // none | year | month | day —— 只对时间排序生效
    order: 'desc',
    view: 'grid',              // grid | list
    q: '',
    items: [],
    total: 0,
    hasMore: false,
    offset: 0,
    loadingItems: false,
    facets: { kind: {}, scope: { session: 0, shared: 0, root: 0 }, role: { deliverable: 0, scratch: 0, memory: 0, asset: 0 }, total: 0 },
    byRole: { deliverable: 0, scratch: 0, memory: 0, asset: 0 },
    curate: { open: false, loading: false, items: [], total: 0, truncated: false },
    selected: [],
    trash: { items: [], bytes: 0, retention: '30' },
    settings: { trashRetention: '30', showOthers: false, roots: [], scan: { deliverable: true, memory: true, session: false } },
    settingsOpen: false,
    helpOpen: false,
    // 首次使用提示条（用户点掉后写 localStorage，不再出现）
    firstRun: false,
    status: null,
    cloud: {
      config: null,
      loading: false,
      busy: false,
      testing: false,
      testResult: null,
      feedback: '',
      feedbackTone: '',
      reconcile: null,
      /** null = 跟随状态（未配置时展开）；true/false = 用户手动折叠过 */
      configOpen: null,
    },
    preview: null,             // { item, loading, data, error }
    dialog: null,              // { type, ... }
    menuId: null,
    menuAnchor: { left: 0, top: 0, maxHeight: 340 },
    lastRefreshAt: 0,
    toast: null,
    busy: '',
  }

  let state = INITIAL
  /** 客户端 cordis 上下文，用来按需取 uiWorkspace（原生目录选择器）。 */
  let uiContext = null
  const subscribers = new Set()
  const getSnapshot = () => state
  function subscribe(listener) {
    subscribers.add(listener)
    return () => subscribers.delete(listener)
  }
  function setState(patch) {
    const next = typeof patch === 'function' ? patch(state) : patch
    state = Object.assign({}, state, next)
    for (const listener of subscribers) listener()
  }
  function useStore() {
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }

  let toastTimer = null
  function notify(text, kind) {
    if (toastTimer) clearTimeout(toastTimer)
    setState({ toast: { text: String(text), kind: kind || 'info' } })
    toastTimer = setTimeout(() => {
      toastTimer = null
      setState({ toast: null })
    }, 4200)
  }

  const selectedSet = () => new Set(state.selected)
  const toggleSelected = (id) => setState((current) => {
    const set = new Set(current.selected)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    return { selected: [...set] }
  })

  /**
   * 复制到剪贴板。`writeText` 返回 Promise，失败时必须自己接住 ——
   * 否则会变成 unhandled rejection（控制台报错、且用户什么提示都没有）。
   */
  function copyText(text, successLabel) {
    const done = () => notify(successLabel || '已复制', 'ok')
    const failed = () => notify('复制失败：剪贴板被拒绝或不可用', 'error')
    try {
      const api = navigator.clipboard
      if (api === undefined || typeof api.writeText !== 'function') { failed(); return }
      const promise = api.writeText(String(text))
      if (promise !== undefined && typeof promise.then === 'function') promise.then(done, failed)
      else done()
    } catch {
      failed()
    }
  }

  const MENU_WIDTH = 188
  /** 菜单大概有多高：9 项 × 29 + 内边距 + 两条分隔线。 */
  const MENU_ESTIMATE = 340
  /** 再挤也要留这么多高度：否则最后一项会被裁掉半截（宁可与按钮重叠一点）。 */
  const MENU_MIN_HEIGHT = 240

  /**
   * 菜单不放在卡片里，而是用 fixed 坐标贴着 ⋯ 按钮画：
   * 卡片在 .ap-body 的滚动容器里，绝对定位的菜单会被容器裁掉（越靠下越明显）。
   */
  function toggleMenu(event, item, open) {
    if (open) {
      setState({ menuId: null })
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const margin = 8
    const spaceBelow = window.innerHeight - rect.bottom - margin
    const spaceAbove = rect.top - margin
    const openUp = spaceBelow < MENU_ESTIMATE && spaceAbove > spaceBelow
    const maxHeight = Math.max(MENU_MIN_HEIGHT, Math.min(MENU_ESTIMATE, openUp ? spaceAbove - 6 : spaceBelow - 6))
    const top = openUp
      ? Math.max(margin, rect.top - Math.min(maxHeight, spaceAbove) - 6)
      : rect.bottom + 6
    const left = Math.min(Math.max(margin, rect.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - margin)
    setState({ menuId: item.id, menuAnchor: { left, top, maxHeight } })
  }

  // =========================================================================
  // 目录选择（「另存为」「云端下载到…」）
  // =========================================================================

  /**
   * 目录选择器。优先级照抄 DSH 内置 UI 的写法：
   *   1. `globalThis.__DSH_DIRECTORY_PICKER__`（桌面壳提供的原生实现，最稳）；
   *   2. `ctx.uiWorkspace.pickDirectory()`（走 Host Remote，某些环境会抛
   *      `directory picker failed: …`）。
   * 两者都没有/都失败时返回 supported=false，调用方退回默认位置，而不是弹错误。
   */
  function resolveDirectoryPicker() {
    const desktop = globalThis.__DSH_DIRECTORY_PICKER__
    if (desktop !== undefined && desktop !== null && typeof desktop.pick === 'function') {
      return { pick: () => desktop.pick() }
    }
    try {
      const ui = uiContext !== null && typeof uiContext.get === 'function' ? uiContext.get('uiWorkspace') : undefined
      if (ui !== null && ui !== undefined && typeof ui.pickDirectory === 'function') {
        return { pick: () => ui.pickDirectory() }
      }
    } catch { /* 服务不可用就当没有 */ }
    return null
  }

  async function chooseDirectory() {
    const picker = resolveDirectoryPicker()
    if (picker === null) return { supported: false, ok: false }
    try {
      const dir = await picker.pick()
      if (typeof dir !== 'string' || dir.trim() === '') return { supported: true, ok: false, cancelled: true }
      return { supported: true, ok: true, dir: dir.trim() }
    } catch (error) {
      // 选择器本身不可用（权限/环境），不是用户的错 —— 交给调用方优雅降级
      return { supported: false, ok: false, error: String(error?.message || error) }
    }
  }

  // =========================================================================
  // 数据加载
  // =========================================================================

  let itemSeq = 0
  let searchTimer = null

  function currentFilters() {
    return {
      scope: state.scope === 'all' ? undefined : state.scope,
      // 角色是主维度：默认只看产物；云端 tab 不看角色（它只关心有没有云端副本）
      role: state.tab === 'cloud' ? 'all' : state.role,
      kinds: state.kind === 'all' ? undefined : [state.kind],
      root: state.root === 'all' ? undefined : state.root,
      q: state.q.trim() || undefined,
      sort: state.sort,
      order: state.order,
      // 云端 tab 只列有云端副本的条目 —— 本地文件混在里面会让人以为云端也有
      cloudOnly: state.tab === 'cloud',
    }
  }

  async function loadItems(reset) {
    const seq = ++itemSeq
    setState({ loadingItems: true })
    try {
      const filters = currentFilters()
      const offset = reset ? 0 : state.offset
      const data = await rpc('/items', Object.assign({}, filters, { offset, limit: 48 }))
      if (seq !== itemSeq) return
      const items = reset ? data.items : state.items.concat(data.items)
      setState({
        phase: 'ready',
        error: '',
        items,
        total: data.total,
        offset: offset + data.items.length,
        hasMore: data.hasMore,
        facets: data.facets,
        loadingItems: false,
      })
    } catch (error) {
      if (seq !== itemSeq) return
      setState({ phase: 'error', error: String(error?.message || error), loadingItems: false })
    }
  }

  async function loadStatus() {
    try {
      const data = await rpc('/status')
      setState({
        status: data,
        settings: data.settings || state.settings,
        byRole: data.byRole || state.byRole,
      })
    } catch (error) {
      notify('读取状态失败：' + String(error?.message || error), 'error')
    }
  }

  async function loadTrash() {
    try {
      const data = await rpc('/trash/list')
      setState({ trash: data, selected: [] })
    } catch (error) {
      notify('读取回收站失败：' + String(error?.message || error), 'error')
    }
  }

  async function loadCloudConfig() {
    setState({ cloud: Object.assign({}, state.cloud, { loading: true }) })
    try {
      const data = await rpc('/cloud/config')
      setState({ cloud: Object.assign({}, state.cloud, { config: data.config, loading: false }) })
    } catch (error) {
      setState({ cloud: Object.assign({}, state.cloud, { loading: false, feedback: String(error?.message || error), feedbackTone: 'error' }) })
    }
  }

  // =========================================================================
  // 操作
  // =========================================================================

  async function doRefreshIndex() {
    setState({ busy: 'refresh' })
    try {
      const data = await rpc('/index/refresh', { full: true })
      await loadItems(true)
      await loadStatus()
      notify('索引已重建：' + data.status.items + ' 个产物', 'ok')
    } catch (error) {
      notify('重建索引失败：' + String(error?.message || error), 'error')
    } finally {
      setState({ busy: '' })
    }
  }

  async function openPreview(item) {
    setState({ preview: { item, loading: true, data: null, error: '' }, menuId: null })
    try {
      const data = await rpc('/item/read', { id: item.id })
      setState({ preview: { item, loading: false, data, error: '' } })
    } catch (error) {
      setState({ preview: { item, loading: false, data: null, error: String(error?.message || error) } })
    }
  }

  function requestDelete(items) {
    if (items.length === 0) return
    setState({
      dialog: {
        type: 'delete',
        title: items.length === 1 ? '移入回收站？' : `把 ${items.length} 个文件移入回收站？`,
        body: items.length === 1 ? items[0].name : items.slice(0, 3).map((item) => item.name).join('、') + (items.length > 3 ? ' 等' : ''),
        items,
      },
    })
  }

  async function confirmDelete(items) {
    setState({ busy: 'delete', dialog: null })
    try {
      const token = await rpc('/delete-token', { ids: items.map((item) => item.id) })
      const result = await rpc('/item/delete', { ids: items.map((item) => item.id), token: token.token })
      setState({ selected: [] })
      await loadItems(true)
      await loadStatus()
      notify(`已移入回收站 ${result.moved} 个` + (result.failed.length > 0 ? `，${result.failed.length} 个失败` : ''), 'ok')
    } catch (error) {
      notify('删除失败：' + String(error?.message || error), 'error')
    } finally {
      setState({ busy: '' })
    }
  }

  async function confirmPurge(ids) {
    setState({ busy: 'purge', dialog: null })
    try {
      const result = await rpc('/item/purge', { ids })
      await loadTrash()
      await loadStatus()
      notify(`已彻底删除 ${result.removed} 个文件`, 'ok')
    } catch (error) {
      notify('彻底删除失败：' + String(error?.message || error), 'error')
    } finally {
      setState({ busy: '' })
    }
  }

  async function emptyTrash() {
    setState({ busy: 'purge', dialog: null })
    try {
      const result = await rpc('/item/purge', { all: true })
      await loadTrash()
      await loadStatus()
      notify(`回收站已清空（${result.removed} 项）`, 'ok')
    } catch (error) {
      notify('清空失败：' + String(error?.message || error), 'error')
    } finally {
      setState({ busy: '' })
    }
  }

  async function restoreTrash(ids) {
    setState({ busy: 'restore' })
    try {
      const result = await rpc('/item/restore', { ids })
      await loadTrash()
      await loadStatus()
      if (result.conflicts.length > 0) notify(`还原 ${result.restored.length} 个，${result.conflicts.length} 个因同名冲突跳过`, 'error')
      else notify(`已还原 ${result.restored.length} 个文件`, 'ok')
    } catch (error) {
      notify('还原失败：' + String(error?.message || error), 'error')
    } finally {
      setState({ busy: '' })
    }
  }

  async function doRename(item, name) {
    setState({ busy: 'rename', dialog: null })
    try {
      const result = await rpc('/item/rename', { id: item.id, to: name })
      await loadItems(true)
      setState({ menuId: null })
      notify('已重命名为 ' + result.name, 'ok')
    } catch (error) {
      notify('重命名失败：' + String(error?.message || error), 'error')
    } finally {
      setState({ busy: '' })
    }
  }

  async function doArchive(items) {
    if (items.length === 0) return
    setState({ busy: 'archive' })
    try {
      // 按来源分组：一个会话一个 zip，跨会话选中也不会串味
      const groups = new Map()
      for (const item of items) {
        const key = item.scope + ':' + item.session
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(item)
      }
      let files = 0
      let zips = 0
      for (const group of groups.values()) {
        const result = await rpc('/archive', { ids: group.map((item) => item.id) })
        files += result.files
        zips += 1
      }
      setState({ selected: [] })
      await loadItems(true)
      await loadStatus()
      notify(`已归档 ${files} 个文件到 ${zips} 个 zip（archive/<year>/）`, 'ok')
    } catch (error) {
      notify('归档失败：' + String(error?.message || error), 'error')
    } finally {
      setState({ busy: '' })
    }
  }

  /** 归档条目的「清理原目录」：先确认，再走回收站（不是直接删）。 */
  async function cleanSession(item) {
    try {
      const data = await rpc('/items', { session: item.session, limit: 200 })
      requestDelete(data.items)
    } catch (error) {
      notify('读取会话产物失败：' + String(error?.message || error), 'error')
    }
  }

  async function uploadCloud(items) {
    if (items.length === 0) return
    setState({ busy: 'upload' })
    try {
      const result = await rpc('/cloud/upload', { ids: items.map((item) => item.id) })
      await loadItems(true)
      setState({ selected: [] })
      const failed = result.failed.length
      notify(`已上传 ${result.uploaded.length} 个` + (failed > 0 ? `，${failed} 个失败：${result.failed[0].message}` : ''), failed > 0 ? 'error' : 'ok')
    } catch (error) {
      const message = String(error?.message || error)
      notify(error.code === 'E_CLOUD_DISABLED' ? '还没配置云端：去「云端」页填好 COS 信息' : '上传失败：' + message, 'error')
    } finally {
      setState({ busy: '' })
    }
  }

  function downloadItem(item) {
    // 用隐藏 <a download> 触发保存：window.open 在 Electron 里会另开窗口，体验更差
    try {
      const anchor = document.createElement('a')
      anchor.href = API + '/download?id=' + encodeURIComponent(item.id)
      anchor.download = item.name
      anchor.rel = 'noopener'
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      anchor.click()
      setTimeout(() => anchor.remove(), 1000)
    } catch (error) {
      notify('下载失败：' + String(error?.message || error), 'error')
    }
  }

  /** 在系统文件管理器里定位这个文件。 */
  async function revealItem(item) {
    try {
      await rpc('/reveal', { id: item.id })
    } catch (error) {
      notify('打开位置失败：' + String(error?.message || error), 'error')
    }
  }

  /** 从云端拉回本地：配置了默认下载目录就直接落盘，否则先问用户。 */
  async function downloadCloud(items) {
    const list = Array.isArray(items) ? items : [items]
    if (list.length === 0) return

    const defaultDir = String(state.cloud.config?.downloadDir || '')
    let targetDir = defaultDir
    if (defaultDir === '') {
      const choice = await chooseDirectory()
      if (choice.supported === true && choice.ok !== true) {
        if (choice.cancelled !== true) notify('选择目录失败：' + (choice.error || '未知原因'), 'error')
        return
      }
      if (choice.ok === true) targetDir = choice.dir
      // 选择器不可用：不弹错误，退回宿主默认位置并说明
      if (choice.supported === false && choice.error) {
        notify('系统目录选择器不可用，已保存到原文件旁边（可在云端配置里设默认下载目录）', 'info')
      }
    }

    setState({ busy: 'download' })
    try {
      const body = { ids: list.map((item) => item.id) }
      if (targetDir !== '') body.targetDir = targetDir
      const result = await rpc('/cloud/download', body)
      await loadItems(true)
      const failed = result.failed.length
      const first = result.downloaded[0]
      notify(
        `已下载 ${result.downloaded.length} 个` + (first !== undefined ? '（' + first.path + '）' : '')
          + (failed > 0 ? `，${failed} 个失败：${result.failed[0].message}` : ''),
        failed > 0 ? 'error' : 'ok',
      )
    } catch (error) {
      notify('下载失败：' + String(error?.message || error), 'error')
    } finally {
      setState({ busy: '' })
    }
  }

  /** 删除远端副本（默认关闭，需在云端配置里打开「允许删除远端对象」）。 */
  async function deleteRemoteItems(ids) {
    setState({ busy: 'remote-delete', dialog: null })
    try {
      const result = await rpc('/cloud/delete-remote', { ids })
      await loadItems(true)
      await loadStatus()
      const failed = result.failed.length
      notify(
        `已删除 ${result.removed.length} 个远端副本` + (failed > 0 ? `，${failed} 个失败：${result.failed[0].message}` : ''),
        failed > 0 ? 'error' : 'ok',
      )
    } catch (error) {
      notify('删除远端失败：' + String(error?.message || error), 'error')
    } finally {
      setState({ busy: '' })
    }
  }

  async function saveCloudConfig(form) {
    setState({ cloud: Object.assign({}, state.cloud, { busy: true, feedback: '', feedbackTone: '' }) })
    try {
      const data = await rpc('/cloud/config', Object.assign({ save: true }, form))
      setState({ cloud: Object.assign({}, state.cloud, { config: data.config, busy: false, feedback: '配置已保存', feedbackTone: 'ok' }) })
      await loadStatus()
      if (data.config.enabled) await loadItems(true)
    } catch (error) {
      setState({ cloud: Object.assign({}, state.cloud, { busy: false, feedback: String(error?.message || error), feedbackTone: 'error' }) })
    }
  }

  async function testCloud() {
    setState({ cloud: Object.assign({}, state.cloud, { testing: true, testResult: null }) })
    try {
      const data = await rpc('/cloud/test')
      setState({ cloud: Object.assign({}, state.cloud, { testing: false, testResult: { ok: true, text: `连通正常 · ${data.bucket} · ${data.elapsedMs}ms` } }) })
    } catch (error) {
      setState({ cloud: Object.assign({}, state.cloud, { testing: false, testResult: { ok: false, text: String(error?.message || error) } }) })
    }
  }

  /** 清掉「记录还在、文件没了」的孤儿记录（只删本地记录，不动桶里的对象）。 */
  async function purgeOrphans() {
    try {
      const data = await rpc('/cloud/orphans', { purge: true })
      await loadStatus()
      await loadItems(true)
      notify('已清理 ' + (data.removed ?? 0) + ' 条无效记录', 'ok')
    } catch (error) {
      notify('清理失败：' + String(error?.message || error), 'error')
    }
  }

  async function reconcileCloud() {
    setState({ cloud: Object.assign({}, state.cloud, { busy: true, reconcile: null }) })
    try {
      const data = await rpc('/cloud/reconcile')
      setState({ cloud: Object.assign({}, state.cloud, { busy: false, reconcile: data }) })
    } catch (error) {
      setState({ cloud: Object.assign({}, state.cloud, { busy: false, feedback: String(error?.message || error), feedbackTone: 'error' }) })
    }
  }

  async function saveSettings(patch) {
    try {
      const next = await rpc('/settings', patch)
      setState({ settings: next })
      await loadItems(true)
      await loadStatus()
      notify('设置已保存', 'ok')
    } catch (error) {
      notify('设置保存失败：' + String(error?.message || error), 'error')
    }
  }

  /** 立即跑一轮自动同步（范围与定时那套一致：只重传已同步过、本地改过的）。 */
  async function runAutoSync() {
    try {
      const data = await rpc('/cloud/autosync', { runNow: true })
      await loadItems(true)
      await loadStatus()
      const last = data?.last ?? { uploaded: 0, failed: 0, candidates: 0 }
      if (last.uploaded === 0 && last.failed === 0) {
        notify('没有需要同步的文件', 'info')
      } else {
        notify(`已同步 ${last.uploaded} 个` + (last.failed > 0 ? `，失败 ${last.failed} 个` : ''), last.failed > 0 ? 'error' : 'ok')
      }
    } catch (error) {
      notify('同步失败：' + String(error?.message || error), 'error')
    }
  }

  /**
   * 静默重载：别的会话刚写了文件时，页面不用手动刷新也能自己更新。
   * 不碰 phase / loadingItems，所以不闪骨架屏；用户正开着菜单/弹层时直接跳过。
   */
  async function reloadQuiet() {
    if (state.phase !== 'ready' || state.loadingItems) return
    if (state.menuId !== null || state.dialog !== null || state.preview !== null) return
    try {
      const data = await rpc('/items', Object.assign({}, currentFilters(), {
        offset: 0,
        limit: Math.min(200, Math.max(48, state.items.length)),
        // 轮询时主动要一次增量扫描：否则会卡在 15 秒的陈旧窗口里，感觉「不自动刷新」
        fresh: true,
      }))
      if (state.phase !== 'ready') return
      setState({
        items: data.items,
        total: data.total,
        hasMore: data.hasMore,
        offset: data.items.length,
        facets: data.facets,
        // 选中集合保留：文件还在就还选着，被外部删掉的自然消失
        lastRefreshAt: Date.now(),
      })
    } catch { /* 静默失败：下一轮再试，不打扰用户 */ }
  }

  // =========================================================================
  // 小组件
  // =========================================================================

  function KindBadge({ kind }) {
    return h('span', {
      className: 'ap-badge',
      style: { color: KIND_HUE[kind] || KIND_HUE.other },
      title: KIND_LABEL[kind] || kind,
    }, KIND_LABEL[kind] || kind)
  }

  function CheckBox({ on, onToggle, label }) {
    return h('button', {
      type: 'button',
      className: 'ap-check',
      'data-on': String(Boolean(on)),
      'aria-label': label,
      'aria-pressed': String(Boolean(on)),
      title: on ? '取消选择' : '选择',
      onClick: (event) => { event.stopPropagation(); onToggle() },
    }, on ? h(Icon, { size: 13, strokeWidth: 2.2 }, I.check()) : null)
  }

  function CloudBadge({ state: cloudState }) {
    // 「仅本地」不显示角标：云端一旦启用，每张卡片都挂一个灰角标只会制造噪音
    if (cloudState === undefined || cloudState === 'disabled' || cloudState === 'local-only') return null
    const tone = cloudState === 'synced' ? 'synced' : cloudState === 'conflict' ? 'conflict' : null
    return h('span', { className: 'ap-badge', 'data-tone': tone || undefined, title: CLOUD_LABEL[cloudState] || cloudState },
      cloudState === 'synced' ? h(Icon, { size: 10, strokeWidth: 2.2 }, I.check()) : null,
      CLOUD_LABEL[cloudState] || cloudState)
  }

  /**
   * 卡片右上角的 ⋯ 菜单 —— 只放「改动」类操作。
   * 预览 / 下载 / 打开位置都在预览弹层里，菜单里不再重复。
   */
  function CardMenu({ item, onClose, anchor }) {
    const s = useStore()
    const cloudEnabled = s.cloud.config?.enabled === true
    const synced = item.cloud?.state === 'synced'
    const menuRef = React.useRef(null)
    // 菜单打开后把焦点放到第一项：这样 ↑/↓ 立刻可用（role=menu 的常规行为）
    React.useEffect(() => {
      if (anchor === undefined || anchor === null) return
      const menu = menuRef.current
      if (menu === null) return
      const first = menu.querySelector('.ap-menuItem:not([disabled])')
      if (first !== null) first.focus()
    }, [anchor])
    const style = anchor === undefined || anchor === null
      ? { right: 6, top: 34 }
      : { left: anchor.left, top: anchor.top, maxHeight: anchor.maxHeight }
    return h('div', {
      className: 'ap-menu',
      role: 'menu',
      ref: menuRef,
      style,
      onMouseDown: (event) => event.stopPropagation(),
      onClick: (event) => event.stopPropagation(),
      // role=menu 就该能用方向键走：↑/↓ 在可点项之间移动，Home/End 跳首尾
      onKeyDown: (event) => {
        const items = [...event.currentTarget.querySelectorAll('.ap-menuItem:not([disabled])')]
        if (items.length === 0) return
        const current = items.indexOf(document.activeElement)
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          const next = current < 0 ? (step > 0 ? 0 : items.length - 1) : (current + step + items.length) % items.length
          items[next].focus()
          return
        }
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          items[event.key === 'Home' ? 0 : items.length - 1].focus()
        }
      },
    },
      h('button', {
        type: 'button', role: 'menuitem', className: 'ap-menuItem',
        onClick: () => { onClose(); setState({ dialog: { type: 'rename', item, value: item.name } }) },
      }, h(Icon, { size: 13 }, I.rename()), '重命名'),
      h('div', { className: 'ap-menuSep' }),
      // 云端动作按状态只留一个：冲突时「拉回云端那份」，没传过才「上传」，已同步就没什么可做的
      item.cloud?.state === 'conflict'
        ? h('button', {
            type: 'button', role: 'menuitem', className: 'ap-menuItem',
            title: '本地改过了，把云端那份拉回来（会另存一份，不覆盖本地）',
            onClick: () => { onClose(); downloadCloud([item]) },
          }, h(Icon, { size: 13 }, I.remote()), '从云端下载')
        : synced
          ? null
          : h('button', {
              type: 'button', role: 'menuitem', className: 'ap-menuItem',
              disabled: !cloudEnabled,
              title: cloudEnabled ? '' : '云端未配置',
              onClick: () => { onClose(); uploadCloud([item]) },
            }, h(Icon, { size: 13 }, I.cloud()), '上传到云端'),
      synced && s.cloud.config?.allowRemoteDelete === true
        ? h('button', {
            type: 'button', role: 'menuitem', className: 'ap-menuItem', 'data-danger': 'true',
            onClick: () => {
              onClose()
              setState({ dialog: { type: 'remote-delete', ids: [item.id], title: '删除「' + item.name + '」的远端副本？' } })
            },
          }, h(Icon, { size: 13 }, I.cloud()), '删除远端副本')
        : null,
      h('div', { className: 'ap-menuSep' }),
      h('button', { type: 'button', role: 'menuitem', className: 'ap-menuItem', onClick: () => { onClose(); doArchive([item]) } },
        h(Icon, { size: 13 }, I.archive()), '归档'),
      item.archived === true ? h('button', {
        type: 'button', role: 'menuitem', className: 'ap-menuItem',
        onClick: () => { onClose(); cleanSession(item) },
      }, h(Icon, { size: 13 }, I.trash()), '清理原目录') : null,
      h('button', {
        type: 'button', role: 'menuitem', className: 'ap-menuItem', 'data-danger': 'true',
        onClick: () => { onClose(); requestDelete([item]) },
      }, h(Icon, { size: 13 }, I.trash()), '删除'))
  }

  function Card({ item }) {
    const s = useStore()
    const selected = s.selected.includes(item.id)
    const menuOpen = s.menuId === item.id
    const isImage = item.kind === 'image' && typeof item.thumb === 'string'
    return h('article', {
      className: 'ap-card',
      'data-selected': String(selected),
      'data-item-id': item.id,
      style: { '--ap-hue': KIND_HUE[item.kind] || KIND_HUE.other },
    },
      h(CheckBox, { on: selected, onToggle: () => toggleSelected(item.id), label: '选择 ' + item.name }),
      h('div', { className: 'ap-cardTools', 'data-open': String(menuOpen) },
        h('button', {
          type: 'button', className: 'ap-tool ap-toolPreview', 'aria-label': '预览', title: '预览',
          onClick: (event) => { event.stopPropagation(); openPreview(item) },
        }, h(Icon, { size: 14 }, I.eye())),
        h('button', {
          type: 'button', className: 'ap-tool ap-more', 'aria-label': '更多操作', 'aria-expanded': String(menuOpen),
          onClick: (event) => { event.stopPropagation(); toggleMenu(event, item, menuOpen) },
        }, h(Icon, { size: 15, viewBox: '0 0 24 24' }, I.more()))),
      menuOpen ? h(CardMenu, { item, anchor: s.menuAnchor, onClose: () => setState({ menuId: null }) }) : null,
      h('div', {
        className: 'ap-thumb',
        role: 'button',
        tabIndex: 0,
        'aria-label': '预览 ' + item.name,
        title: '点击预览',
        onClick: () => openPreview(item),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openPreview(item)
          }
        },
      },
        isImage
          ? h('img', { src: item.thumb, alt: item.title || item.name, loading: 'lazy', draggable: false })
          : h('div', { className: 'ap-thumbGlyph' },
            h(KindGlyph, { kind: item.kind, size: 32 }),
            h('span', { className: 'ap-thumbKind' }, KIND_LABEL[item.kind] || item.kind)),
        h('span', { className: 'ap-thumbScrim' }),
        // 角标放进缩略图内：不再和左上角的选择框抢位置
        h('div', { className: 'ap-badges' },
          item.role !== undefined && item.role !== 'deliverable'
            ? h('span', { className: 'ap-badge', 'data-tone': 'role' }, ROLE_LABEL[item.role] || item.role)
            : null,
          item.archived === true ? h('span', { className: 'ap-badge', 'data-tone': 'archived' }, '已归档') : null,
          h(CloudBadge, { state: item.cloud?.state }))),
      h('div', { className: 'ap-cardBody' },
        h('div', { className: 'ap-name', title: item.name }, displayName(item)),
        h('div', { className: 'ap-path', title: pathLabel(item) }, pathLabel(item)),
        h('div', { className: 'ap-meta' },
          // 文件名占左侧可伸缩区，日期与大小贴右侧；两者靠留白区分，不再加分隔点
          h('span', { className: 'ap-metaText', title: item.path }, item.name),
          h('span', null, timeLabel(item.mtime)),
          h('span', { className: 'ap-metaSep' }, '·'),
          h('span', null, humanBytes(item.size)))))
  }

  function Row({ item }) {
    const s = useStore()
    const selected = s.selected.includes(item.id)
    const menuOpen = s.menuId === item.id
    const isImage = item.kind === 'image' && typeof item.thumb === 'string'
    return h('div', {
      className: 'ap-row',
      'data-selected': String(selected),
      'data-item-id': item.id,
      style: { '--ap-hue': KIND_HUE[item.kind] || KIND_HUE.other },
    },
      h('button', {
        type: 'button', className: 'ap-rowCheck', 'data-on': String(selected),
        'aria-label': '选择 ' + item.name, 'aria-pressed': String(selected),
        onClick: () => toggleSelected(item.id),
      }, selected ? h(Icon, { size: 12, strokeWidth: 2.4 }, I.check()) : null),
      h('div', { className: 'ap-rowGlyph', onDoubleClick: () => openPreview(item) },
        isImage ? h('img', { src: item.thumb, alt: '', loading: 'lazy' }) : h(KindGlyph, { kind: item.kind, size: 17 })),
      h('div', { className: 'ap-rowMain', onDoubleClick: () => openPreview(item) },
        h('div', { className: 'ap-rowName', title: item.name }, displayName(item)),
        h('div', { className: 'ap-rowSub', title: pathLabel(item) + '/' + item.name },
          pathLabel(item) + ' / ' + item.name,
          item.archived === true ? ' · 已归档' : '',
          item.cloud?.state && item.cloud.state !== 'disabled' && item.cloud.state !== 'local-only'
            ? ' · ' + (CLOUD_LABEL[item.cloud.state] || item.cloud.state)
            : '')),
      h('div', { className: 'ap-rowMeta' }, timeLabel(item.mtime) + ' · ' + humanBytes(item.size)),
      h('div', { className: 'ap-rowActions', style: { position: 'relative' } },
        h('button', {
          type: 'button', className: 'ap-iconbtn', 'aria-label': '预览', title: '预览',
          onClick: () => openPreview(item),
        }, h(Icon, { size: 14 }, I.eye())),
        h('button', {
          type: 'button', className: 'ap-iconbtn', 'aria-label': '更多操作', 'aria-expanded': String(menuOpen),
          onClick: (event) => toggleMenu(event, item, menuOpen),
        }, h(Icon, { size: 14 }, I.more())),
        menuOpen ? h(CardMenu, { item, anchor: s.menuAnchor, onClose: () => setState({ menuId: null }) }) : null))
  }

  // =========================================================================
  // 预览 / 对话框
  // =========================================================================

  function Preview() {
    const s = useStore()
    const preview = s.preview
    const close = () => setState({ preview: null })
    React.useEffect(() => {
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          setState({ preview: null })
        }
      }
      window.addEventListener('keydown', onKey, true)
      return () => window.removeEventListener('keydown', onKey, true)
    }, [])
    if (preview === null) return null
    const item = preview.item
    const data = preview.data
    const isImage = item.kind === 'image'

    let body
    if (preview.loading) {
      body = h('div', { className: 'ap-binary' }, h(Icon, { size: 22 }, I.refresh()), '读取中…')
    } else if (preview.error !== '') {
      body = h('div', { className: 'ap-binary' },
        h(Icon, { size: 26 }, I.info()),
        h('div', { className: 'ap-emptyTitle' }, '预览失败'),
        h('div', { className: 'ap-emptyDesc' }, preview.error))
    } else if (isImage) {
      body = h('div', { className: 'ap-imgWrap' }, h('img', { src: API + '/raw?id=' + encodeURIComponent(item.id), alt: item.title || item.name }))
    } else if (data !== null && data.binary === false) {
      body = h('pre', { className: 'ap-pre' }, data.content + (data.truncated ? '\n\n…（已截断，只显示前 256 KB）' : ''))
    } else {
      body = h('div', { className: 'ap-binary' },
        h(KindGlyph, { kind: item.kind, size: 44 }),
        h('div', { className: 'ap-emptyTitle' }, KIND_LABEL[item.kind] + ' · ' + humanBytes(item.size)),
        h('div', { className: 'ap-emptyDesc' }, '这类文件不做内联预览，可以下载后用本机应用打开。'),
        h('button', { type: 'button', className: 'ap-btn ap-btn--primary', onClick: () => downloadItem(item) },
          h(Icon, { size: 13 }, I.download()), '下载'))
    }

    return h('div', { className: 'ap-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget) close() } },
      h('div', { className: 'ap-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': item.name },
        h('div', { className: 'ap-modalHead' },
          h('div', { className: 'ap-modalTitles' },
            h('div', { className: 'ap-modalTitle' }, item.name),
            h('div', { className: 'ap-modalSub' },
              [
                item.scope === 'shared' ? '共享' : (item.sessionTitle || item.session),
                dirOf(item.path),
                KIND_LABEL[item.kind],
                humanBytes(item.size),
                timeLabel(item.mtime),
              ].filter((part) => typeof part === 'string' && part !== '').join(' · ')),
            preview.data?.cloudKey
              ? h('button', {
                  type: 'button',
                  className: 'ap-modalCloud',
                  title: '云端对象 key，点击复制',
                  onClick: () => copyText(preview.data.cloudKey, '已复制云端路径'),
                }, h(Icon, { size: 11 }, I.cloud()), preview.data.cloudKey)
              : null),
          h('button', { type: 'button', className: 'ap-iconbtn', 'aria-label': '关闭', onClick: close },
            h(Icon, { size: 15 }, I.close()))),
        h('div', { className: 'ap-modalBody' }, body),
        h('div', { className: 'ap-modalFoot' },
          h('button', { type: 'button', className: 'ap-btn', onClick: () => downloadItem(item) },
            h(Icon, { size: 13 }, I.download()), '下载'),
          // 云端条目：菜单里不再放「从云端下载」，改到这里 —— 预览时最清楚自己要的是哪一份
          preview.data?.cloudKey
            ? h('button', {
                type: 'button', className: 'ap-btn',
                title: '把云端那份重新拉回本地（可选目录）',
                onClick: () => { close(); downloadCloud([item]) },
              }, h(Icon, { size: 13 }, I.cloud()), '从云端下载')
            : null,
          h('button', {
            type: 'button', className: 'ap-btn',
            onClick: () => revealItem(item),
          }, h(Icon, { size: 13 }, I.folder()), '打开所在位置'),
          h('div', { className: 'ap-spacer' }),
          h('button', {
            type: 'button',
            className: 'ap-pathBtn',
            title: '点击复制完整路径',
            onClick: () => {
              const abs = preview.data?.abs ?? ''
              if (abs === '') return
              copyText(abs, '已复制路径')
            },
          }, preview.data?.abs ?? item.id))))
  }

  // =========================================================================
  // 整理模式：按目录批量把文件归到 产物 / 过程 / 记忆
  // =========================================================================

  async function openCurate(append) {
    const offset = append === true ? state.curate.items.length : 0
    setState({ curate: Object.assign({}, state.curate, { open: true, loading: append !== true }) })
    try {
      // role=all 才能看到过程/记忆；人工标注过的即使不在扫描范围里也会回来
      const data = await rpc('/items', { role: 'all', limit: 200, offset, sort: 'mtime', order: 'desc' })
      const items = append === true ? state.curate.items.concat(data.items) : data.items
      setState({
        curate: {
          open: true, loading: false, items,
          total: data.total, truncated: data.hasMore === true,
        },
      })
    } catch (error) {
      setState({ curate: { open: false, loading: false, items: [], total: 0, truncated: false } })
      notify('读取文件列表失败：' + String(error?.message || error), 'error')
    }
  }

  async function setRoles(ids, role) {
    if (!Array.isArray(ids) || ids.length === 0) return
    try {
      await rpc('/artifacts/roles', { ids, role })
      // 重新拉一遍：角色变了会导致条目进出列表（扫描开关按角色过滤）
      await openCurate()
      await loadItems(true)
      await loadStatus()
    } catch (error) {
      notify('设置角色失败：' + String(error?.message || error), 'error')
    }
  }

  function CurateModal() {
    const s = useStore()
    const curate = s.curate
    const [focused, setFocused] = React.useState(-1)
    const [query, setQuery] = React.useState('')

    // 键盘：J/K（或 ↑/↓）移动，1/2/3 直接设角色，和列表顺序一致
    React.useEffect(() => {
      if (curate.open !== true) return undefined
      const onKey = (event) => {
        const tag = event.target?.tagName ?? ''
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
        if (event.key === 'j' || event.key === 'ArrowDown') {
          event.preventDefault()
          setFocused((index) => Math.min(curate.items.length - 1, index + 1))
          return
        }
        if (event.key === 'k' || event.key === 'ArrowUp') {
          event.preventDefault()
          setFocused((index) => Math.max(0, index - 1))
          return
        }
        const role = { 1: 'deliverable', 2: 'scratch', 3: 'memory', 4: 'asset' }[event.key]
        if (role !== undefined) {
          const item = curate.items[focused]
          if (item !== undefined) {
            event.preventDefault()
            setRoles([item.id], role)
          }
        }
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [curate.open, curate.items, focused])

    if (curate.open !== true) return null
    const close = () => setState({ curate: { open: false, loading: false, items: [], total: 0, truncated: false } })

    // 搜索只在已加载的条目里过滤：整理时通常按名字找，不需要再打一次后端
    const needle = query.trim().toLowerCase()
    const visible = needle === ''
      ? curate.items
      : curate.items.filter((item) => (
        String(item.name).toLowerCase().includes(needle)
        || String(item.path).toLowerCase().includes(needle)
        || String(item.sessionTitle ?? '').toLowerCase().includes(needle)
      ))

    // 按「会话 · 目录」分组：批量操作以目录为单位最省事
    const groups = new Map()
    for (const item of visible) {
      const dir = dirOf(item.path)
      const key = `${item.sessionTitle || item.session || '共享'} · ${dir === '' ? '根目录' : dir}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }
    const focusedItem = curate.items[focused]

    return h('div', { className: 'ap-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget) close() } },
      h('div', { className: 'ap-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '整理产物' },
        h('div', { className: 'ap-modalHead' },
          h('div', { className: 'ap-modalTitles' },
            h('div', { className: 'ap-modalTitle' }, '整理'),
            h('div', { className: 'ap-modalSub' },
              `已加载 ${curate.items.length}/${curate.total ?? curate.items.length} 个`
                + ` · 当前显示 ${visible.length} · 人工标注 ${s.status?.roles?.manual ?? 0}`)),
          h('button', { type: 'button', className: 'ap-iconbtn', 'aria-label': '关闭', onClick: close },
            h(Icon, { size: 15 }, I.close()))),
        h('div', { className: 'ap-curateSearch' },
          h('input', {
            className: 'ap-input', type: 'search', value: query,
            placeholder: '按文件名 / 路径筛选…', 'aria-label': '筛选文件',
            onChange: (event) => { setQuery(event.target.value); setFocused(-1) },
          })),
        h('div', { className: 'ap-modalBody ap-curateBody' },
          curate.loading
            ? h('div', { className: 'ap-loading' }, h('div', { className: 'ap-skelRow' },
              Array.from({ length: 6 }).map((_, index) => h('div', { key: index, className: 'ap-skel' }))))
            : visible.length === 0
              ? h('div', { className: 'ap-hint', style: { padding: '16px 4px' } }, '没有匹配的文件')
              : [...groups.entries()].map(([key, list]) => h('div', { key, className: 'ap-curateGroup' },
              h('div', { className: 'ap-curateHead' },
                h('span', { className: 'ap-curateTitle' }, key, h('span', { className: 'ap-chipCount' }, list.length)),
                h('span', { className: 'ap-spacer' }),
                h('button', { type: 'button', className: 'ap-btn ap-btn--ghost ap-btn--sm', onClick: () => setRoles(list.map((item) => item.id), 'deliverable') }, '全设产物'),
                h('button', { type: 'button', className: 'ap-btn ap-btn--ghost ap-btn--sm', onClick: () => setRoles(list.map((item) => item.id), 'scratch') }, '全设过程'),
                h('button', { type: 'button', className: 'ap-btn ap-btn--ghost ap-btn--sm', onClick: () => setRoles(list.map((item) => item.id), null) }, '恢复自动')),
              list.map((item) => h('div', {
                key: item.id,
                className: 'ap-curateRow',
                'data-focused': String(focusedItem?.id === item.id),
                onClick: () => setFocused(curate.items.indexOf(item)),
              },
                h('span', { className: 'ap-curateName', title: item.path }, item.name),
                h('span', { className: 'ap-curateMeta' }, KIND_LABEL[item.kind] || item.kind, ' · ', humanBytes(item.size)),
                item.roleSource === 'manual' ? h('span', { className: 'ap-badge', 'data-tone': 'role' }, '人工') : null,
                h('span', { className: 'ap-spacer' }),
                ['deliverable', 'scratch', 'memory', 'asset'].map((role) => h('button', {
                  key: role, type: 'button', className: 'ap-roleBtn',
                  'data-active': String(item.role === role),
                  'data-role': role,
                  onClick: () => setRoles([item.id], role),
                }, ROLE_LABEL[role]))) )))),
        h('div', { className: 'ap-modalFoot' },
          h('span', { className: 'ap-hint' }, '改动即时生效；J/K 移动、1/2/3/4 设角色；「恢复自动」按路径规则重新判定。'),
          h('div', { className: 'ap-spacer' }),
          curate.items.length < (curate.total ?? 0)
            ? h('button', {
                type: 'button', className: 'ap-btn', disabled: curate.loading,
                onClick: () => openCurate(true),
              }, '加载更多（' + curate.items.length + '/' + (curate.total ?? 0) + '）')
            : null,
          h('button', { type: 'button', className: 'ap-btn ap-btn--primary', onClick: close }, '完成'))))
  }

  /** 使用说明：把 README 里最需要解释的四个概念搬到界面里，省得用户去翻仓库。 */
  function HelpModal() {
    const s = useStore()
    if (s.helpOpen !== true) return null
    const close = () => setState({ helpOpen: false })
    const section = (title, lines) => h('section', { className: 'ap-helpSection' },
      h('h3', null, title),
      h('ul', null, lines.map((line, index) => h('li', { key: index }, line))))

    return h('div', { className: 'ap-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget) close() } },
      h('div', { className: 'ap-modal ap-modal--sm', role: 'dialog', 'aria-modal': 'true', 'aria-label': '使用说明' },
        h('div', { className: 'ap-modalHead' },
          h('div', { className: 'ap-modalTitles' },
            h('div', { className: 'ap-modalTitle' }, '这个页面在管什么'),
            h('div', { className: 'ap-modalSub' }, '四个角色 · 三种扫描 · 云端是可选的')),
          h('button', { type: 'button', className: 'ap-iconbtn', 'aria-label': '关闭', onClick: close },
            h(Icon, { size: 15 }, I.close()))),
        h('div', { className: 'ap-modalBody ap-modalBody--pad ap-helpBody' },
          section('四个角色（决定默认看不看、备不备份）', [
            '产物：你要交付的东西，默认视图只显示它，也是默认备份范围。',
            '过程：测试脚本、截图、夹具。默认收起来；在「设置 → 扫描类型」打开「会话」才会索引。',
            '记忆：MEMORY / PERSONA / HANDOFF 这类上下文文件，和交付物分开。',
            '素材：你放进来的输入（参考图、样例数据），不会上传到云端。',
          ]),
          section('三种扫描类型', [
            '产物 + 记忆 默认开启；「会话」默认关闭——它会把会话目录里的脚本和截图也收进来（噪声大）。',
            '主工作区有 sessions/ 时只扫 sessions/ 与 artifacts/，外加根目录的散文件；其它项目目录要单独「添加工作区」。',
          ]),
          section('云端（可选，默认关闭）', [
            '需要自己填 COS 的桶 / 区域 / 密钥；密钥只写进 DSH 凭据，不落在工作区。',
            '上传永远手动点。自动同步默认关闭，开启后也只重传「已传过、但本地改过」的文件。',
            '过程与素材永不上传；备份范围可选「仅产物」或「产物 + 记忆」。',
          ]),
          section('快捷键', [
            '整理模式：J / K 移动，1 / 2 / 3 / 4 设成 产物 / 过程 / 记忆 / 素材。',
            '菜单与弹层：Esc 关闭；Enter 打开预览。',
          ])),
        h('div', { className: 'ap-modalFoot' },
          h('span', { className: 'ap-hint' }, '完整说明与截图在仓库 README 里。'),
          h('div', { className: 'ap-spacer' }),
          h('button', { type: 'button', className: 'ap-btn ap-btn--primary', onClick: close }, '知道了'))))
  }

  function Dialog() {
    const s = useStore()
    const dialog = s.dialog
    const [value, setValue] = React.useState('')
    React.useEffect(() => {
      if (dialog !== null && dialog.type === 'rename') setValue(dialog.value || '')
    }, [dialog])
    if (dialog === null) return null
    const close = () => setState({ dialog: null })

    if (dialog.type === 'rename') {
      const submit = () => {
        const name = value.trim()
        if (name === '' || name === dialog.item.name) { close(); return }
        doRename(dialog.item, name)
      }
      return h('div', { className: 'ap-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget) close() } },
        h('div', { className: 'ap-modal ap-modal--sm', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'ap-modalHead' },
            h('div', { className: 'ap-modalTitles' },
              h('div', { className: 'ap-modalTitle' }, '重命名'),
              h('div', { className: 'ap-modalSub' }, dialog.item.path))),
          h('div', { className: 'ap-modalBody ap-modalBody--pad' },
            h('div', { className: 'ap-field' },
              h('label', { className: 'ap-label', htmlFor: 'ap-rename' }, '新文件名'),
              h('input', {
                id: 'ap-rename', className: 'ap-input', value,
                autoFocus: true,
                onChange: (event) => setValue(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submit()
                  if (event.key === 'Escape') close()
                },
              })),
            h('div', { className: 'ap-hint', style: { marginTop: 8 } }, '只改文件名，不移动位置；带 / 的目标会被拒绝。')),
          h('div', { className: 'ap-modalFoot' },
            h('div', { className: 'ap-spacer' }),
            h('button', { type: 'button', className: 'ap-btn ap-btn--ghost', onClick: close, autoFocus: true }, '取消'),
            h('button', { type: 'button', className: 'ap-btn ap-btn--primary', onClick: submit, disabled: value.trim() === '' }, '保存'))))
    }

    if (dialog.type === 'delete') {
      return h('div', { className: 'ap-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget) close() } },
        h('div', { className: 'ap-modal ap-modal--sm', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'ap-modalHead' },
            h('div', { className: 'ap-modalTitles' },
              h('div', { className: 'ap-modalTitle' }, dialog.title),
              h('div', { className: 'ap-modalSub' }, dialog.body))),
          h('div', { className: 'ap-modalBody ap-modalBody--pad' },
            h('div', { className: 'ap-hint' }, '文件会进回收站，可以再还原。彻底删除才不可恢复。')),
          h('div', { className: 'ap-modalFoot' },
            h('div', { className: 'ap-spacer' }),
            h('button', { type: 'button', className: 'ap-btn ap-btn--ghost', onClick: close, autoFocus: true }, '取消'),
            h('button', {
              type: 'button', className: 'ap-btn ap-btn--danger', disabled: s.busy === 'delete',
              onClick: () => confirmDelete(dialog.items),
            }, '移入回收站'))))
    }

    if (dialog.type === 'purge') {
      return h('div', { className: 'ap-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget) close() } },
        h('div', { className: 'ap-modal ap-modal--sm', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'ap-modalHead' },
            h('div', { className: 'ap-modalTitles' },
              h('div', { className: 'ap-modalTitle' }, dialog.title || '彻底删除？'),
              h('div', { className: 'ap-modalSub' }, dialog.body || ''))),
          h('div', { className: 'ap-modalBody ap-modalBody--pad' },
            h('div', { className: 'ap-hint', 'data-tone': 'warn' }, '这一步不可恢复：文件会从磁盘上真的消失。')),
          h('div', { className: 'ap-modalFoot' },
            h('div', { className: 'ap-spacer' }),
            h('button', { type: 'button', className: 'ap-btn ap-btn--ghost', onClick: close, autoFocus: true }, '取消'),
            h('button', {
              type: 'button', className: 'ap-btn ap-btn--danger',
              onClick: () => (dialog.all === true ? emptyTrash() : confirmPurge(dialog.ids)),
            }, dialog.all === true ? '清空回收站' : '彻底删除'))))
    }

    if (dialog.type === 'remote-delete') {
      return h('div', { className: 'ap-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget) close() } },
        h('div', { className: 'ap-modal ap-modal--sm', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'ap-modalHead' },
            h('div', { className: 'ap-modalTitles' },
              h('div', { className: 'ap-modalTitle' }, dialog.title || '删除远端副本？'),
              h('div', { className: 'ap-modalSub' }, '只删云端对象，本地文件保留'))),
          h('div', { className: 'ap-modalBody ap-modalBody--pad' },
            h('div', { className: 'ap-hint' }, '删除后这个条目在「云端」tab 里会消失，本地仍然可用。')),
          h('div', { className: 'ap-modalFoot' },
            h('div', { className: 'ap-spacer' }),
            h('button', { type: 'button', className: 'ap-btn ap-btn--ghost', onClick: close, autoFocus: true }, '取消'),
            h('button', {
              type: 'button', className: 'ap-btn ap-btn--danger',
              disabled: s.busy === 'remote-delete',
              onClick: () => deleteRemoteItems(dialog.ids),
            }, '删除远端'))))
    }
    return null
  }

  // =========================================================================
  // 头部 / 筛选
  // =========================================================================

  function Header() {
    const s = useStore()
    const settingsRef = React.useRef(null)

    React.useEffect(() => {
      if (!s.settingsOpen) return
      const onDown = (event) => {
        if (settingsRef.current !== null && !settingsRef.current.contains(event.target)) setState({ settingsOpen: false })
      }
      const onKey = (event) => { if (event.key === 'Escape') setState({ settingsOpen: false }) }
      window.addEventListener('mousedown', onDown)
      window.addEventListener('keydown', onKey)
      return () => {
        window.removeEventListener('mousedown', onDown)
        window.removeEventListener('keydown', onKey)
      }
    }, [s.settingsOpen])

    return h('header', { className: 'ap-head' },
      h('div', { className: 'ap-titles' },
        h('h1', { className: 'ap-title' }, '我的产物'),
        h('p', { className: 'ap-sub' }, '你的创作都在这里，随时回来继续编辑')),
      h('div', { className: 'ap-headActions', ref: settingsRef, style: { position: 'relative' } },
        h('div', { className: 'ap-search' },
          h(Icon, { size: 13 }, I.search()),
          h('input', {
            type: 'search',
            value: s.q,
            placeholder: '搜索文件… 支持 type:code / role:scratch',
            'aria-label': '搜索文件',
            title: '支持 type:doc,image / role:memory / session:<目录名>，可与关键词混用',
            spellCheck: false,
            onChange: (event) => {
              const q = event.target.value
              setState({ q })
              if (searchTimer) clearTimeout(searchTimer)
              searchTimer = setTimeout(() => loadItems(true), 260)
            },
            onKeyDown: (event) => {
              if (event.key === 'Escape') { setState({ q: '' }); loadItems(true) }
            },
          }),
          s.q === '' ? null : h('button', {
            type: 'button', className: 'ap-search-clear', 'aria-label': '清除搜索', title: '清除搜索',
            onClick: () => { setState({ q: '' }); loadItems(true) },
          }, '✕')),
        h('button', {
          type: 'button', className: 'ap-iconbtn', 'aria-label': '刷新索引', title: '刷新索引',
          disabled: s.busy === 'refresh',
          onClick: doRefreshIndex,
        }, h(Icon, { size: 14 }, I.refresh())),
        h('button', {
          type: 'button', className: 'ap-btn ap-btn--ghost ap-curateBtn', title: '把文件归到产物/过程/记忆',
          onClick: () => openCurate(),
        }, h(Icon, { size: 13 }, I.box()), '整理'),
        h('button', {
          type: 'button', className: 'ap-iconbtn', 'aria-label': '使用说明', title: '使用说明',
          onClick: () => setState({ helpOpen: true }),
        }, h(Icon, { size: 15 }, I.help())),
        h('button', {
          type: 'button', className: 'ap-iconbtn', 'aria-label': '设置', title: '设置',
          'aria-expanded': String(s.settingsOpen),
          onClick: () => setState({ settingsOpen: !s.settingsOpen }),
        }, h(Icon, { size: 15 }, I.gear())),
        s.settingsOpen ? h('div', { className: 'ap-pop ap-pop--wide', style: { right: 0, top: 38 } },
          h('div', { className: 'ap-popTitle' }, '工作区'),
          h('div', { className: 'ap-rootList' },
            (s.settings.roots || []).map((entry) => h('div', { key: entry.path, className: 'ap-rootRow' },
              h('span', { className: 'ap-rootPath', title: entry.path }, entry.path),
              entry.primary === true ? h('span', { className: 'ap-rootTag' }, '主') : null,
              h('button', {
                type: 'button', className: 'ap-iconbtn ap-iconbtn--sm',
                'aria-label': '移除工作区', title: '移除',
                disabled: entry.primary === true,
                onClick: () => saveSettings({ roots: (s.settings.roots || []).filter((item) => item.path !== entry.path) }),
              }, h(Icon, { size: 12 }, I.close()))))),
          h('button', {
            type: 'button', className: 'ap-btn ap-btn--ghost', style: { marginTop: 6 },
            onClick: async () => {
              const choice = await chooseDirectory()
              if (choice.ok !== true) {
                if (choice.supported === false) notify('这个环境打不开系统目录选择器', 'info')
                return
              }
              const existing = (s.settings.roots || []).map((item) => ({ path: item.path, label: item.label, primary: item.primary }))
              if (existing.some((item) => item.path === choice.dir)) { notify('这个目录已经在列表里了', 'info'); return }
              saveSettings({ roots: existing.concat([{ path: choice.dir }]) })
            },
          }, h(Icon, { size: 12 }, I.folder()), '添加工作区…'),

          h('div', { className: 'ap-popTitle', style: { marginTop: 14 } }, '扫描类型'),
          h('div', { className: 'ap-scanList' },
            [['deliverable', '产物', '交付物（默认视图 / 默认备份范围）'],
              ['memory', '记忆', 'MEMORY / PERSONA / HANDOFF'],
              ['session', '会话', '会话目录里的过程文件：脚本、截图、夹具']].map(([key, label, hint]) => h('label', {
              key, className: 'ap-checkRow', title: hint,
            },
              h('input', {
                type: 'checkbox', 'aria-label': '扫描' + label,
                checked: (s.settings.scan || {})[key] === true,
                onChange: (event) => saveSettings({ scan: Object.assign({}, s.settings.scan, { [key]: event.target.checked }) }),
              }),
              label,
              h('span', { className: 'ap-hint' }, hint)))),

          h('div', { className: 'ap-popTitle', style: { marginTop: 14 } }, '备份'),
          h('div', { className: 'ap-popRow' },
            h('span', { className: 'ap-label', title: '过程 / 素材永不上传' }, '备份范围'),
            h('select', {
              className: 'ap-select', 'aria-label': '备份范围',
              value: s.settings.backup?.scope || 'deliverable',
              onChange: (event) => saveSettings({ backup: { scope: event.target.value } }),
            },
              h('option', { value: 'deliverable' }, '仅产物'),
              h('option', { value: 'deliverable+memory' }, '产物 + 记忆'))),
          h('div', { className: 'ap-popRow', style: { alignItems: 'flex-start' } },
            h('span', { className: 'ap-label', title: '只重传「已传过、但本地改过」的文件' }, '自动同步'),
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } },
              h('label', { className: 'ap-checkRow' },
                h('input', {
                  type: 'checkbox', 'aria-label': '自动同步', checked: s.settings.autoSync?.enabled === true,
                  onChange: (event) => saveSettings({ autoSync: Object.assign({}, s.settings.autoSync, { enabled: event.target.checked }) }),
                }), '开'),
              h('select', {
                className: 'ap-select', 'aria-label': '同步间隔', value: String(s.settings.autoSync?.intervalMinutes || 15),
                disabled: s.settings.autoSync?.enabled !== true,
                onChange: (event) => saveSettings({ autoSync: Object.assign({}, s.settings.autoSync, { intervalMinutes: Number(event.target.value) }) }),
              }, [5, 15, 30, 60].map((minutes) => h('option', { key: minutes, value: String(minutes) }, minutes + ' 分钟'))),
              h('button', { type: 'button', className: 'ap-btn ap-btn--ghost ap-btn--sm', onClick: runAutoSync }, '立即同步'))),
          s.status?.autoSync === undefined ? null : h('div', { className: 'ap-hint', style: { marginTop: 4 } },
            s.status.autoSync.last?.at > 0
              ? `上次同步 ${timeLabel(s.status.autoSync.last.at)} · 传了 ${s.status.autoSync.last.uploaded} 个`
                + (s.status.autoSync.last.failed > 0 ? ` · 失败 ${s.status.autoSync.last.failed}` : '')
                + ` · 待同步 ${s.status.autoSync.candidates}`
                + (s.status.autoSync.orphans > 0 ? ` · 失效 ${s.status.autoSync.orphans}（去云端页清理）` : '')
              : `还没跑过 · 待同步 ${s.status.autoSync.candidates} 个`),

          h('div', { className: 'ap-popTitle', style: { marginTop: 14 } }, '显示与清理'),
          h('label', { className: 'ap-checkRow', style: { marginTop: 6 } },
            h('input', {
              type: 'checkbox', 'aria-label': '显示其他文件', checked: s.settings.showOthers === true,
              onChange: (event) => saveSettings({ showOthers: event.target.checked }),
            }),
            '显示其他文件',
            h('span', { className: 'ap-hint' }, '（.log / .db 之类）')),
          h('div', { className: 'ap-popRow' },
            h('span', { className: 'ap-label' }, '回收站保留'),
            h('select', {
              className: 'ap-select', 'aria-label': '回收站保留', value: s.settings.trashRetention,
              onChange: (event) => saveSettings({ trashRetention: event.target.value }),
            },
              h('option', { value: '7' }, '7 天'),
              h('option', { value: '30' }, '30 天'),
              h('option', { value: 'forever' }, '永久'))),
          s.status === null ? null : h('div', { className: 'ap-hint', style: { marginTop: 10 } },
            '共 ', String(s.status.items ?? 0), ' 个文件 · 回收站 ', humanBytes(s.status.trash?.bytes || 0))) : null))
  }

  function Tabs() {
    const s = useStore()
    const cloudEnabled = s.cloud.config?.enabled === true
    // tab 上的数字是「总量」，不随当前筛选变化 —— 否则切到云端 tab 后本地数会跟着漂
    const tabs = [
      { key: 'local', label: '本地', count: s.status?.items ?? s.facets?.total },
      { key: 'cloud', label: '云端', count: cloudEnabled ? (s.status?.cloud?.uploaded || undefined) : '未配置' },
      { key: 'trash', label: '回收站', count: s.trash.items.length },
    ]
    return h('nav', { className: 'ap-tabs', role: 'tablist', 'aria-label': '产物分类' },
      tabs.map((tab) => {
        const active = s.tab === tab.key
        return h('button', {
          key: tab.key,
          type: 'button',
          className: 'ap-tab',
          role: 'tab',
          'aria-selected': String(active),
          'data-active': String(active),
          tabIndex: active ? 0 : -1,
          onClick: () => {
            if (tab.key === 'cloud' && !cloudEnabled) {
              setState({ tab: 'cloud' })
              loadCloudConfig()
              return
            }
            setState({ tab: tab.key, selected: [], menuId: null })
            if (tab.key === 'trash') loadTrash()
            if (tab.key === 'cloud') loadCloudConfig()
            if (tab.key === 'local') loadItems(true)
          },
        }, tab.label,
          tab.count === undefined || tab.count === 0 ? null : h('span', { className: 'ap-tabCount' }, tab.count))
      }))
  }

  /**
   * 两排筛选：
   *   第一排 —— 角色（产物 / 全部 / 过程 / 记忆）：回答「要不要留、要不要备份」
   *   第二排 —— 类型（文档 / 表格 / 图片 …）：回答「是什么格式」，只显示结果里出现过的
   */
  function Filters() {
    const s = useStore()
    const roleChips = [
      { key: 'deliverable', label: '产物' },
      { key: 'all', label: '全部' },
      { key: 'scratch', label: '过程' },
      { key: 'memory', label: '记忆' },
      { key: 'asset', label: '素材' },
    ]
    const roleCount = (key) => (key === 'all'
      ? Object.values(s.byRole || {}).reduce((sum, value) => sum + value, 0)
      : (s.byRole?.[key] || 0))
    const typeChips = [{ key: 'all', label: '全部类型' }].concat(
      PRIMARY_KINDS.map((kind) => ({ key: kind, label: KIND_LABEL[kind] })),
    )
    const moreActive = SECONDARY_KINDS.includes(s.kind)
    const scan = s.settings?.scan || {}
    return h('div', { className: 'ap-filters' },
      h('div', { className: 'ap-filterRow' },
        h('div', { className: 'ap-chips', role: 'group', 'aria-label': '按角色筛选' },
          roleChips.map((chip) => h('button', {
            key: chip.key, type: 'button', className: 'ap-chip',
            'data-active': String(s.role === chip.key),
            'aria-pressed': String(s.role === chip.key),
            'data-role': chip.key,
            title: chip.key === 'scratch' && scan.session !== true ? '会话目录里的测试脚本/截图，需要先在设置里打开「会话」扫描' : undefined,
            onClick: () => setState({ role: chip.key, kind: 'all', selected: [] }),
          }, chip.label, roleCount(chip.key) > 0 ? h('span', { className: 'ap-chipCount' }, roleCount(chip.key)) : null))),
        h('div', { className: 'ap-spacer' }),
        // 只有配了多个工作区才显示根筛选：单个根时它是纯噪音
        (s.settings?.roots || []).length > 1
          ? h('select', {
              className: 'ap-select',
              'aria-label': '工作区',
              value: s.root,
              onChange: (event) => setState({ root: event.target.value, selected: [] }),
            },
              h('option', { value: 'all' }, '全部工作区'),
              (s.settings.roots || []).map((entry) => h('option', {
                key: entry.path,
                value: entry.primary === true ? 'primary' : '@' + entry.label,
              }, entry.primary === true ? entry.label + '（主）' : entry.label)))
          : null,
        h('div', { className: 'ap-seg', role: 'group', 'aria-label': '来源' },
          [['all', '全部'], ['session', '会话'], ['shared', '共享']].map(([key, label]) => h('button', {
            key, type: 'button', className: 'ap-segBtn',
            'data-active': String(s.scope === key),
            'aria-pressed': String(s.scope === key),
            onClick: () => setState({ scope: key, selected: [] }),
          }, label))),
        h('select', {
          className: 'ap-select',
          value: s.sort + ':' + s.order,
          'aria-label': '排序',
          onChange: (event) => {
            const [sort, order] = event.target.value.split(':')
            setState({ sort, order })
          },
        },
          h('option', { value: 'mtime:desc' }, '最近修改'),
          h('option', { value: 'mtime:asc' }, '最早修改'),
          h('optgroup', { label: '创建时间' },
            h('option', { value: 'created:desc' }, '最近创建'),
            h('option', { value: 'created:asc' }, '最早创建')),
          h('option', { value: 'name:asc' }, '名称 A→Z'),
          h('option', { value: 'size:desc' }, '从大到小'),
          h('option', { value: 'size:asc' }, '从小到大')),
        // 像相册一样按 年/月/日 分组；按名称或大小排序时分组没有意义，直接禁用
        s.sort === 'mtime' || s.sort === 'created'
          ? h('select', {
              className: 'ap-select',
              'aria-label': '分组',
              title: '按时间分组（只对时间排序生效）',
              value: s.group,
              onChange: (event) => setState({ group: event.target.value }),
            },
              h('option', { value: 'none' }, '不分组'),
              h('option', { value: 'year' }, '按年'),
              h('option', { value: 'month' }, '按月'),
              h('option', { value: 'day' }, '按日'))
          : null,
        h('button', {
          type: 'button', className: 'ap-iconbtn',
          'aria-label': s.view === 'grid' ? '切换为列表' : '切换为网格',
          title: s.view === 'grid' ? '切换为列表' : '切换为网格',
          onClick: () => setState({ view: s.view === 'grid' ? 'list' : 'grid' }),
        }, h(Icon, { size: 14 }, s.view === 'grid' ? I.list() : I.grid()))),
      h('div', { className: 'ap-chips', role: 'group', 'aria-label': '按类型筛选' },
        typeChips.map((chip) => {
          const count = chip.key === 'all' ? s.facets.total : (s.facets.kind?.[chip.key] || 0)
          return h('button', {
            key: chip.key, type: 'button', className: 'ap-chip ap-chip--type',
            'data-active': String(s.kind === chip.key),
            'aria-pressed': String(s.kind === chip.key),
            onClick: () => setState({ kind: chip.key, selected: [] }),
          }, chip.label, count > 0 ? h('span', { className: 'ap-chipCount' }, count) : null)
        }),
        h('button', {
          type: 'button', className: 'ap-chip ap-chip--type',
          'data-active': String(moreActive),
          'aria-pressed': String(moreActive),
          'aria-expanded': String(s.moreOpen),
          onClick: () => setState({ moreOpen: !s.moreOpen }),
        }, moreActive ? KIND_LABEL[s.kind] : '更多',
          h('span', { className: 'ap-chipCount' }, '▾')),
        s.moreOpen ? SECONDARY_KINDS.map((kind) => h('button', {
          key: kind, type: 'button', className: 'ap-chip ap-chip--type',
          'data-active': String(s.kind === kind),
          onClick: () => setState({ kind, moreOpen: false, selected: [] }),
        }, KIND_LABEL[kind],
          (s.facets.kind?.[kind] || 0) > 0 ? h('span', { className: 'ap-chipCount' }, s.facets.kind[kind]) : null)) : null))
  }

  // =========================================================================
  // 三个面板
  // =========================================================================

  function EmptyState({ title, desc, action }) {
    return h('div', { className: 'ap-empty' },
      h('div', { className: 'ap-emptyIcon' }, h(Icon, { size: 42, strokeWidth: 1.2 }, I.empty())),
      h('div', { className: 'ap-emptyTitle' }, title),
      desc === undefined ? null : h('div', { className: 'ap-emptyDesc' }, desc),
      action === undefined ? null : action)
  }

  /**
   * 条目区。`mode='cloud'` 时列表只含云端副本（宿主侧已过滤），
   * 空态文案和批量操作也换成云端语义。
   */
  function ItemsPanel({ mode }) {
    const s = useStore()
    const selected = selectedSet()
    const cloudMode = mode === 'cloud'
    const picked = () => s.items.filter((item) => selected.has(item.id))

    if (s.phase === 'loading') {
      return h('div', { className: 'ap-loading' },
        h('div', { className: 'ap-skelRow' },
          Array.from({ length: 8 }).map((_, index) => h('div', { key: index, className: 'ap-skel' }))))
    }
    if (s.phase === 'error') {
      return h(EmptyState, {
        title: '读取产物失败',
        desc: s.error,
        action: h('button', { type: 'button', className: 'ap-btn', onClick: () => loadItems(true) }, '重试'),
      })
    }
    if (s.items.length === 0) {
      const filtered = s.q.trim() !== '' || s.kind !== 'all' || s.scope !== 'all'
      const scan = s.settings?.scan || {}
      const allScanOff = scan.deliverable !== true && scan.memory !== true && scan.session !== true
      // 工作区都不对时，「还没有产物」会误导人 —— 直接说清楚解析到了哪儿
      const rootBroken = filtered !== true && s.status !== null
        && (s.settings?.roots || []).length === 0 && s.status.workspaceHasSessions === false
      const nothingScanned = filtered !== true && allScanOff
      const hiddenScratch = filtered !== true && s.role === 'deliverable' && (s.byRole?.scratch || 0) === 0
        && scan.session !== true
      if (cloudMode) {
        return h(EmptyState, {
          title: filtered ? '云端没有匹配的产物' : '云端还没有产物',
          desc: filtered
            ? '换个关键词，或把类型/来源切回「全部」。'
            : '云端上传永远是手动的：到「本地」勾选文件后点「上传云端」，或用卡片右上角 ⋯ 菜单里的单文件上传。',
          action: filtered
            ? h('button', {
                type: 'button', className: 'ap-btn',
                onClick: () => { setState({ q: '', kind: 'all', scope: 'all' }); loadItems(true) },
              }, '清空筛选')
            : h('button', {
                type: 'button', className: 'ap-btn ap-btn--primary',
                onClick: () => setState({ tab: 'local', selected: [] }),
              }, '去本地挑文件'),
        })
      }
      return h(EmptyState, {
        title: filtered
          ? '没有匹配的产物'
          : nothingScanned
            ? '没有勾选扫描类型'
            : hiddenScratch
              ? '还没有产物'
              : rootBroken ? '这个工作区里没有产物目录' : '还没有产物',
        desc: filtered
          ? '换个关键词，或把类型/来源切回「全部」。'
          : nothingScanned
            ? '到右上角「设置 → 扫描类型」里至少勾一个（默认是「产物 + 记忆」）。'
            : hiddenScratch
              ? '只显示交付物。测试脚本、截图这类过程文件在「会话」扫描里，打开设置即可看到。'
              : rootBroken
                ? '当前工作区 ' + s.status.workspace + ' 下没有 sessions/，也没有配置其它工作区。到「设置 → 工作区」里添加放产物的目录。'
                : '会话里生成的文件会自动出现在这里；也可以在「设置 → 工作区」里添加任意目录。',
        action: filtered || nothingScanned
          ? h('button', {
              type: 'button', className: 'ap-btn',
              onClick: () => { setState({ q: '', kind: 'all', scope: 'all', role: 'deliverable' }); loadItems(true) },
            }, '清空筛选')
          // 空态给出口，而不是只让用户「再扫一次」：整理模式、添加工作区、看说明
          : h('div', { className: 'ap-emptyActions' },
              h('button', { type: 'button', className: 'ap-btn ap-btn--primary', onClick: () => openCurate() }, '打开整理'),
              h('button', {
                type: 'button', className: 'ap-btn',
                onClick: async () => {
                  const choice = await chooseDirectory()
                  if (choice.ok !== true) {
                    if (choice.supported === false) notify('这个环境打不开系统目录选择器', 'info')
                    return
                  }
                  const existing = (s.settings.roots || []).map((entry) => ({ path: entry.path, label: entry.label, primary: entry.primary }))
                  if (existing.some((entry) => entry.path === choice.dir)) { notify('这个目录已经在列表里了', 'info'); return }
                  saveSettings({ roots: existing.concat([{ path: choice.dir }]) })
                },
              }, h(Icon, { size: 13 }, I.folder()), '添加工作区'),
              h('button', { type: 'button', className: 'ap-btn ap-btn--ghost', onClick: () => setState({ helpOpen: true }) }, '这是怎么算的？'),
              h('button', { type: 'button', className: 'ap-btn ap-btn--ghost', onClick: doRefreshIndex }, '重新扫描')),
      })
    }

    // 时间分组：按「修改」或「创建」把条目切成 年/月/日 段，像手机相册那样
    const timeSort = s.sort === 'mtime' || s.sort === 'created'
    const granularity = timeSort ? s.group : 'none'
    const stampOf = (item) => (s.sort === 'created' ? (item.born ?? item.mtime) : item.mtime)
    const renderList = (list) => (s.view === 'grid'
      ? h('div', { className: 'ap-grid' }, list.map((item) => h(Card, { key: item.id, item })))
      : h('div', { className: 'ap-list' }, list.map((item) => h(Row, { key: item.id, item }))))

    let view
    if (granularity === 'none') {
      view = renderList(s.items)
    } else {
      const sections = new Map()
      for (const item of s.items) {
        const key = groupKeyOf(stampOf(item), granularity)
        if (!sections.has(key)) sections.set(key, [])
        sections.get(key).push(item)
      }
      view = h(React.Fragment, null, [...sections.entries()].map(([key, list]) => h('section', {
        key, className: 'ap-group', 'data-group': key,
      },
        h('div', { className: 'ap-groupHead' },
          h('span', { className: 'ap-groupTitle' }, groupLabelOf(key, granularity)),
          // 还有没加载的条目时加个「+」：否则 74 条里只显示「48 个」会让人以为统计错了
          h('span', { className: 'ap-groupCount' }, list.length + (s.hasMore ? '+' : '') + ' 个')),
        renderList(list))))
    }

    return h(React.Fragment, null,
      view,
      s.hasMore ? h('button', {
        type: 'button', className: 'ap-btn ap-more-btn', disabled: s.loadingItems,
        onClick: () => loadItems(false),
      }, s.loadingItems ? '加载中…' : `加载更多（已显示 ${s.items.length}/${s.total}）`) : null,
      selected.size === 0 ? null : h('div', { className: 'ap-selbar', role: 'status' },
        // 分母用总数而不是当前页：否则「已选 3 / 共 48」会让人以为总共只有 48 个
        h('span', { className: 'ap-selCount' }, '已选 ' + selected.size + ' ', h('span', null, '/ ' + (s.total || s.items.length))),
        cloudMode
          ? h(React.Fragment, null,
              h('button', {
                type: 'button', className: 'ap-btn',
                onClick: () => downloadCloud(picked()),
              }, h(Icon, { size: 13 }, I.remote()), s.cloud.config?.downloadDir ? '从云端下载' : '从云端下载…'),
              h('button', {
                type: 'button', className: 'ap-btn ap-btn--danger',
                disabled: s.cloud.config?.allowRemoteDelete !== true,
                title: s.cloud.config?.allowRemoteDelete === true ? '' : '先在云端配置里打开「允许删除远端对象」',
                onClick: () => setState({
                  dialog: {
                    type: 'remote-delete',
                    ids: picked().map((item) => item.id),
                    title: '删除选中的 ' + selected.size + ' 个远端副本？',
                  },
                }),
              }, h(Icon, { size: 13 }, I.cloud()), '删除远端'))
          : h(React.Fragment, null,
              h('button', {
                type: 'button', className: 'ap-btn',
                onClick: () => doArchive(picked()),
              }, h(Icon, { size: 13 }, I.archive()), '归档'),
              h('button', {
                type: 'button', className: 'ap-btn',
                disabled: s.cloud.config?.enabled !== true,
                title: s.cloud.config?.enabled === true ? '' : '云端未配置',
                onClick: () => uploadCloud(picked()),
              }, h(Icon, { size: 13 }, I.cloud()), '上传云端'),
              h('button', {
                type: 'button', className: 'ap-btn ap-btn--danger',
                onClick: () => requestDelete(picked()),
              }, h(Icon, { size: 13 }, I.trash()), '删除')),
        h('button', {
          type: 'button', className: 'ap-btn ap-btn--ghost', 'aria-label': '取消选择',
          onClick: () => setState({ selected: [] }),
        }, '取消')))
  }

  function TrashPanel() {
    const s = useStore()
    const selected = selectedSet()
    const retention = s.trash.retention || s.settings.trashRetention
    return h(React.Fragment, null,
      h('div', { className: 'ap-panel' },
        h('div', { className: 'ap-panelHead' },
          h('span', { className: 'ap-panelTitle' }, '回收站'),
          h('span', { className: 'ap-hint' }, s.trash.items.length + ' 项 · ' + humanBytes(s.trash.bytes)),
          h('div', { className: 'ap-spacer' }),
          h('div', { className: 'ap-retention' },
            h('span', { className: 'ap-label' }, '保留'),
            h('select', {
              className: 'ap-select', value: retention, 'aria-label': '回收站保留期',
              onChange: (event) => saveSettings({ trashRetention: event.target.value }),
            },
              h('option', { value: '7' }, '7 天'),
              h('option', { value: '30' }, '30 天'),
              h('option', { value: 'forever' }, '永久')),
            h('button', {
              type: 'button', className: 'ap-btn ap-btn--ghost',
              onClick: () => loadTrash(),
            }, h(Icon, { size: 13 }, I.refresh()), '刷新'),
            h('button', {
              type: 'button', className: 'ap-btn ap-btn--danger', disabled: s.trash.items.length === 0,
              onClick: () => setState({ dialog: { type: 'purge', all: true, title: '清空回收站？', body: '共 ' + s.trash.items.length + ' 项，' + humanBytes(s.trash.bytes) } }),
            }, '清空'))),
        h('div', { className: 'ap-hint', style: { marginTop: 6 } },
          retention === 'forever'
            ? '永久保留：不会自动清理，占用会一直累积到手动清空。'
            : `到期自动清理：删除超过 ${RETENTION_LABEL[retention]} 的条目会在宿主启动时和每天清一次。`)),
      s.trash.items.length === 0
        ? h(EmptyState, {
            title: '回收站是空的',
            desc: '删除的东西会先放在这里，随时可以还原。',
          })
        : h('div', { className: 'ap-list' }, s.trash.items.map((entry) => {
            const checked = selected.has(entry.id)
            return h('div', { key: entry.id, className: 'ap-row', 'data-selected': String(checked), style: { '--ap-hue': KIND_HUE.other } },
              h('button', {
                type: 'button', className: 'ap-rowCheck', 'data-on': String(checked),
                'aria-label': '选择 ' + entry.name, 'aria-pressed': String(checked),
                onClick: () => toggleSelected(entry.id),
              }, checked ? h(Icon, { size: 12, strokeWidth: 2.4 }, I.check()) : null),
              h('div', { className: 'ap-rowGlyph' }, h(Icon, { size: 16 }, I.trash())),
              h('div', { className: 'ap-rowMain' },
                h('div', { className: 'ap-rowName' }, entry.name),
                h('div', { className: 'ap-rowSub' },
                  (entry.scope === 'shared' ? '共享' : '会话') + ' / ' + (entry.session || '根') + (entry.path !== entry.name ? ' / ' + dirOf(entry.path) : ''),
                  ' · 删除于 ' + relTime(entry.deletedAt))),
              h('div', { className: 'ap-rowMeta' }, humanBytes(entry.size)),
              h('div', { className: 'ap-rowActions', 'data-always': 'true' },
                h('button', {
                  type: 'button', className: 'ap-btn', onClick: () => restoreTrash([entry.id]),
                }, h(Icon, { size: 13 }, I.restore()), '还原'),
                h('button', {
                  type: 'button', className: 'ap-btn ap-btn--danger',
                  onClick: () => setState({ dialog: { type: 'purge', ids: [entry.id], title: '彻底删除「' + entry.name + '」？' } }),
                }, '彻底删除')))
          })),
      selected.size > 0 ? h('div', { className: 'ap-selbar', role: 'status' },
        h('span', { className: 'ap-selCount' }, '已选 ' + selected.size),
        h('button', {
          type: 'button', className: 'ap-btn', onClick: () => restoreTrash([...selected]),
        }, h(Icon, { size: 13 }, I.restore()), '还原'),
        h('button', {
          type: 'button', className: 'ap-btn ap-btn--danger',
          onClick: () => setState({ dialog: { type: 'purge', ids: [...selected], title: '彻底删除选中的 ' + selected.size + ' 项？' } }),
        }, '彻底删除'),
        h('button', { type: 'button', className: 'ap-btn ap-btn--ghost', onClick: () => setState({ selected: [] }) }, '取消')) : null)
  }

  function CloudConfigForm({ onCollapse }) {
    const s = useStore()
    const config = s.cloud.config || {}
    const [form, setForm] = React.useState({
      bucket: config.bucket || '',
      region: config.region || '',
      prefix: config.prefix || 'dsh/',
      secretId: '',
      secretKey: '',
      enabled: config.enabled === true,
      allowRemoteDelete: config.allowRemoteDelete === true,
      downloadDir: config.downloadDir || '',
    })
    React.useEffect(() => {
      setForm({
        bucket: config.bucket || '',
        region: config.region || '',
        prefix: config.prefix || 'dsh/',
        secretId: '',
        secretKey: '',
        enabled: config.enabled === true,
        allowRemoteDelete: config.allowRemoteDelete === true,
        downloadDir: config.downloadDir || '',
      })
    }, [config.bucket, config.region, config.prefix, config.enabled, config.allowRemoteDelete, config.downloadDir])

    const field = (key, label, placeholder, mono) => h('div', { className: 'ap-field' },
      h('label', { className: 'ap-label', htmlFor: 'ap-cloud-' + key }, label),
      h('input', {
        id: 'ap-cloud-' + key, className: 'ap-input', value: form[key],
        'data-mono': mono ? 'true' : undefined,
        placeholder, spellCheck: false, autoComplete: 'off',
        onChange: (event) => setForm(Object.assign({}, form, { [key]: event.target.value })),
      }))

    return h('div', { className: 'ap-panel' },
      h('div', { className: 'ap-panelHead' },
        h('span', { className: 'ap-panelTitle' }, '腾讯云 COS'),
        h('span', { className: 'ap-badge', 'data-tone': config.enabled ? 'synced' : undefined },
          config.enabled ? '已启用' : '未启用'),
        h('div', { className: 'ap-spacer' }),
        h('span', { className: 'ap-hint' }, '密钥只写进 DSH 凭据，不落在工作区'),
        typeof onCollapse === 'function'
          ? h('button', {
              type: 'button', className: 'ap-btn ap-btn--ghost', 'aria-expanded': 'true',
              title: '收起配置', onClick: onCollapse,
            }, h(Icon, { size: 13 }, I.chevronUp()), '收起')
          : null),
      h('div', { className: 'ap-panelDesc', style: { marginTop: 6 } },
        '云端是可选的：没配置时本地列表、预览、删除、归档完全不受影响；上传永远是手动点出来的，没有后台同步。'),
      h('div', { className: 'ap-form' },
        field('bucket', 'Bucket（name-appid）', 'mybucket-1250000000', true),
        field('region', 'Region', 'ap-guangzhou', true),
        field('prefix', '对象前缀', 'dsh/', true),
        h('div', { className: 'ap-field' },
          h('label', { className: 'ap-label', htmlFor: 'ap-cloud-secretId' },
            'SecretId', config.hasSecretId ? h('span', { className: 'ap-hint' }, '（已存 ' + config.secretIdTail + '）') : null),
          h('input', {
            id: 'ap-cloud-secretId', className: 'ap-input', 'data-mono': 'true',
            type: 'password', value: form.secretId, placeholder: config.hasSecretId ? '留空则不改' : 'AKID…',
            autoComplete: 'off', spellCheck: false,
            onChange: (event) => setForm(Object.assign({}, form, { secretId: event.target.value })),
          })),
        h('div', { className: 'ap-field' },
          h('label', { className: 'ap-label', htmlFor: 'ap-cloud-secretKey' },
            'SecretKey', config.hasSecretKey ? h('span', { className: 'ap-hint' }, '（已存 ' + config.secretKeyTail + '）') : null),
          h('input', {
            id: 'ap-cloud-secretKey', className: 'ap-input', 'data-mono': 'true',
            type: 'password', value: form.secretKey, placeholder: config.hasSecretKey ? '留空则不改' : '…',
            autoComplete: 'off', spellCheck: false,
            onChange: (event) => setForm(Object.assign({}, form, { secretKey: event.target.value })),
          })),
        h('div', { className: 'ap-field', style: { gridColumn: 'span 2' } },
          h('label', { className: 'ap-label', htmlFor: 'ap-cloud-downloadDir' },
            '默认下载目录',
            h('span', { className: 'ap-hint' }, form.downloadDir === '' ? '（留空 = 每次下载都问）' : '')),
          h('div', { className: 'ap-inputRow' },
            h('input', {
              id: 'ap-cloud-downloadDir', className: 'ap-input', 'data-mono': 'true',
              // 可手填：系统目录选择器不可用时（远程/权限受限）仍然能配
              value: form.downloadDir, placeholder: '例如 D:\\Downloads\\dsh-artifacts',
              spellCheck: false,
              onChange: (event) => setForm(Object.assign({}, form, { downloadDir: event.target.value })),
              title: '可以直接粘贴路径，或点「选择…」',
            }),
            h('button', {
              type: 'button', className: 'ap-btn',
              onClick: async () => {
                const choice = await chooseDirectory()
                if (choice.ok === true) {
                  setForm(Object.assign({}, form, { downloadDir: choice.dir }))
                  // 目录是配置的一部分，选完立刻保存，避免用户以为没生效
                  saveCloudConfig(Object.assign({}, form, { downloadDir: choice.dir }))
                } else if (choice.supported === false) {
                  // 选择器不可用不该像报错：提示用户直接填路径
                  notify('这个环境打不开系统目录选择器，可以直接在输入框里粘贴路径', 'info')
                } else if (choice.cancelled !== true) {
                  notify('选择目录失败：' + (choice.error || '未知原因'), 'error')
                }
              },
            }, h(Icon, { size: 13 }, I.folder()), '选择…'),
            form.downloadDir === '' ? null : h('button', {
              type: 'button', className: 'ap-btn ap-btn--ghost',
              onClick: () => setForm(Object.assign({}, form, { downloadDir: '' })),
            }, '清除')))),
      h('div', { className: 'ap-actions' },
        h('label', { className: 'ap-checkRow' },
          h('input', {
            type: 'checkbox', checked: form.enabled,
            onChange: (event) => setForm(Object.assign({}, form, { enabled: event.target.checked })),
          }), '启用云端'),
        h('label', { className: 'ap-checkRow' },
          h('input', {
            type: 'checkbox', checked: form.allowRemoteDelete,
            onChange: (event) => setForm(Object.assign({}, form, { allowRemoteDelete: event.target.checked })),
          }), '允许删除远端对象'),
        h('div', { className: 'ap-spacer' }),
        s.cloud.testResult === null ? null : h('span', {
          className: 'ap-hint',
          'data-tone': s.cloud.testResult.ok ? 'ok' : 'error',
        }, s.cloud.testResult.text),
        h('button', {
          type: 'button', className: 'ap-btn',
          disabled: s.cloud.testing || config.enabled !== true,
          title: config.enabled === true ? '' : '先保存并启用',
          onClick: testCloud,
        }, s.cloud.testing ? '测试中…' : '测试连接'),
        h('button', {
          type: 'button', className: 'ap-btn ap-btn--primary', disabled: s.cloud.busy,
          onClick: () => saveCloudConfig(form),
        }, s.cloud.busy ? '保存中…' : '保存配置')),
      s.cloud.feedback === '' ? null : h('div', { className: 'ap-hint', 'data-tone': s.cloud.feedbackTone, style: { marginTop: 10 } }, s.cloud.feedback))
  }

  /** 折叠态：一行说清「连的是哪个桶、传了几个」。 */
  function CloudConfigSlim() {
    const s = useStore()
    const config = s.cloud.config || {}
    return h('div', { className: 'ap-panel ap-panel--slim' },
      h('div', { className: 'ap-panelHead' },
        h('span', { className: 'ap-panelTitle' }, '腾讯云 COS'),
        h('span', { className: 'ap-badge', 'data-tone': config.enabled ? 'synced' : undefined }, config.enabled ? '已启用' : '未启用'),
        h('div', { className: 'ap-spacer' }),
        h('span', { className: 'ap-hint' }, config.enabled
          ? `${config.bucket} · ${config.region} · 前缀 ${config.prefix}`
          : '还没配置'),
        h('button', {
          type: 'button', className: 'ap-btn',
          'aria-expanded': 'false',
          onClick: () => setState({ cloud: Object.assign({}, s.cloud, { configOpen: true }) }),
        }, h(Icon, { size: 13 }, I.chevronDown()), '展开配置')))
  }

  function CloudPanel() {
    const s = useStore()
    const enabled = s.cloud.config?.enabled === true
    const configOpen = s.cloud.configOpen === null ? !enabled : s.cloud.configOpen === true
    // 有云端记录、但对应文件不在当前扫描范围（多为「过程」文件）时，说明一下，
    // 否则「云端 N」和列表对不上会让人以为数据丢了
    const orphanCloud = s.status?.cloud?.orphans ?? 0
    const hiddenCloud = Math.max(0, (s.status?.cloud?.recordedTotal ?? 0) - (s.status?.cloud?.uploaded ?? 0) - orphanCloud)
    return h(React.Fragment, null,
      configOpen
        ? h(CloudConfigForm, { onCollapse: () => setState({ cloud: Object.assign({}, s.cloud, { configOpen: false }) }) })
        : h(CloudConfigSlim),
      hiddenCloud > 0
        ? h('div', { className: 'ap-notice' },
            h(Icon, { size: 13 }, I.info()),
            h('span', null, '另有 ', String(hiddenCloud), ' 个云端记录对应的文件当前不在扫描范围（多半是「过程」文件）。要到「设置 → 扫描类型」里打开「会话」才能看到它们。'))
        : null,
      // 文件被删/挪走，但云端记录还在：给一个明确的清理入口
      orphanCloud > 0
        ? h('div', { className: 'ap-notice' },
            h(Icon, { size: 13 }, I.info()),
            h('span', null, '有 ', String(orphanCloud), ' 条云端记录对应的本地文件已不在（删除或移出扫描范围），记录还在。'),
            h('button', {
              type: 'button', className: 'ap-btn ap-btn--ghost ap-btn--sm',
              onClick: () => purgeOrphans(),
            }, '清理记录'))
        : null,
      enabled
        ? h('div', { className: 'ap-panel' },
            h('div', { className: 'ap-panelHead' },
              h('span', { className: 'ap-panelTitle' }, '云端对账'),
              h('div', { className: 'ap-spacer' }),
              h('button', { type: 'button', className: 'ap-btn', disabled: s.cloud.busy, onClick: reconcileCloud },
                h(Icon, { size: 13 }, I.refresh()), '开始对账')),
            s.cloud.reconcile === null
              ? h('div', { className: 'ap-panelDesc', style: { marginTop: 6 } }, '把远端对象和本地映射表比一遍：已同步 / 仅本地 / 冲突 / 仅远端。')
              : h('div', { className: 'ap-kv' },
                  h('span', null, '已同步 ', h('b', null, s.cloud.reconcile.counts.synced)),
                  h('span', null, '仅本地 ', h('b', null, s.cloud.reconcile.counts.localOnly)),
                  h('span', null, '冲突 ', h('b', null, s.cloud.reconcile.counts.conflicts)),
                  h('span', null, '仅远端 ', h('b', null, s.cloud.reconcile.counts.remoteOnly))))
        : null,
      enabled
        ? h(React.Fragment, null,
            h('div', { className: 'ap-panelHead', style: { margin: '18px 2px 0' } },
              h('span', { className: 'ap-panelTitle' }, '云端资源'),
              h('span', { className: 'ap-hint' }, '只列有云端副本的条目')),
            h(ItemsPanel, { mode: 'cloud' }))
        : h('div', { className: 'ap-panel' },
            h('div', { className: 'ap-panelHead' },
              h('span', { className: 'ap-panelTitle' }, '云端功能未启用'),
              h('div', { className: 'ap-spacer' }),
              h('span', { className: 'ap-hint' }, 'E_CLOUD_DISABLED')),
            h('div', { className: 'ap-panelDesc', style: { marginTop: 6 } },
              '没配置时这里不显示任何本地文件；本地的浏览、预览、删除、归档、回收站都不依赖云端。')))
  }

  // =========================================================================
  // 页面
  // =========================================================================

  function App() {
    const s = useStore()

    // 首屏：状态 + 云端配置；条目列表由下面的筛选 effect 负责，避免重复取两次
    React.useEffect(() => {
      loadStatus()
      loadCloudConfig()
      // 第一次用（没点过「知道了」）才显示引导条
      try {
        if (window.localStorage.getItem(ONBOARD_KEY) !== '1') setState({ firstRun: true })
      } catch { /* 隐私模式下 localStorage 可能不可用，直接不显示 */ }
    }, [])

    // 筛选变化 → 重新取（搜索自己带防抖，不走这里）
    React.useEffect(() => {
      if (s.tab === 'trash') return
      loadItems(true)
    }, [s.tab, s.role, s.kind, s.scope, s.root, s.sort, s.order])

    // 页面开着时每 8 秒静默对齐一次：别的会话刚写完文件，这里不用手动刷新就能看到
    React.useEffect(() => {
      if (s.tab !== 'local') return
      const tick = () => {
        if (document.visibilityState === 'visible') reloadQuiet()
      }
      const timer = setInterval(tick, 8000)
      document.addEventListener('visibilitychange', tick)
      return () => {
        clearInterval(timer)
        document.removeEventListener('visibilitychange', tick)
      }
    }, [s.tab])

    // 菜单点击外部 / 按 Esc 关闭
    React.useEffect(() => {
      if (s.menuId === null) return
      const onDown = (event) => {
        if (event.target.closest === undefined || event.target.closest('.ap-menu') === null) {
          if (event.target.closest === undefined || event.target.closest('.ap-more') === null) setState({ menuId: null })
        }
      }
      const onKey = (event) => { if (event.key === 'Escape') setState({ menuId: null }) }
      window.addEventListener('mousedown', onDown)
      // 用捕获阶段：宿主（DSH shell）会在冒泡阶段吞掉 Escape，冒泡监听收不到
      window.addEventListener('keydown', onKey, true)
      return () => {
        window.removeEventListener('mousedown', onDown)
        window.removeEventListener('keydown', onKey, true)
      }
    }, [s.menuId])

    // 预览 / 对话框 / 整理模式 / 帮助打开时按 Esc 关闭
    React.useEffect(() => {
      if (s.preview === null && s.dialog === null && s.curate.open !== true && s.helpOpen !== true) return
      const onKey = (event) => {
        if (event.key !== 'Escape') return
        if (s.helpOpen === true) {
          setState({ helpOpen: false })
          return
        }
        if (s.curate.open === true) {
          setState({ curate: { open: false, loading: false, items: [], total: 0, truncated: false } })
          return
        }
        setState({ preview: null, dialog: null })
      }
      // 同样用捕获阶段：shell 会吞掉冒泡阶段的 Escape
      window.addEventListener('keydown', onKey, true)
      return () => window.removeEventListener('keydown', onKey, true)
    }, [s.preview, s.dialog, s.curate.open, s.helpOpen])

    // 云端 tab 没有云端条目时，类型条只是一排 0，收起来更干净
    const showFilters = s.tab !== 'trash' && !(s.tab === 'cloud' && s.items.length === 0)

    const dismissFirstRun = () => {
      setState({ firstRun: false })
      try { window.localStorage.setItem(ONBOARD_KEY, '1') } catch { /* 隐私模式忽略 */ }
    }

    return h('div', { className: 'ap-root', role: 'region', 'aria-label': '我的产物' },
      h(Header),
      s.firstRun ? h('div', { className: 'ap-banner' },
        h(Icon, { size: 14 }, I.help()),
        h('span', { className: 'ap-bannerText' },
          '默认只显示', h('b', null, '产物'), '；过程（测试脚本、截图）和记忆在顶部切换。点右上角 ? 看完整说明。'),
        h('button', { type: 'button', className: 'ap-btn ap-btn--ghost ap-btn--sm', onClick: () => setState({ helpOpen: true }) }, '看说明'),
        h('button', { type: 'button', className: 'ap-iconbtn ap-iconbtn--sm', 'aria-label': '知道了', title: '知道了', onClick: dismissFirstRun },
          h(Icon, { size: 12 }, I.close()))) : null,
      h(Tabs),
      showFilters ? h(Filters) : null,
      h('div', { className: 'ap-body' },
        s.tab === 'trash' ? h(TrashPanel) : s.tab === 'cloud' ? h(CloudPanel) : h(ItemsPanel, { mode: 'local' })),
      h(Preview),
      h(Dialog),
      h(CurateModal),
      h(HelpModal),
      s.toast === null ? null : h('div', {
        className: 'ap-toast',
        'data-kind': s.toast.kind,
        'data-raised': String(s.selected.length > 0),
        role: 'status',
      }, s.toast.text))
  }

  // =========================================================================
  // 注册
  // =========================================================================

  /**
   * 两个落点：
   *   sidebar.panellist  list 槽位，id 就是 main panel key；
   *   main               keyed 槽位，点侧栏图标 → layout.selectPanel('artifacts') → 派发同名 key。
   */
  function registerUi(scope) {
    const slots = (scope === null || scope === undefined)
      ? undefined
      : ((scope.slots !== undefined) ? scope.slots : (typeof scope.get === 'function' ? scope.get('slots') : undefined))
    if (slots === undefined || slots === null) {
      console.error('[dsh-plugin-artifacts] 缺少 slots 服务，页面不注册')
      return
    }
    slots.inject('sidebar.panellist', () => slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 30,
      label: '我的产物',
    }, SidebarIcon))

    slots.inject('main', () => slots.register({
      name: 'main',
      key: PANEL_ID,
    }, App))
  }

  exports.apply = function apply(ctx) {
    installStyles()
    // 留一份客户端上下文：目录选择器（uiWorkspace）按需取，避免和加载顺序赌
    uiContext = ctx
    if (typeof ctx.inject === 'function') {
      ctx.inject(['slots'], registerUi)
      return
    }
    registerUi(ctx)
  }

  return exports
}})
