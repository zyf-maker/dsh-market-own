/**
 * DSH Market (own) — client half.
 *
 * Loaded by the host's module loader, which injects `require`. Only `react` is
 * required, deliberately: dshmarket additionally depends on four named exports
 * of the host's ui-primitives and disables itself when any is missing, so a host
 * older than rc.6 shows nothing at all. A market that renders its own markup
 * from one stable dependency keeps working across host versions.
 *
 * The half is hand-written in the loader's factory format rather than bundled,
 * because the format is small and a build step would add a toolchain to a plugin
 * whose entire job is to read JSON and render a list.
 *
 * Registration contract, taken from the host's own settings seat:
 *   ctx.slots.inject('settings.section', () => ctx.slots.register(descriptor, Component))
 * `descriptor` names the seat, gives the section an id and an order, and
 * `label()` supplies the navigation title.
 */
window.__ModuleLoader__.load({
  id: 'dsh-market-own',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    /** The host routes this half talks to. Distinguished from dshmarket's. */
    const API = '/dsh-market-own/api'
    const SECTION_ID = 'dsh-market-own'
    const ORDER = 41

    /** Copy, kept in one table so the section reads in either language. */
    const TEXT = {
      zh: {
        nav: '我的市场',
        search: '搜索插件 / 作者 / 描述…',
        sortScore: '综合分数',
        sortStars: 'Star 数',
        sortDownloads: '下载次数',
        sortName: '名称',
        allKinds: '全部目标',
        loading: '加载中…',
        retry: '重试',
        install: '安装',
        installing: '安装中…',
        installed: '已安装',
        failed: '失败',
        copied: '命令已复制',
        empty: '没有匹配的插件',
        unreachable: '目录加载失败',
        repaired: '已自动修复',
        installable: '可安装',
        needsEvidence: '未验证',
        footer: (n, total, when) => `${n} / ${total} 个插件 · 更新于 ${when}`,
      },
      en: {
        nav: 'My Market',
        search: 'Search plugins, authors, descriptions…',
        sortScore: 'Score',
        sortStars: 'Stars',
        sortDownloads: 'Downloads',
        sortName: 'Name',
        allKinds: 'All targets',
        loading: 'Loading…',
        retry: 'Retry',
        install: 'Install',
        installing: 'Installing…',
        installed: 'Installed',
        failed: 'Failed',
        copied: 'Command copied',
        empty: 'No matching plugins',
        unreachable: 'Catalog failed to load',
        repaired: 'Repaired automatically',
        installable: 'Installable',
        needsEvidence: 'Unverified',
        footer: (n, total, when) => `${n} / ${total} plugins · updated ${when}`,
      },
    }

    /** The host's locale service, or the Chinese table when it is unavailable. */
    function resolveText(ctx) {
      try {
        if (ctx.locale && typeof ctx.locale.get === 'function') {
          const current = ctx.locale.get()
          if (current === 'en' || current === 'en-US') return TEXT.en
        }
      } catch { /* a host without a locale service still renders */ }
      return TEXT.zh
    }

    const fmt = (n) => {
      const value = Number(n) || 0
      if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
      if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`
      return String(value)
    }

    /** One plugin card. */
    function Card({ plugin, index, text, onInstall, state }) {
      const description = (plugin.description && (plugin.description.zh || plugin.description.en)) || ''
      const buttonLabel = state === 'busy' ? text.installing : state === 'done' ? text.installed : state === 'error' ? text.failed : text.install
      return h('div', { className: 'dshmo-card' },
        h('div', { className: 'dshmo-rank' }, String(index + 1)),
        h('div', { className: 'dshmo-body' },
          h('div', { className: 'dshmo-title' },
            h('a', { href: plugin.url, target: '_blank', rel: 'noreferrer' }, plugin.name),
            plugin.owner ? h('span', { className: 'dshmo-owner' }, plugin.owner) : null,
          ),
          description ? h('div', { className: 'dshmo-desc' }, description) : null,
          h('div', { className: 'dshmo-meta' },
            h('span', { className: `dshmo-tag dshmo-tag-${plugin.targetKind ?? 'unknown'}` }, plugin.targetKind ?? 'unknown'),
            plugin.category ? h('span', { className: 'dshmo-tag' }, plugin.category) : null,
            plugin.installable === false ? h('span', { className: 'dshmo-tag dshmo-warn' }, text.needsEvidence) : null,
            h('span', { className: 'dshmo-num' }, `★ ${fmt(plugin.stars)}`),
            h('span', { className: 'dshmo-num' }, `↓ ${fmt(plugin.downloads)}`),
            h('span', { className: 'dshmo-num' }, `score ${fmt(plugin.score)}`),
          ),
        ),
        h('button', {
          type: 'button',
          className: 'dshmo-install',
          disabled: state === 'busy' || plugin.installable === false,
          onClick: () => onInstall(plugin),
        }, buttonLabel),
      )
    }

    /** The market section: search, sort, list, install. */
    function MarketSection(props) {
      const ctx = props.ctx
      const text = react.useMemo(() => resolveText(ctx), [ctx])
      const [query, setQuery] = react.useState('')
      const [sort, setSort] = react.useState('score')
      const [kind, setKind] = react.useState('')
      const [data, setData] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [status, setStatus] = react.useState(null)
      const [busy, setBusy] = react.useState({})

      const load = react.useCallback(async () => {
        setError(null)
        setStatus(text.loading)
        try {
          const params = new URLSearchParams({ sort, limit: '60' })
          if (query.trim() !== '') params.set('q', query.trim())
          if (kind !== '') params.set('kind', kind)
          const res = await fetch(`${API}/catalog?${params}`)
          const body = await res.json()
          if (body.error) {
            // A failed fetch is reported as a failure. Never as an empty market:
            // "no plugins" and "could not ask" must not look the same.
            setError(`${text.unreachable}: ${body.message ?? body.error}`)
            setData(null)
          } else {
            setData(body)
          }
        } catch (err) {
          setError(`${text.unreachable}: ${String(err && err.message ? err.message : err)}`)
          setData(null)
        } finally {
          setStatus(null)
        }
      }, [query, sort, kind, text])

      react.useEffect(() => {
        const timer = setTimeout(() => { void load() }, 200)
        return () => clearTimeout(timer)
      }, [load])

      const install = react.useCallback(async (plugin) => {
        setBusy((prev) => ({ ...prev, [plugin.name]: 'busy' }))
        try {
          const res = await fetch(`${API}/install`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ target: plugin.install, name: plugin.name }),
          })
          const result = await res.json()
          if (result.ok) {
            setBusy((prev) => ({ ...prev, [plugin.name]: 'done' }))
            if (result.repair && Array.isArray(result.repair.notes) && result.repair.notes.length > 0) {
              setStatus(`${text.repaired}: ${result.repair.notes.join('; ')}`)
            }
          } else {
            setBusy((prev) => ({ ...prev, [plugin.name]: 'error' }))
            setStatus(String(result.error ?? text.failed))
          }
        } catch (err) {
          setBusy((prev) => ({ ...prev, [plugin.name]: 'error' }))
          setStatus(String(err && err.message ? err.message : err))
        }
      }, [text])

      const plugins = (data && data.plugins) || []
      const footer = data
        ? text.footer(plugins.length, data.count ?? plugins.length, data.updated ? new Date(data.updated).toLocaleString() : '-')
        : ''

      return h('div', { className: 'dshmo' },
        h('div', { className: 'dshmo-bar' },
          h('input', {
            type: 'search',
            className: 'dshmo-search',
            placeholder: text.search,
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('select', { className: 'dshmo-select', value: sort, onChange: (event) => setSort(event.target.value) },
            h('option', { value: 'score' }, text.sortScore),
            h('option', { value: 'stars' }, text.sortStars),
            h('option', { value: 'downloads' }, text.sortDownloads),
            h('option', { value: 'name' }, text.sortName),
          ),
          h('select', { className: 'dshmo-select', value: kind, onChange: (event) => setKind(event.target.value) },
            h('option', { value: '' }, text.allKinds),
            h('option', { value: 'npm' }, 'npm'),
            h('option', { value: 'github' }, 'github'),
            h('option', { value: 'tarball' }, 'tarball'),
          ),
        ),
        h('div', { className: 'dshmo-status' }, error ?? status ?? footer),
        error ? h('button', { type: 'button', className: 'dshmo-install', onClick: () => void load() }, text.retry) : null,
        plugins.length === 0 && error === null
          ? h('div', { className: 'dshmo-empty' }, status === null ? text.empty : '')
          : null,
        h('div', { className: 'dshmo-list' },
          plugins.map((plugin, index) => h(Card, {
            key: `${plugin.name}-${plugin.install}`,
            plugin,
            index,
            text,
            state: busy[plugin.name],
            onInstall: install,
          })),
        ),
      )
    }

    /** Injected services. `slots` is the only hard requirement. */
    const inject = ['slots']

    const name = 'dsh-market-own'

    /** Register the settings section. */
    function apply(ctx) {
      // Styles travel with the section, scoped by class prefix, so the plugin
      // needs no build step and cannot leak rules into the host UI.
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-market-own', '')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { try { style.remove() } catch { /* already gone */ } }
      }, 'dsh-market-own: styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: ORDER,
        label: () => resolveText(ctx).nav,
      }, () => h(MarketSection, { ctx })))
    }

    /** Section styles. Prefixed so nothing here can affect the host. */
    const CSS = `
.dshmo { display: flex; flex-direction: column; gap: 10px; padding: 4px 0 24px; }
.dshmo-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dshmo-search { flex: 1 1 220px; min-width: 160px; padding: 8px 12px; border-radius: 10px;
  border: 1px solid var(--dsh-border, #e4e7ec); background: var(--dsh-surface, #fff); color: inherit; font: inherit; }
.dshmo-select { padding: 8px 10px; border-radius: 10px; border: 1px solid var(--dsh-border, #e4e7ec);
  background: var(--dsh-surface, #fff); color: inherit; font: inherit; }
.dshmo-status { font-size: 12px; opacity: .75; min-height: 16px; }
.dshmo-empty { padding: 32px 0; text-align: center; opacity: .6; }
.dshmo-list { display: flex; flex-direction: column; gap: 8px; }
.dshmo-card { display: grid; grid-template-columns: 40px 1fr auto; gap: 12px; align-items: start;
  padding: 12px 14px; border: 1px solid var(--dsh-border, #e4e7ec); border-radius: 12px;
  background: var(--dsh-surface, #fff); }
.dshmo-rank { text-align: right; font-variant-numeric: tabular-nums; opacity: .55; font-weight: 600; }
.dshmo-title { display: flex; gap: 8px; align-items: baseline; font-weight: 600; }
.dshmo-title a { color: inherit; text-decoration: none; }
.dshmo-title a:hover { text-decoration: underline; }
.dshmo-owner { font-weight: 400; font-size: 12px; opacity: .6; }
.dshmo-desc { font-size: 13px; opacity: .75; margin-top: 3px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dshmo-meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 7px; font-size: 12px; }
.dshmo-tag { padding: 1px 8px; border-radius: 999px; border: 1px solid var(--dsh-border, #e4e7ec); opacity: .85; }
.dshmo-warn { color: #d29922; }
.dshmo-num { opacity: .7; font-variant-numeric: tabular-nums; }
.dshmo-install { padding: 7px 14px; border-radius: 9px; border: 1px solid transparent; cursor: pointer;
  background: var(--dsh-accent, #4d6bfe); color: #fff; font: inherit; font-weight: 550; white-space: nowrap; }
.dshmo-install:disabled { opacity: .55; cursor: progress; }
`

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
