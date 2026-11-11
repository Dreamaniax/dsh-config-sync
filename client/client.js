/**
 * Browser half: a status chip in the composer dock, and a small panel behind it.
 *
 * The chip answers "am I in sync?". The panel answers "what should I do next?"
 * without leaving the input box: one health check, the dry-run plan of a pull
 * and of a push, and a secret scan. Every one of those is a `GET` on a
 * read-only route — the panel can *look*, never write. Anything that mutates
 * still goes through `/syn-dsh … now`, which is the only path that writes, and
 * the panel gives you that command on one click (copy).
 *
 * Plain JavaScript, no build step: the module table supplies React.
 */

window.__ModuleLoader__.load({
  id: 'dsh-syn-config',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const BASE = '/plugins/dsh-syn-config'
    const STATUS_URL = `${BASE}/status`
    const DOCTOR_URL = `${BASE}/doctor`
    const PLAN_URL = `${BASE}/plan`
    const SECRETS_URL = `${BASE}/secrets`

    /** The four things the panel can look at, and the command that acts on it. */
    const ACTIONS = [
      { id: 'doctor', label: '体检', url: DOCTOR_URL, command: '/syn-dsh doctor' },
      { id: 'pull', label: '拉取计划', url: `${PLAN_URL}?action=pull`, command: '/syn-dsh pull now' },
      { id: 'push', label: '推送计划', url: `${PLAN_URL}?action=push`, command: '/syn-dsh push now' },
      { id: 'secrets', label: '密钥扫描', url: SECRETS_URL, command: '/syn-dsh secrets scan' },
    ]

    async function getJson(url, signal) {
      const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    /** Fetch the host status once; abort on unmount. */
    function useStatus() {
      const [state, setState] = React.useState({ phase: 'loading' })
      const [nonce, setNonce] = React.useState(0)
      React.useEffect(() => {
        const controller = new AbortController()
        let alive = true
        getJson(STATUS_URL, controller.signal)
          .then((body) => {
            if (alive) setState({ phase: 'ready', body })
          })
          .catch((error) => {
            if (alive && error?.name !== 'AbortError') setState({ phase: 'error', message: String(error?.message ?? error) })
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, [nonce])
      return [state, () => setNonce((value) => value + 1)]
    }

    /** Colour + label for the current state. */
    function describe(state) {
      if (state.phase === 'loading') return { color: '#8a8a8a', label: '检查中…' }
      // The desktop build may serve the UI over IPC without exposing the route;
      // that is not a plugin failure, so do not paint it red.
      if (state.phase === 'error') return { color: '#8a8a8a', label: '同步就位' }
      const body = state.body
      if (body.repoPresent !== true) return { color: '#ef7272', label: '无仓库' }
      if (body.ok !== true) return { color: '#ef7272', label: '读取失败' }
      const drift = (body.ahead ?? 0) + (body.behind ?? 0) + (body.dirty ?? 0)
      if (drift > 0) {
        const parts = []
        if (body.ahead > 0) parts.push(`↑${body.ahead}`)
        if (body.behind > 0) parts.push(`↓${body.behind}`)
        if (body.dirty > 0) parts.push(`±${body.dirty}`)
        return { color: '#e0a33e', label: `${body.branch || 'HEAD'} ${parts.join(' ')}` }
      }
      return { color: '#51b976', label: `${body.branch || 'HEAD'} 已同步` }
    }

    /** Turn a payload into a few short lines — the panel is not a report. */
    function describeResult(action, body) {
      if (body?.ok === false && typeof body.error === 'string') return `失败：${body.error}`
      if (action === 'doctor') {
        const head = `体检：${body.fail} 阻塞 / ${body.warn} 警告`
        const rows = (body.sections ?? []).map((section) => {
          const mark = section.blocking > 0 ? '❌' : section.status === 'warn' ? '⚠️' : '✅'
          return `${mark} ${section.title}${section.summary === '' ? '' : ` — ${section.summary}`}`
        })
        return [head, ...rows].join('\n')
      }
      if (action === 'pull') {
        const mirrors = (body.mirrors ?? []).map((m) => `${m.name} +${m.added} ~${m.updated} -${m.deleted}`).join(' · ')
        return [`远端提交：${body.incomingCommits ?? 0}`, `${String(body.before ?? '').slice(0, 7)} → ${String(body.after ?? '').slice(0, 7)}`, mirrors].filter(Boolean).join('\n')
      }
      if (action === 'push') {
        const c = body.changes ?? {}
        return [
          `变更：+${c.added ?? 0} ~${c.updated ?? 0} -${c.deleted ?? 0} · 技能 ${body.skills ?? 0}`,
          `门禁：lint ${body.gates?.lint ? '✅' : '❌'} · redact ${body.gates?.redacted ?? 0} · scan ${body.gates?.scan ? '✅' : '❌'}`,
          body.commit?.created ? `提交：${body.commit.created}` : body.commit?.unchanged ? '无变更可提交' : 'dry run：未写入',
        ].join('\n')
      }
      return `明文命中：${body.hits ?? 0}`
    }

    const panelStyle = {
      position: 'absolute',
      bottom: 'calc(100% + 8px)',
      left: 0,
      zIndex: 40,
      width: '360px',
      maxWidth: '80vw',
      padding: '10px',
      borderRadius: '10px',
      border: '0.5px solid var(--dsw-alias-border-l2, #494949)',
      background: 'var(--dsw-alias-bg-layer-1, #1f1f1f)',
      boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
      color: 'var(--dsw-alias-label-primary, #e6e6e6)',
      fontSize: '12px',
      lineHeight: '18px',
    }

    const tabStyle = {
      padding: '3px 8px',
      fontSize: '12px',
      borderRadius: '6px',
      border: '0.5px solid var(--dsw-alias-border-l2, #494949)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    }

    function ResultBox({ text, command }) {
      const [copied, setCopied] = React.useState(false)
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(command)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          setCopied(false)
        }
      }
      return h('div', { style: { marginTop: '8px' } },
        h('pre', {
          style: {
            margin: 0,
            padding: '6px 8px',
            maxHeight: '180px',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '11px',
            lineHeight: '16px',
            background: 'rgba(255,255,255,0.04)',
            borderRadius: '6px',
          },
        }, text),
        h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center' } },
          h('button', { type: 'button', onClick: copy, style: tabStyle }, copied ? '已复制' : '复制命令'),
          h('code', { style: { fontSize: '11px', opacity: 0.75 } }, command),
        ),
      )
    }

    function StatusChip() {
      const [state, refresh] = useStatus()
      const [open, setOpen] = React.useState(false)
      const [panel, setPanel] = React.useState({ action: '', text: '点一个动作看看现在该做什么', loading: false })
      const [doctor, setDoctor] = React.useState(null)
      const boxRef = React.useRef(null)
      const { color, label } = describe(state)

      // Health is the number that decides "should I act today?", so it is
      // fetched when the panel opens rather than on every render.
      React.useEffect(() => {
        if (!open) return undefined
        const controller = new AbortController()
        getJson(DOCTOR_URL, controller.signal)
          .then((body) => setDoctor(body))
          .catch(() => setDoctor(null))
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onClick = (event) => {
          if (boxRef.current !== null && !boxRef.current.contains(event.target)) setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        window.addEventListener('mousedown', onClick)
        return () => {
          controller.abort()
          window.removeEventListener('keydown', onKey)
          window.removeEventListener('mousedown', onClick)
        }
      }, [open])

      const run = async (action) => {
        setPanel({ action: action.id, text: '读取中…', loading: true })
        const controller = new AbortController()
        try {
          const body = await getJson(action.url, controller.signal)
          setPanel({ action: action.id, text: describeResult(action.id, body), loading: false })
        } catch (error) {
          setPanel({ action: action.id, text: `读取失败：${String(error?.message ?? error)}`, loading: false })
        }
      }

      const health = doctor === null
        ? null
        : doctor.fail > 0
          ? `体检 ${doctor.fail} 阻塞`
          : doctor.warn > 0 ? `体检 ${doctor.warn} 警告` : '体检通过'
      const active = ACTIONS.find((action) => action.id === panel.action)

      const title = state.phase === 'ready'
        ? `${state.body.repoPath ?? ''}\n${label}\n点击查看可做的动作`
        : state.phase === 'error'
          ? '状态接口在本组合不可用；用 /syn-dsh status 查看'
          : label

      return h('div', { ref: boxRef, style: { position: 'relative', display: 'inline-block' } },
        h('button', {
          type: 'button',
          onClick: () => {
            setOpen((value) => !value)
            refresh()
          },
          title,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '3px 9px',
            font: 'inherit',
            fontSize: '12px',
            lineHeight: '16px',
            color: 'var(--dsw-alias-label-secondary, #b9b9b9)',
            background: 'transparent',
            border: '0.5px solid var(--dsw-alias-border-l2, #494949)',
            borderRadius: '999px',
            cursor: 'pointer',
          },
        },
          h('span', {
            'aria-hidden': true,
            style: { width: '7px', height: '7px', borderRadius: '50%', background: color, display: 'inline-block' },
          }),
          h('span', null, label),
          health === null ? null : h('span', { style: { opacity: 0.7 } }, `· ${health}`),
        ),
        open ? h('div', { style: panelStyle },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' } },
            h('strong', { style: { fontSize: '12px' } }, 'DSH 配置同步'),
            h('code', { style: { fontSize: '10px', opacity: 0.6 } }, state.phase === 'ready' ? (state.body.branch || 'HEAD') : '—'),
          ),
          state.phase === 'ready'
            ? h('div', { style: { opacity: 0.75, marginTop: '2px', wordBreak: 'break-all' } }, state.body.repoPath ?? '')
            : null,
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' } },
            ...ACTIONS.map((action) => h('button', {
              key: action.id,
              type: 'button',
              onClick: () => run(action),
              style: {
                ...tabStyle,
                borderColor: panel.action === action.id ? 'var(--dsw-alias-brand-primary, #4f8cff)' : tabStyle.borderColor,
              },
            }, action.label)),
          ),
          h(ResultBox, { text: panel.text, command: active === undefined ? '/syn-dsh status' : active.command }),
          h('div', { style: { marginTop: '6px', opacity: 0.6, fontSize: '11px' } },
            '面板只读；真正的写操作要用上面的命令加 now。'),
        ) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // A missing slot must cost the chip, not the whole client plugin: the
        // host UI owns the slot table and may rename it between versions.
        try {
          ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'dsh-syn-config-status',
            order: 40,
          }, StatusChip))
        } catch (error) {
          // eslint-disable-next-line no-console -- there is no logger in the browser half
          console.warn(`dsh-syn-config: status chip not mounted (${String(error?.message ?? error)})`)
        }
      },
    }
  },
})
