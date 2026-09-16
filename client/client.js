/**
 * DSH Market (own) — client half.
 *
 * Loaded by the host's module loader, which injects `require`. Only `react` is
 * required, deliberately: another market plugin depended on four named exports of the
 * host's ui-primitives and disabled itself when any was missing, so a host older than
 * rc.6 showed nothing at all. Rendering from one stable dependency keeps this working
 * across host versions.
 *
 * Hand-written in the loader's factory format rather than bundled, because the format
 * is small and a build step would add a toolchain to a plugin whose whole job is to
 * read JSON and render a list.
 *
 * Registration contract, taken from the host's settings seat:
 *   ctx.slots.inject('settings.section', () => ctx.slots.register(descriptor, Component))
 *
 * ## Layout
 *
 * Controls across the top, category chips directly under them, then the catalog as a
 * GRID of cards reading left to right.
 *
 * An earlier revision put categories in a left sidebar and the cards in one column,
 * which made the cards a vertical list and pushed the type statistics into a rail
 * that had to scroll to show all 19 entries. Both were wrong for a catalog of ten
 * thousand plugins: reading a marketplace is scanning, and scanning wants width.
 * The settings outlet leaves ~844px at the default panel size, which is three columns
 * at a 240px readability floor — measured, not assumed.
 *
 * ## Styling
 *
 * Every colour resolves through a `--dsw-alias-*` token, the host's real namespace.
 * An earlier version used `--dsh-border` / `--dsh-surface` / `--dsh-accent` with
 * light-mode literals as fallbacks; nothing in the host defines those names, so the
 * literals always won and the section rendered white cards on a dark panel — the exact
 * failure the host's own `ModelsSection.module.css` warns about. There is also no
 * theme selector here: the token VALUES are rebound by `body[data-ds-dark-theme]`, so
 * dark mode needs no code.
 *
 * Numbers (font sizes, paddings, radii) follow the host's settings convention so the
 * section reads as native: body 14px/22, muted 13px, hints 12px, badges 11px/17, card
 * padding 14px 16px, radius 12px.
 *
 * NOTE for future edits: the stylesheet below is a TEMPLATE LITERAL that spans the
 * whole CSS. A backtick in a comment — even quoting a CSS value — terminates it early
 * and takes the entire section down silently. `tests/client.test.mjs` asserts none is
 * present, because the symptom is a market that simply is not there.
 */
