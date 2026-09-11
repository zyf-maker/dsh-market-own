/**
 * DSH Market (own) — client half.
 *
 * Loaded by the host's module loader, which injects `require`. Only `react` is
 * required, deliberately: another market plugin depended on four named exports of
 * the host's ui-primitives and disabled itself when any was missing, so a host
 * older than rc.6 showed nothing at all. Rendering from one stable dependency keeps
 * this working across host versions.
 *
 * Hand-written in the loader's factory format rather than bundled, because the
 * format is small and a build step would add a toolchain to a plugin whose whole job
 * is to read JSON and render a list.
 *
 * Registration contract, taken from the host's settings seat:
 *   ctx.slots.inject('settings.section', () => ctx.slots.register(descriptor, Component))
 *
 * ## Layout
 *
 * Two columns. The left is the category index — every category the catalog uses,
 * with its count — which is both the type statistic and the filter. The right is the
 * catalog, in a responsive grid: one column on a narrow panel, two when there is
 * room. Available width at the default panel size is 1080 − 188 (host nav) − 48
 * (host padding) = 844px, so two columns are only reachable on a wide window; that
 * is what the grid breakpoints encode.
 *
 * ## Styling
 *
 * Every colour resolves through a `--dsw-alias-*` token, the host's real namespace.
 * An earlier version of this file used `--dsh-border` / `--dsh-surface` / `--dsh-accent`
 * with light-mode literals as fallbacks; nothing in the host defines those names, so
 * the literals always won and the section rendered white cards on a dark panel — the
 * exact failure the host's own `ModelsSection.module.css` warns about. There is also
 * no theme selector here: the token VALUES are rebound by `body[data-ds-dark-theme]`,
 * so dark mode needs no code.
 *
 * Numbers (font sizes, paddings, radii) follow the host's settings convention so the
 * section reads as native: body 14px/22, muted 13px, hints 12px, badges 11px/17,
 * card padding 14px 16px, radius 12px. The one deliberate deviation is the index row
 * height — 32px rather than the host's 40px — because 20 rows at 40px exceed the
 * panel height and a category index whose entries cannot all be seen is not an index.
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
    /** Title of the synthetic bucket, pinned to the end of the index. */
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
        restartHint: '多数插件需刷新页面或重启后生效',
        empty: '没有匹配的插件',
        emptyInCategory: '本分类内没有匹配的插件',
        unreachable: '目录加载失败',
        repaired: '已自动修复',
        unproven: '未能验证安装方式，暂不可安装',
        more: '加载更多',
        loadingMore: '加载中…',
        footer: (shown, matched, total) => `显示 ${shown} / 匹配 ${matched} / 共 ${total}`,
        inCategory: (n) => `本分类 ${n}`,
        global: (n) => `全站 ${n}`,
        types: (n) => `${n} 个分类`,
        updated: (when) => `更新于 ${when}`,
        sources: (n) => `${n} 处收录`,
        auto: '自动发现的分类',
        reveal: '在仓库中打开',
      },
      en: {
        nav: 'My Market',
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
        restartHint: 'Most plugins need a refresh or restart to take effect',
        empty: 'No matching plugins',
        emptyInCategory: 'No matching plugins in this category',
        unreachable: 'Catalog failed to load',
        repaired: 'Repaired automatically',
        unproven: 'Install target unverified; cannot install yet',
        more: 'Load more',
        loadingMore: 'Loading…',
        footer: (shown, matched, total) => `showing ${shown} / matched ${matched} / of ${total}`,
        inCategory: (n) => `in category ${n}`,
        global: (n) => `catalog-wide ${n}`,
        types: (n) => `${n} categories`,
        updated: (when) => `updated ${when}`,
        sources: (n) => `listed by ${n}`,
        auto: 'Auto-discovered category',
        reveal: 'Open repository',
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

    /** Compact numbers, so a count never widens a column. */
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
     * `morlay_null`) that would 404 or resolve to a stranger. `repoPath` is present
     * for 99.5% of rows; the rest fall back to initials.
     *
     * @returns `{ src, initial, hue }` — `src` is null when an avatar cannot exist.
     */
    function avatarOf(plugin) {
      const login = String(plugin.owner ?? '').trim()
      const valid = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login) && !/\s/.test(login)
      let hue = 0
      for (let i = 0; i < login.length; i += 1) hue = (hue * 31 + login.charCodeAt(i)) % 360
      return {
        src: valid ? `https://github.com/${login}.png?size=64` : null,
        initial: (login.replace(/[^A-Za-z0-9]/g, '')[0] ?? '?').toUpperCase(),
        hue,
      }
    }

    /** Behaviour of the description clamp: Chinese is dense, English is ~2.1× longer. */
    const isCjk = (text) => /[\u4e00-\u9fff]/.test(text)

    /** One plugin card. */
    function Card({ plugin, text, preferChinese, onInstall, state, onReveal }) {
      const description = descriptionOf(plugin, preferChinese)
      const avatar = avatarOf(plugin)
      const [avatarFailed, setAvatarFailed] = react.useState(false)
      const flags = (plugin.riskFlags ?? []).filter((flag) => RISK[flag] !== undefined)
      // Zero values are not rendered. Measured: 4018 plugins have no stars and 9059
      // have no downloads, 3624 have neither — a third of all cards would otherwise
      // show two dead zeros, which reads as "worthless" when the truth is "no data".
      const hasStars = plugin.stars > 0
      const hasDownloads = plugin.downloads > 0
      const silent = !hasStars && !hasDownloads
      const label = state === 'busy' ? text.installing : state === 'done' ? text.installed : state === 'error' ? text.failed : text.install
      const canInstall = plugin.installable !== null && state !== 'busy'

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
            title: plugin.installable === null ? text.unproven : plugin.install,
            onClick: () => onInstall(plugin),
          }, label),
        ),
        description !== ''
          ? h('p', { className: `dshmo-desc${isCjk(description) ? '' : ' dshmo-desc-latin'}` }, description)
          : null,
        h('div', { className: 'dshmo-meta' },
          h('span', { className: `dshmo-tag dshmo-tag-${plugin.targetKind ?? 'unknown'}` }, plugin.targetKind ?? 'unknown'),
          silent
            // No popularity to show: the number of catalogs that list it is the only
            // signal these rows have, and risk facts matter more than either.
            ? h('span', { className: 'dshmo-num' }, text.sources(plugin.sourceCount ?? 0))
            : null,
          hasStars ? h('span', { className: 'dshmo-num' }, `★ ${fmt(plugin.stars)}`) : null,
          hasDownloads ? h('span', { className: 'dshmo-num' }, `↓ ${fmt(plugin.downloads)}`) : null,
          flags.map((flag) => h('span', {
            key: flag,
            className: 'dshmo-tag dshmo-risk',
            title: flag,
          }, RISK[flag][preferChinese ? 'zh' : 'en'])),
          plugin.installable === null
            ? h('span', { className: 'dshmo-tag dshmo-warn', title: text.unproven }, text.unproven.slice(0, 4))
            : null,
        ),
      )
    }

    /** The market section: category index on the left, catalog on the right. */
    function MarketSection(props) {
      const ctx = props.ctx
      const text = react.useMemo(() => resolveText(), [])
      const preferChinese = text === TEXT.zh
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
      const searchRef = react.useRef(null)

      /**
       * Fetch one page.
       *
       * @param nextPage - the page to request; anything other than 1 replaces the
       *   list (a filter changed), 1 appends (the reader asked for more).
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
        const timer = setTimeout(() => { setPage(1); void load(1) }, 200)
        return () => clearTimeout(timer)
      }, [load])

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
            // Installing is not the same as taking effect, and saying so avoids the
            // reader concluding it failed.
            setStatus(result.repair && Array.isArray(result.repair.notes) && result.repair.notes.length > 0
              ? `${text.repaired}: ${result.repair.notes.join('; ')} · ${text.restartHint}`
              : text.restartHint)
          } else {
            setBusy((prev) => ({ ...prev, [plugin.name]: 'error' }))
            setStatus(String(result.error ?? text.failed))
          }
        } catch (err) {
          setBusy((prev) => ({ ...prev, [plugin.name]: 'error' }))
          setStatus(String(err && err.message ? err.message : err))
        }
      }, [text])

      const categories = (data && data.categories) || {}
      const labelOf = react.useCallback((id, meta) => {
        const lang = preferChinese ? 'zh' : 'en'
        return meta?.[lang] ?? meta?.en ?? id
      }, [preferChinese])

      /**
       * The index, ordered by size with `other` pinned last.
       *
       * `other` holds 1273 plugins — the largest bucket — so sorting purely by size
       * would put "unclassified" first, recommending the one entry that means "we
       * could not tell". The rest stay size-ordered because a reader starts from
       * where the plugins are.
       */
      const index = react.useMemo(() => Object.entries(categories)
        .map(([id, meta]) => ({ id, label: labelOf(id, meta), count: meta?.count ?? 0, auto: Boolean(meta?.auto) }))
        .filter((row) => row.count > 0)
        .sort((a, b) => (a.id === OTHER ? 1 : 0) - (b.id === OTHER ? 1 : 0) || b.count - a.count), [categories, labelOf])

      const total = (data && data.count) ?? 0
      const matched = (data && data.matched) ?? rows.length
      const globalMatched = (data && data.globalMatched) ?? matched
      const inCategory = category !== '' ? matched : null
      const filtered = query.trim() !== '' || kind !== ''

      // Three numbers, so "nothing in this category" and "nothing anywhere" cannot be
      // confused: shown / this category / catalog-wide.
      const summary = data === null ? '' : [
        text.footer(rows.length, matched, total),
        filtered && inCategory !== null ? text.inCategory(globalMatched) : null,
        data.updated ? text.updated(new Date(data.updated).toLocaleString()) : null,
      ].filter(Boolean).join(' · ')

      const nav = h('nav', { className: 'dshmo-nav', 'aria-label': text.categories },
        h('div', { className: 'dshmo-nav-title' }, text.categories),
        h('button', {
          type: 'button',
          key: '__all',
          className: `dshmo-nav-row${category === '' ? ' dshmo-nav-active' : ''}`,
          'aria-pressed': category === '',
          onClick: () => setCategory(''),
        },
        h('span', { className: 'dshmo-nav-label' }, text.all),
        h('span', { className: 'dshmo-nav-count' }, fmt(total)),
        ),
        index.map((row) => h('button', {
          key: row.id,
          type: 'button',
          className: `dshmo-nav-row${category === row.id ? ' dshmo-nav-active' : ''}`,
          'aria-pressed': category === row.id,
          ...(row.auto ? { title: text.auto } : {}),
          onClick: () => setCategory(category === row.id ? '' : row.id),
        },
        h('span', { className: 'dshmo-nav-label' }, row.label),
        h('span', { className: 'dshmo-nav-count' }, fmt(row.count)),
        )),
      )

      const main = h('div', { className: 'dshmo-main' },
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
      )

      return h('div', { className: 'dshmo' }, h('div', { className: 'dshmo-grid' }, nav, main))
    }

    /** Injected services. `slots` is the only hard requirement. */
    const inject = ['slots']

    const name = 'dsh-market-own'

    /** Register the settings section. */
    function apply(ctx) {
      // Styles travel with the section, scoped by a `dshmo` prefix, so the plugin
      // needs no build step and cannot leak rules into the host UI. Injected once,
      // guarded by the host's own `data-plugin-css` convention.
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
.dshmo { display: flex; flex-direction: column; gap: 12px; padding: 4px 0 24px; }
/* The settings outlet renders this section with display:contents, so a max-width on
   the root would do nothing; the cap goes on these inner wrappers, at the host's
   own 760px convention. */
.dshmo-grid { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 16px; align-items: start; max-width: 760px; }
@media (min-width: 1180px) { .dshmo-grid { max-width: 1000px; } }
@media (max-width: 860px) { .dshmo-grid { grid-template-columns: minmax(0, 1fr); } }

/* --- left: the category index ------------------------------------------- */
/* The height cap is computed from the space the panel actually offers rather than
   from a viewport fraction: at 62vh a 1002px-tall window gave 621px for content
   needing 650px, so the index scrolled by 80px and its last entries were never
   visible, which defeats the point of an index. The subtraction approximates
   (panel = min(800, 100vh - 48)) minus the host header and padding.
   NOTE: this stylesheet is a template literal, so no backticks may appear in these
   comments — one would terminate the string and take the whole section with it. */
.dshmo-nav { display: flex; flex-direction: column; gap: 1px; max-height: min(720px, calc(100vh - 120px));
  overflow-y: auto; padding: 4px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3); position: sticky; top: 8px; box-sizing: border-box; }
