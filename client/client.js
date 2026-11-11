/**
 * Browser half: one compact chip in the composer dock.
 *
 * It reads the host route registered by `lib/core/http.js` — no websocket, no
 * shared state, no second data channel to keep consistent. The chip is
 * deliberately small: a dot whose colour encodes "clean / drift / error", the
 * branch, and the ahead/behind counts. Clicking it re-fetches.
 *
 * Plain JavaScript, no build step: the module table supplies React.
 */

window.__ModuleLoader__.load({
  id: 'dsh-syn-config',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const STATUS_URL = '/plugins/dsh-syn-config/status'

    /** Fetch the host status once; abort on unmount. */
    function useStatus() {
      const [state, setState] = React.useState({ phase: 'loading' })
      const [nonce, setNonce] = React.useState(0)
      React.useEffect(() => {
        const controller = new AbortController()
        let alive = true
        fetch(STATUS_URL, { signal: controller.signal, headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
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

    function StatusChip() {
      const [state, refresh] = useStatus()
      const { color, label } = describe(state)
      const title = state.phase === 'ready'
        ? `${state.body.repoPath ?? ''}\n${label}\n点击刷新`
        : state.phase === 'error'
          ? '状态接口在本组合不可用；用 /syn-dsh status 查看'
          : label
      return h('button', {
        type: 'button',
        onClick: refresh,
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