window.__ModuleLoader__.load({
  id: 'dsh-market-own',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    /** The host routes this half talks to. */
    const API = '/dsh-market-own/api'
    const SECTION_ID = 'dsh-market-own'
    const ORDER = 41
    /** Rows per request. "Load more" adds another page of this size. */
    const PAGE = 60
    /** The fallback bucket, pinned to the end of the chip row. */
    const OTHER = 'other'

    /**
     * Risk flags, phrased for a reader.
     *
     * The catalog stores three values (`terminal surface`, `requires credentials`,
     * `install script`). They are the only fact in the whole catalog that changes
     * whether installing something is safe, so they are shown rather than hidden.
     */
    const RISK = {
      'terminal surface': { zh: '终端界面', en: 'Terminal' },
      'requires credentials': { zh: '需要凭据', en: 'Credentials' },
      'install script': { zh: '含安装脚本', en: 'Install script' },
    }

    const TEXT = {
      zh: {
        nav: '我的市场',
        catalogTab: '发现插件',
        installedTab: '已安装',
        installedLoading: '正在读取已安装插件…',
        installedError: '已安装插件列表加载失败',
        installedEmpty: '暂无已安装插件',
        installedCount: (n) => `${n} 个已安装插件`,
        installedStatus: '已安装',
        enabled: '已启用',
        disabled: '已停用',
        pending: '等待依赖',
        loadingPhase: '加载中',
        active: '已挂载',
        failedPhase: '挂载失败',
        unloading: '卸载中',
        unobserved: '未挂载',
        installedSearch: '搜索已安装插件…',
        search: '搜索插件 / 作者 / 描述…（按 / 聚焦）',
        all: '全部',
        categories: '分类',
        target: '安装方式',
        allTargets: '全部方式',
        sort: '排序',
        sortRecommended: '推荐排序',
        sortStars: '星数',
        sortDownloads: '下载次数',
        sortNewest: '最近收录',
        sortName: '名称',
        loading: '加载中…',
        retry: '重试',
        install: '安装',
        installing: '安装中…',
        installed: '已安装',
        failed: '失败',
        unavailable: '不可安装',
        recommended: '推荐',
        verified: '已验证',
        restartHint: '多数插件需刷新页面或重启后生效',
        empty: '没有匹配的插件',
        emptyInCategory: '本分类内没有匹配的插件',
        unreachable: '目录加载失败',
        repaired: '已自动修复',
        unproven: '未能验证安装方式',
        more: '加载更多',
        loadingMore: '加载中…',
        footer: (shown, matched, total) => `显示 ${shown} / 匹配 ${matched} / 共 ${total}`,
        screened: (visible, raw) => `已筛选 ${visible} / 原始 ${raw}`,
        inCategory: (n) => `本分类 ${n}`,
        global: (n) => `全站 ${n}`,
        types: (n) => `${n} 个分类`,
        updated: (when) => `更新于 ${when}`,
        sources: (n) => `${n} 处收录`,
        auto: '自动发现的分类',
      },
      en: {
        nav: 'My Market',
        catalogTab: 'Discover',
        installedTab: 'Installed',
        installedLoading: 'Reading installed plugins…',
        installedError: 'Installed plugin list failed to load',
        installedEmpty: 'No installed plugins',
        installedCount: (n) => `${n} installed plugins`,
        installedStatus: 'Installed',
        enabled: 'Enabled',
        disabled: 'Disabled',
        pending: 'Waiting for dependencies',
        loadingPhase: 'Loading',
        active: 'Mounted',
        failedPhase: 'Mount failed',
        unloading: 'Unloading',
        unobserved: 'Not mounted',
        installedSearch: 'Search installed plugins…',
        search: 'Search plugins, authors, descriptions… (press / )',
        all: 'All',
        categories: 'Categories',
        target: 'Install target',
        allTargets: 'Any target',
        sort: 'Sort',
        sortRecommended: 'Recommended',
        sortStars: 'Stars',
        sortDownloads: 'Downloads',
        sortNewest: 'Recently added',
        sortName: 'Name',
        loading: 'Loading…',
        retry: 'Retry',
        install: 'Install',
        installing: 'Installing…',
        installed: 'Installed',
        failed: 'Failed',
        unavailable: 'Unavailable',
        recommended: 'Recommended',
        verified: 'Verified',
        restartHint: 'Most plugins need a refresh or restart to take effect',
        empty: 'No matching plugins',
        emptyInCategory: 'No matching plugins in this category',
        unreachable: 'Catalog failed to load',
        repaired: 'Repaired automatically',
        unproven: 'Install target unverified',
        more: 'Load more',
        loadingMore: 'Loading…',
        footer: (shown, matched, total) => `showing ${shown} / matched ${matched} / of ${total}`,
        screened: (visible, raw) => `screened ${visible} / raw ${raw}`,
        inCategory: (n) => `in category ${n}`,
        global: (n) => `catalog-wide ${n}`,
        types: (n) => `${n} categories`,
        updated: (when) => `updated ${when}`,
        sources: (n) => `listed by ${n}`,
        auto: 'Auto-discovered category',
      },
    }

    /**
     * Pick the copy table.
     *
     * Reads the document rather than injecting the host's locale service: a service
     * named in `inject` must exist or cordis refuses to load the plugin at all, and
     * this half only chooses between two tables.
     */
    function resolveText() {
      try {
        const declared = typeof document !== 'undefined' ? String(document.documentElement?.lang ?? '') : ''
        const preferred = typeof navigator !== 'undefined' ? String(navigator.language ?? '') : ''
        if ((declared || preferred).toLowerCase().startsWith('en')) return TEXT.en
      } catch { /* a host without a document still renders */ }
      return TEXT.zh
    }

    /** Compact numbers, so a count never widens a chip. */
    const fmt = (n) => {
      const value = Number(n) || 0
      if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
      if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`
      return String(value)
    }

    /**
     * The description to show, or ''.
     *
     * A Chinese description is only used when it actually contains Chinese: 792 of
     * the catalog's `zh` strings are byte-identical to their English twin and 555
     * contain no CJK at all, so preferring `zh` blindly would label English prose as
     * the Chinese version.
     */
    function descriptionOf(plugin, preferChinese) {
      const zh = String(plugin.description?.zh ?? '').trim()
      const en = String(plugin.description?.en ?? '').trim()
      if (preferChinese && /[\u4e00-\u9fff]/.test(zh)) return zh
      return en !== '' ? en : zh
    }

    /**
     * A stable, human-readable avatar for one plugin owner.
     *
     * Derived from the repository owner, NOT the `owner` field: 94 rows disagree
     * between the two and the field holds npm-ish handles (`GitHub Actions`,
     * `morlay_null`) that would 404 or resolve to a stranger. `repoPath` covers 99.5%
     * of rows; the rest fall back to initials.
     */
    function avatarOf(plugin) {
      const login = String(plugin.owner ?? '').trim()
      const valid = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login)
      let hue = 0
      for (let i = 0; i < login.length; i += 1) hue = (hue * 31 + login.charCodeAt(i)) % 360
      return {
        src: valid ? `https://github.com/${login}.png?size=64` : null,
        initial: (login.replace(/[^A-Za-z0-9]/g, '')[0] ?? '?').toUpperCase(),
        hue,
      }
    }

    /** English runs ~2.1x longer than Chinese for the same content. */
    const isCjk = (text) => /[\u4e00-\u9fff]/.test(text)

    /** Match one catalog row against the Loader's exact installed module names. */
    function installedEntryFor(plugin, entries) {
      const candidates = [plugin.name, plugin.install, plugin.target, plugin.npm]
        .map(value => String(value ?? '').trim())
        .filter(value => value !== '')
      return entries.find(entry => [entry.moduleName, entry.entryId, entry.marketPlugin, entry.marketTarget, entry.marketSourceModuleName]
        .some(value => candidates.includes(String(value ?? '').trim())))
    }

    /** Match a live Loader entry to a successful installation recorded by this market. */
    function marketMarkerFor(entry, markers) {
      const moduleName = String(entry.moduleName ?? '').trim()
      if (moduleName === '') return undefined
      const moduleBase = modulePackageName(moduleName)
      return markers.find(marker => {
        const known = [marker.moduleName, marker.sourceModuleName, marker.plugin, marker.target, marker.resolvedTarget]
          .map(value => String(value ?? '').trim())
          .filter(value => value !== '')
        return known.includes(moduleName)
          || known.some(value => modulePackageName(value) === moduleBase)
          || String(marker.target ?? '').trim().endsWith(` ${moduleName}`)
      })
    }

    /** Reduce a Loader module path to its package name, preserving npm scopes. */
    function modulePackageName(value) {
      const clean = String(value ?? '').trim()
      if (clean.startsWith('@')) {
        const parts = clean.split('/')
        return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : clean
      }
      return clean.split('/')[0] ?? clean
    }

    /** Keep the installed view useful for entries that are disabled or failed. */
    function installedEntryMatches(entry, query) {
      if (query.trim() === '') return true
      const needle = query.trim().toLocaleLowerCase()
      return [entry.moduleName, entry.entryId, entry.marketPlugin]
        .some(value => String(value ?? '').toLocaleLowerCase().includes(needle))
    }

    /** Translate the Loader phase without hiding a failed installed plugin. */
    function installedPhase(entry, text) {
      if (entry.fiberPhase === 'pending') return text.pending
      if (entry.fiberPhase === 'loading') return text.loadingPhase
      if (entry.fiberPhase === 'active') return text.active
      if (entry.fiberPhase === 'failed') return text.failedPhase
      if (entry.fiberPhase === 'unloading') return text.unloading
      return text.unobserved
    }

    /** A card for one currently configured Loader entry. */
    function InstalledCard({ entry, text }) {
      const phase = installedPhase(entry, text)
      const title = String(entry.marketPlugin ?? entry.moduleName ?? entry.entryId)
      const loadedName = String(entry.moduleName ?? entry.entryId)
      const configuration = entry.enabled ? text.enabled : text.disabled
      return h('article', { className: 'dshmo-card dshmo-installed-card', 'data-plugin-entry': entry.entryId },
        h('div', { className: 'dshmo-head' },
          h('span', { className: 'dshmo-installed-mark', 'aria-hidden': 'true' }, '◆'),
          h('div', { className: 'dshmo-headtext' },
            h('strong', { className: 'dshmo-name', title: title }, title),
            h('span', { className: 'dshmo-owner', title: loadedName }, loadedName),
          ),
        ),
        h('div', { className: 'dshmo-meta' },
          h('span', { className: 'dshmo-tag dshmo-installed' }, text.installedStatus),
          h('span', { className: 'dshmo-tag', 'data-enabled': entry.enabled ? 'true' : 'false' }, configuration),
          h('span', { className: 'dshmo-tag', 'data-phase': entry.fiberPhase ?? 'unobserved' }, phase),
        ),
      )
    }

    /** One plugin card. */
    function Card({ plugin, text, preferChinese, onInstall, state, installedEntry }) {
      const description = descriptionOf(plugin, preferChinese)
      const avatar = avatarOf(plugin)
      const [avatarFailed, setAvatarFailed] = react.useState(false)
      const flags = (plugin.riskFlags ?? []).filter((flag) => RISK[flag] !== undefined)
      // Zero values are not rendered. Measured: 4018 plugins have no stars, 9059 have
      // no downloads, 3624 have neither — a third of all cards would otherwise show
      // two dead zeros, which reads as "worthless" when the truth is "no data".
      const hasStars = plugin.stars > 0
      const hasDownloads = plugin.downloads > 0
      const silent = !hasStars && !hasDownloads
      const label = installedEntry !== undefined
        ? text.installed
        : state === 'busy' ? text.installing : state === 'done' ? text.installed : state === 'error' ? text.failed : text.install
      const canInstall = installedEntry === undefined && plugin.installable === true && state !== 'busy'
      const buttonLabel = plugin.installable === true ? label : text.unavailable

      return h('article', { className: 'dshmo-card' },
        h('div', { className: 'dshmo-head' },
          h('span', { className: 'dshmo-avatar', style: { '--dshmo-hue': avatar.hue } },
            avatar.src !== null && !avatarFailed
              ? h('img', {
                src: avatar.src,
                alt: '',
                width: 28,
                height: 28,
                loading: 'lazy',
                decoding: 'async',
                onError: () => setAvatarFailed(true),
              })
              : h('span', { className: 'dshmo-avatar-initial' }, avatar.initial),
          ),
          h('div', { className: 'dshmo-headtext' },
            h('a', { className: 'dshmo-name', href: plugin.url, target: '_blank', rel: 'noreferrer', title: plugin.name }, plugin.name),
            h('span', { className: 'dshmo-owner', title: plugin.owner }, plugin.owner),
          ),
          h('button', {
            type: 'button',
            className: 'dshmo-install',
            disabled: !canInstall,
            title: plugin.installable === true ? plugin.install : text.unproven,
            onClick: () => onInstall(plugin),
          }, buttonLabel),
        ),
        description !== ''
          ? h('p', { className: `dshmo-desc${isCjk(description) ? '' : ' dshmo-desc-latin'}` }, description)
          : null,
        h('div', { className: 'dshmo-meta' },
          h('span', { className: `dshmo-tag dshmo-tag-${plugin.targetKind ?? 'unknown'}` }, plugin.targetKind ?? 'unknown'),
          installedEntry !== undefined ? h('span', { className: 'dshmo-tag dshmo-installed' }, text.installedStatus) : null,
          plugin.qualityState === 'recommended'
            ? h('span', { className: 'dshmo-tag dshmo-quality' }, text.recommended)
            : plugin.qualityState === 'verified'
              ? h('span', { className: 'dshmo-tag dshmo-quality' }, text.verified)
              : null,
          // No popularity to show: how many catalogs list it is the only signal these
          // rows have, and the risk facts matter more than either.
          silent ? h('span', { className: 'dshmo-num' }, text.sources(plugin.sourceCount ?? 0)) : null,
          hasStars ? h('span', { className: 'dshmo-num' }, `★ ${fmt(plugin.stars)}`) : null,
          hasDownloads ? h('span', { className: 'dshmo-num' }, `↓ ${fmt(plugin.downloads)}`) : null,
          flags.map((flag) => h('span', {
            key: flag,
            className: 'dshmo-tag dshmo-risk',
            title: flag,
          }, RISK[flag][preferChinese ? 'zh' : 'en'])),
          plugin.installable === null
            ? h('span', { className: 'dshmo-tag dshmo-warn', title: text.unproven }, text.unproven)
            : null,
        ),
      )
    }

    /** The market section: controls, category chips, then the catalog grid. */
    function MarketSection(props) {
      const ctx = props.ctx
      const text = react.useMemo(() => resolveText(), [])
      const preferChinese = text === TEXT.zh
      const [view, setView] = react.useState('catalog')
      const [query, setQuery] = react.useState('')
      const [sort, setSort] = react.useState('score')
      const [kind, setKind] = react.useState('')
      const [category, setCategory] = react.useState('')
      const [page, setPage] = react.useState(1)
      const [data, setData] = react.useState(null)
      const [rows, setRows] = react.useState([])
      const [error, setError] = react.useState(null)
      const [status, setStatus] = react.useState(null)
      const [busy, setBusy] = react.useState({})
      const [loadingMore, setLoadingMore] = react.useState(false)
      const [installedEntries, setInstalledEntries] = react.useState([])
      const [installedState, setInstalledState] = react.useState('idle')
      const [installedError, setInstalledError] = react.useState(null)
      const searchRef = react.useRef(null)

      /**
       * Fetch one page.
       *
       * @param nextPage - the page to request. 1 replaces the list (a filter changed);
       *   anything higher appends (the reader asked for more).
       */
      const load = react.useCallback(async (nextPage = 1) => {
        const appending = nextPage > 1
        if (appending) setLoadingMore(true)
        else { setError(null); setStatus(text.loading) }
        try {
          const params = new URLSearchParams({ sort, limit: String(PAGE), page: String(nextPage) })
          if (query.trim() !== '') params.set('q', query.trim())
          if (kind !== '') params.set('kind', kind)
          if (category !== '') params.set('category', category)
          const res = await fetch(`${API}/catalog?${params}`)
          const body = await res.json()
          if (body.error) {
            // A failed fetch is reported as a failure. Never as an empty market:
            // "no plugins" and "could not ask" must not look the same.
            setError(`${text.unreachable}: ${body.message ?? body.error}`)
            setData(null)
            setRows([])
            return
          }
          setData(body)
          setRows((prev) => (appending ? [...prev, ...(body.plugins ?? [])] : (body.plugins ?? [])))
        } catch (err) {
          setError(`${text.unreachable}: ${String(err && err.message ? err.message : err)}`)
          setData(null)
          setRows([])
        } finally {
          setLoadingMore(false)
          setStatus(null)
        }
      }, [query, sort, kind, category, text])

      // Reset to the first page whenever a filter changes: appending to a list that
      // was filtered differently would mix two result sets.
      react.useEffect(() => {
        if (view !== 'catalog') return undefined
        const timer = setTimeout(() => { setPage(1); void load(1) }, 200)
        return () => clearTimeout(timer)
      }, [load, view])

      /** Read successful market installs and join them to the live Loader state. */
      const loadInstalled = react.useCallback(async () => {
        setInstalledState('loading')
        setInstalledError(null)
        try {
          const remote = ctx?.remote?.pluginInventory
          if (remote === undefined || typeof remote.list !== 'function') {
            throw new Error('pluginInventory remote unavailable')
          }
          const [ledgerResponse, result] = await Promise.all([
            fetch(`${API}/installed`),
            remote.list(),
          ])
          const ledger = await ledgerResponse.json()
          if (!ledgerResponse.ok || !Array.isArray(ledger?.entries)) {
            throw new Error(ledger?.message ?? 'market installation ledger unavailable')
          }
          if (result?.ok === false) throw new Error(result.error?.message ?? 'plugin inventory request failed')
          const snapshot = result?.ok === true ? result.value : result
          if (!Array.isArray(snapshot?.entries)) throw new Error('invalid plugin inventory response')
          // The market ledger supplies provenance. Loader entries add lifecycle
          // state when the running host has reloaded; immediately after an install
          // the package is already in the profile but the current Loader cannot see
          // it yet, so retain a pending market entry instead of showing 0.
          const entries = ledger.entries.map(marker => {
            const live = snapshot.entries.find(entry => marketMarkerFor(entry, [marker]) !== undefined)
            if (live !== undefined) {
              return {
                ...live,
                marketPlugin: marker.plugin,
                marketTarget: marker.target,
                marketSourceModuleName: marker.sourceModuleName,
              }
            }
            const moduleName = marker.moduleName || marker.sourceModuleName || marker.plugin
            if (moduleName === '') return null
            return {
              entryId: moduleName,
              moduleName,
              marketPlugin: marker.plugin,
              marketTarget: marker.target,
              marketSourceModuleName: marker.sourceModuleName,
              enabled: true,
              fiberPhase: 'pending',
              marketPending: true,
            }
          }).filter(entry => entry !== null)
          setInstalledEntries(entries)
          setInstalledState('ready')
        } catch (err) {
          setInstalledState('error')
          setInstalledError(String(err?.message ?? err))
        }
      }, [ctx])

      // Load in the background so catalog cards can show their installed badge;
      // the Installed view then opens without a second request.
      react.useEffect(() => { void loadInstalled() }, [loadInstalled])

      // `/` focuses the search box, the one shortcut worth owning here.
      react.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
          const active = document.activeElement
          const typing = active !== null && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable === true)
          if (typing) return
          event.preventDefault()
          searchRef.current?.focus()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [])

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
            void loadInstalled()
            // Installing is not the same as taking effect, and saying so avoids the
            // reader concluding it failed.
            setStatus(result.repair && Array.isArray(result.repair.notes) && result.repair.notes.length > 0
              ? `${text.repaired}: ${result.repair.notes.join('; ')} · ${text.restartHint}`
              : text.restartHint)
          } else {
            setBusy((prev) => ({ ...prev, [plugin.name]: 'error' }))
            const detail = String(result.error ?? result.log ?? '').trim()
            setStatus(detail === '' ? text.failed : `${text.failed}: ${detail.slice(-800)}`)
          }
        } catch (err) {
          setBusy((prev) => ({ ...prev, [plugin.name]: 'error' }))
          setStatus(String(err && err.message ? err.message : err))
        }
      }, [loadInstalled, text])

      const categories = (data && data.categories) || {}

      /**
       * The chip row, ordered by size with `other` pinned last.
       *
       * `other` holds ~1273 plugins — the largest bucket — so ordering purely by size
       * would put "unclassified" first, recommending the one entry that means "we
       * could not tell". The rest stay size-ordered because a reader starts from where
       * the plugins are.
       */
      const chips = react.useMemo(() => Object.entries(categories)
        .map(([id, meta]) => ({
          id,
          label: (preferChinese ? meta?.zh : meta?.en) ?? meta?.en ?? id,
          count: meta?.count ?? 0,
          auto: Boolean(meta?.auto),
        }))
        .filter((row) => row.count > 0)
        .sort((a, b) => (a.id === OTHER ? 1 : 0) - (b.id === OTHER ? 1 : 0) || b.count - a.count), [categories, preferChinese])

      const total = (data && data.count) ?? 0
      const matched = (data && data.matched) ?? rows.length
      const globalMatched = (data && data.globalMatched) ?? matched
      const inCategory = category !== '' ? matched : null
      const filtered = query.trim() !== '' || kind !== ''

      // Three numbers, so "nothing in this category" and "nothing anywhere" cannot be
      // confused: shown / this category / catalog-wide.
      const summary = data === null ? '' : [
        text.footer(rows.length, matched, total),
        text.screened(total, data.rawCount ?? total),
        filtered && inCategory !== null ? text.inCategory(globalMatched) : null,
        text.types(chips.length),
        data.updated ? text.updated(new Date(data.updated).toLocaleString()) : null,
      ].filter(Boolean).join(' · ')

      const chip = (row) => h('button', {
        key: row.id,
        type: 'button',
        className: `dshmo-chip${category === row.id ? ' dshmo-chip-active' : ''}`,
        'aria-pressed': category === row.id,
        ...(row.auto ? { title: text.auto } : {}),
        onClick: () => setCategory(category === row.id ? '' : row.id),
      },
      h('span', null, row.label),
      h('span', { className: 'dshmo-chip-count' }, fmt(row.count)),
      )

      const installedRows = installedEntries.filter(entry => installedEntryMatches(entry, query))
      const installedPanel = installedState === 'loading'
        ? h('p', { className: 'dshmo-status', role: 'status' }, text.installedLoading)
        : installedState === 'error'
          ? h('div', { className: 'dshmo-installed-error' },
            h('p', { className: 'dshmo-status', role: 'alert' }, `${text.installedError}: ${installedError ?? ''}`),
            h('button', { type: 'button', className: 'dshmo-more', onClick: () => { void loadInstalled() } }, text.retry),
          )
          : installedRows.length === 0
            ? h('p', { className: 'dshmo-empty' }, installedEntries.length === 0 ? text.installedEmpty : text.emptyInCategory)
            : h(react.Fragment, null,
              h('div', { className: 'dshmo-status', role: 'status' }, text.installedCount(installedEntries.length)),
              h('div', { className: 'dshmo-list dshmo-installed-list' },
                installedRows.map(entry => h(InstalledCard, { key: entry.entryId, entry, text })),
              ),
            )

      return h('div', { className: 'dshmo' },
        h('div', { className: 'dshmo-inner' },
          h('div', { className: 'dshmo-tabs', role: 'tablist', 'aria-label': text.nav },
            h('button', {
              type: 'button',
              role: 'tab',
              className: `dshmo-tab${view === 'catalog' ? ' dshmo-tab-active' : ''}`,
              'aria-selected': view === 'catalog',
              onClick: () => setView('catalog'),
            }, text.catalogTab),
            h('button', {
              type: 'button',
              role: 'tab',
              className: `dshmo-tab${view === 'installed' ? ' dshmo-tab-active' : ''}`,
              'aria-selected': view === 'installed',
              onClick: () => setView('installed'),
            }, text.installedTab, installedState === 'ready' ? ` (${installedEntries.length})` : ''),
          ),
          view === 'installed' ? installedPanel : h(react.Fragment, null,
          h('div', { className: 'dshmo-bar' },
            h('input', {
              ref: searchRef,
              type: 'search',
              className: 'dshmo-search',
              placeholder: text.search,
              value: query,
              'aria-label': text.search,
              onChange: (event) => setQuery(event.target.value),
            }),
            h('select', {
              className: 'dshmo-select',
              value: sort,
              'aria-label': text.sort,
              onChange: (event) => setSort(event.target.value),
            },
            h('option', { value: 'score' }, text.sortRecommended),
            h('option', { value: 'stars' }, text.sortStars),
            h('option', { value: 'downloads' }, text.sortDownloads),
            h('option', { value: 'newest' }, text.sortNewest),
            h('option', { value: 'name' }, text.sortName),
            ),
            h('select', {
              className: 'dshmo-select',
              value: kind,
              'aria-label': text.target,
              onChange: (event) => setKind(event.target.value),
            },
            h('option', { value: '' }, text.allTargets),
            h('option', { value: 'npm' }, 'npm'),
            h('option', { value: 'github' }, 'github'),
            h('option', { value: 'tarball' }, 'tarball'),
            ),
          ),
          // The category row sits directly under the controls, where it reads as what
          // it is: the second axis of the same filter, not a separate navigation.
          h('div', { className: 'dshmo-cats', role: 'group', 'aria-label': text.categories },
            h('button', {
              type: 'button',
              key: '__all',
              className: `dshmo-chip${category === '' ? ' dshmo-chip-active' : ''}`,
              'aria-pressed': category === '',
              onClick: () => setCategory(''),
            },
            h('span', null, text.all),
            h('span', { className: 'dshmo-chip-count' }, fmt(total)),
            ),
            chips.map(chip),
          ),
          h('div', { className: 'dshmo-status', role: 'status' }, error !== null ? error : (status !== null ? status : summary)),
          error !== null
            ? h('button', { type: 'button', className: 'dshmo-install', onClick: () => { void load(1) } }, text.retry)
            : null,
          rows.length === 0 && error === null && status === null
            ? h('div', { className: 'dshmo-empty' }, category === '' ? text.empty : text.emptyInCategory)
            : null,
          h('div', { className: 'dshmo-list' },
            rows.map((plugin) => h(Card, {
              key: `${plugin.name}-${plugin.install}`,
              plugin,
              text,
              preferChinese,
              state: busy[plugin.name],
              installedEntry: installedEntryFor(plugin, installedEntries),
              onInstall: install,
            })),
          ),
          data !== null && data.hasMore === true
            ? h('button', {
              type: 'button',
              className: 'dshmo-more',
              disabled: loadingMore,
              onClick: () => { const next = page + 1; setPage(next); void load(next) },
            }, loadingMore ? text.loadingMore : text.more)
            : null,
          ),
        ),
      )
    }

    /** Injected services: Settings slots plus the authoritative Loader inventory Remote. */
    const inject = ['slots', 'remote', 'remote.pluginInventory']

    const name = 'dsh-market-own'

    /** Register the settings section. */
    function apply(ctx) {
      // Styles travel with the section, scoped by a `dshmo` prefix, so the plugin needs
      // no build step and cannot leak rules into the host UI. Injected once, guarded by
      // the host's own `data-plugin-css` convention.
      ctx.effect(() => {
        const marker = 'dsh-market-own/styles.css'
        if (document.querySelector(`style[data-plugin-css="${marker}"]`) !== null) return () => {}
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', marker)
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { try { style.remove() } catch { /* already gone */ } }
      }, 'dsh-market-own: styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: ORDER,
        label: () => resolveText().nav,
      }, () => h(MarketSection, { ctx })))
    }

    /**
     * Section styles.
     *
     * Every value is either a `--dsw-alias-*` token or a layout number matching the
     * host's settings convention. No literal colours: a literal cannot react to the
     * dark theme, and the host's own section CSS states the rule.
     */
    const CSS = `
.dshmo { display: block; padding: 4px 0 24px; }
/* The settings outlet renders contributions through a display:contents anchor, so the
   width cap lives on this inner wrapper. 1200px is generous for a card grid while
   keeping a maximized panel from producing a wall of tiny cards. */
 .dshmo-inner { display: flex; flex-direction: column; gap: 12px; max-width: 1200px; }

/* --- market views ------------------------------------------------------- */
 .dshmo-tabs { display: flex; gap: 18px; align-items: center; border-bottom: 1px solid var(--dsw-alias-border-l2); }
 .dshmo-tab { position: relative; height: 34px; padding: 0 2px; border: 0; background: transparent;
   color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-s-14); cursor: pointer; }
 .dshmo-tab:hover { color: var(--dsw-alias-label-primary); }
 .dshmo-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 4px; }
 .dshmo-tab-active { color: var(--dsw-alias-label-primary); font-weight: 600; }
 .dshmo-tab-active::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
   border-radius: 2px 2px 0 0; background: var(--dsw-alias-brand-primary); }

/* --- controls ----------------------------------------------------------- */
.dshmo-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dshmo-search { flex: 1 1 240px; min-width: 160px; height: 34px; padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: var(--dsw-font-s-14); }
.dshmo-search::placeholder { color: var(--dsw-alias-label-tertiary); }
.dshmo-select { height: 34px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-s-14); }
.dshmo-search:focus-visible, .dshmo-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

/* --- category chips, directly under the controls ------------------------ */
/* They wrap rather than scroll: with 20 entries a single scrollable row would hide
   most of them, and the counts are the type statistic the row exists to show. */
.dshmo-cats { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.dshmo-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12); cursor: pointer; white-space: nowrap;
  transition: background .16s, color .16s, border-color .16s; }
.dshmo-chip:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshmo-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshmo-chip-active { background: var(--dsw-alias-state-business-primary); border-color: transparent; color: #fff; }
.dshmo-chip-active:hover { background: var(--dsw-alias-state-business-primary); color: #fff; }
.dshmo-chip-count { font: var(--dsw-font-xxxs-11); opacity: .75; font-variant-numeric: tabular-nums; }
.dshmo-chip-active .dshmo-chip-count { opacity: .9; }

.dshmo-status { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary); min-height: 18px; }
.dshmo-empty { padding: 32px 0; text-align: center; font: var(--dsw-font-s-14); color: var(--dsw-alias-label-tertiary); }

/* --- the catalog: cards read left to right ------------------------------ */
/* auto-fill against a 240px readability floor. The settings panel leaves ~844px at
   its default width, which yields three columns; a narrower panel yields two. */
.dshmo-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; }

.dshmo-card { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3); transition: border-color .16s, background .16s; min-width: 0; }
.dshmo-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.dshmo-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dshmo-avatar { flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 999px; overflow: hidden;
  background: hsl(var(--dshmo-hue, 220) 42% 46%); }
.dshmo-avatar img { width: 28px; height: 28px; display: block; object-fit: cover; }
.dshmo-avatar-initial { font: var(--dsw-font-xxs-strong-12); color: #fff; }
.dshmo-headtext { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.dshmo-name { font: var(--dsw-font-s-strong-14); color: var(--dsw-alias-label-primary); text-decoration: none;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshmo-name:hover { text-decoration: underline; }
.dshmo-name:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 4px; }
.dshmo-owner { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshmo-desc { margin: 0; font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-secondary);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  overflow-wrap: anywhere; }
/* English runs ~2.1x longer than Chinese for the same content (median 113 vs 54
   characters), so it gets a third line rather than being truncated in most rows. */
.dshmo-desc-latin { -webkit-line-clamp: 3; }
.dshmo-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: auto; }
 .dshmo-tag { padding: 1px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
   font: var(--dsw-font-xxxs-11); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
 .dshmo-installed { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
 .dshmo-risk { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-label); }
.dshmo-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-label); }
.dshmo-num { font: var(--dsw-font-xxxs-11); color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dshmo-install { flex: none; height: 28px; padding: 0 12px; border: 0; border-radius: 14px; cursor: pointer;
  background: var(--dsw-alias-state-business-primary); color: #fff; font: var(--dsw-font-xs-strong-13); }
.dshmo-install:hover:not(:disabled) { filter: brightness(1.06); }
.dshmo-install:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshmo-install:disabled { opacity: .55; cursor: not-allowed; }
.dshmo-more { align-self: flex-start; height: 32px; padding: 0 14px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); font: var(--dsw-font-xs-13); cursor: pointer; }
 .dshmo-more:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
 .dshmo-more:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
 .dshmo-more:disabled { opacity: .6; cursor: progress; }
 .dshmo-installed-card { min-height: 92px; }
 .dshmo-installed-mark { flex: none; display: inline-flex; align-items: center; justify-content: center;
   width: 28px; height: 28px; border-radius: 999px; background: var(--dsw-alias-state-business-primary);
   color: #fff; font-size: 12px; }
 .dshmo-installed-error { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
`

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