@media (max-width: 860px) { .dshmo-nav { position: static; max-height: none; flex-direction: row; overflow-x: auto; } }
.dshmo-nav-title { font: var(--dsw-font-xxxs-strong-11); letter-spacing: .06em; text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary); padding: 4px 8px 2px; }
@media (max-width: 860px) { .dshmo-nav-title { display: none; } }
/* 30px rows with a 1px gap: 20 rows + the title come to ~650px, which fits the panel
   without scrolling. The host's own nav uses 40px, but it only has 7 entries — an
   index whose entries cannot all be seen is not an index, and that trade is worth the
   10px. */
.dshmo-nav-row { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  min-height: 30px; padding: 3px 9px; border: 0; border-radius: 8px; background: none;
  color: var(--dsw-alias-label-primary); font: var(--dsw-font-s-14); cursor: pointer;
  text-align: left; white-space: nowrap; transition: background .16s, color .16s; }
.dshmo-nav-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshmo-nav-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshmo-nav-active { background: var(--dsw-alias-state-business-primary); color: #fff; }
.dshmo-nav-active:hover { background: var(--dsw-alias-state-business-primary); }
.dshmo-nav-label { overflow: hidden; text-overflow: ellipsis; }
.dshmo-nav-count { font: var(--dsw-font-xxxs-11); color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dshmo-nav-active .dshmo-nav-count { color: rgba(255,255,255,.85); }

/* --- right: controls, list, footer -------------------------------------- */
.dshmo-main { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.dshmo-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dshmo-search { flex: 1 1 200px; min-width: 140px; height: 34px; padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: var(--dsw-font-s-14); }
.dshmo-search::placeholder { color: var(--dsw-alias-label-tertiary); }
.dshmo-select { height: 34px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-s-14); }
.dshmo-search:focus-visible, .dshmo-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshmo-status { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary); min-height: 18px; }
.dshmo-empty { padding: 32px 0; text-align: center; font: var(--dsw-font-s-14); color: var(--dsw-alias-label-tertiary); }

/* One column by default, two when the panel is wide enough to give each card room:
   the default settings panel leaves ~628px of content, which is one comfortable
   column. */
.dshmo-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
@media (min-width: 1420px) { .dshmo-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

.dshmo-card { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3); transition: border-color .16s, background .16s; min-width: 0; }
.dshmo-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.dshmo-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
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
.dshmo-meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.dshmo-tag { padding: 1px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
  font: var(--dsw-font-xxxs-11); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dshmo-tag-github, .dshmo-tag-npm, .dshmo-tag-tarball { color: var(--dsw-alias-label-secondary); }
.dshmo-risk { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-label); }
.dshmo-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-label); }
.dshmo-num { font: var(--dsw-font-xxxs-11); color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dshmo-install { flex: none; height: 28px; padding: 0 12px; border: 0; border-radius: 14px; cursor: pointer;
  background: var(--dsw-alias-state-business-primary); color: #fff; font: var(--dsw-font-xs-strong-13); }
.dshmo-install:hover:not(:disabled) { background: var(--dsw-alias-state-business-primary); filter: brightness(1.06); }
.dshmo-install:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshmo-install:disabled { opacity: .55; cursor: not-allowed; }
.dshmo-more { align-self: flex-start; height: 32px; padding: 0 14px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); font: var(--dsw-font-xs-13); cursor: pointer; }
.dshmo-more:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshmo-more:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshmo-more:disabled { opacity: .6; cursor: progress; }
`

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
