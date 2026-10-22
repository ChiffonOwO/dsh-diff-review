/**
 * dsh-diff-review — browser half.
 *
 * Two surfaces over one Host ledger:
 *  - a dock above the composer: "N 个文件已更改" as soon as the current turn has
 *    touched files, expandable into the file list with +/− counts;
 *  - the review page in the right Sidebar: one file at a time with its line diff
 *    and a revert action.
 *
 * The dock is read-only; the review page's revert goes back through the Host.
 */
window.__ModuleLoader__.load({
  id: 'dsh-diff-review',
  factory(require) {
    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    const NS = 'diff-review';
    /** Resource address prefix of the review page: one address per chat. */
    const ADDRESS = 'dsh-resource://diff-review/session/';
    const KIND = 'diff-review';
    const ID = 'dsh-diff-review';
    const CHANGES_ROUTE = 'api/diff-review.changes';
    const DIFF_ROUTE = 'api/diff-review.diff';
    const REVERT_ROUTE = 'api/diff-review.revert';
    /** Polling cadence while a page or the dock is on screen. */
    const POLL_MS = 2000;
    /** Rows grouped into one containment box for scroll performance. */
    const CHUNK_ROWS = 60;

    const addressOf = (sessionId) => `${ADDRESS}${encodeURIComponent(sessionId)}`;

    const parseAddress = (address) => {
      if (!address.startsWith(ADDRESS)) return undefined;
      try {
        const sessionId = decodeURIComponent(address.slice(ADDRESS.length));
        return sessionId === '' ? undefined : { sessionId };
      } catch {
        return undefined;
      }
    };

    const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

    /** One JSON GET; a failed request rejects with its status. */
    async function getJson(url, signal) {
      const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    /** Changed files of one chat's newest turn; `turn` 0 means "nothing recorded". */
    async function fetchChanges(sessionId, signal) {
      const body = await getJson(`${CHANGES_ROUTE}?${new URLSearchParams({ sessionId })}`, signal);
      const files = Array.isArray(body?.files) ? body.files.filter((file) => isRecord(file) && typeof file.path === 'string') : [];
      return { turn: Number.isSafeInteger(body?.turn) ? body.turn : 0, files };
    }

    /** Stable signature of a change summary, so identical polls do not re-render. */
    const signatureOf = (turn, files) => `${turn}|${files.map((file) => `${file.path}:${file.added}:${file.deleted}`).join(',')}`;

    /** Read one chat's changed files, re-reading on a visible-page timer. */
    function useChanges(sessionId) {
      const [state, setState] = React.useState({ status: 'loading', turn: 0, files: [] });
      const [tick, setTick] = React.useState(0);
      const signature = React.useRef('');
      React.useEffect(() => {
        if (sessionId === undefined) return undefined;
        const controller = new AbortController();
        fetchChanges(sessionId, controller.signal).then(
          (value) => {
            const next = signatureOf(value.turn, value.files);
            // Identical poll result: keep the previous object so React bails out
            // of re-rendering the whole page every two seconds.
            if (next === signature.current) return;
            signature.current = next;
            setState({ status: 'ready', ...value });
          },
          () => {
            if (!controller.signal.aborted) setState((previous) => ({ ...previous, status: 'error' }));
          }
        );
        return () => controller.abort();
      }, [sessionId, tick]);
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') setTick((value) => value + 1);
        }, POLL_MS);
        return () => clearInterval(timer);
      }, []);
      const reload = React.useCallback(() => setTick((value) => value + 1), []);
      return [state, reload];
    }

    /** Summed +/− counts of a file list. */
    const totalsOf = (files) => files.reduce(
      (sum, file) => ({ added: sum.added + (file.added ?? 0), deleted: sum.deleted + (file.deleted ?? 0) }),
      { added: 0, deleted: 0 }
    );

    const COUNT_STYLE = { fontVariantNumeric: 'tabular-nums' };
    const ADDED_STYLE = { ...COUNT_STYLE, color: 'var(--dsw-alias-state-success-primary, #2ea043)' };
    const DELETED_STYLE = { ...COUNT_STYLE, color: 'var(--dsw-alias-state-error-primary, #f85149)' };
    const CODE_STYLE = { fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', fontSize: 12 };

    /**
     * Counter bump: a short springy lift whenever the number changes. The
     * animated node is keyed by the value, so React remounts it and the
     * keyframes restart; unchanged values keep the same node and stay still.
     */
    const BUMP_CLASS = 'dsh-diff-review-bump';
    /** The floating file list and its fade/rise transition. */
    const POPOVER_CLASS = 'dsh-diff-review-popover';
    const FADE_MS = 160;
    const BUMP_CSS = `
@keyframes dsh-diff-review-bump {
  0% { transform: translateY(0) scale(1); }
  35% { transform: translateY(-3px) scale(1.22); }
  100% { transform: translateY(0) scale(1); }
}
.${BUMP_CLASS} { display: inline-block; will-change: transform; }
.${BUMP_CLASS}[data-fresh] { animation: dsh-diff-review-bump .34s cubic-bezier(.3, 1.35, .5, 1) both; }
.${POPOVER_CLASS} {
  transition: opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease, visibility ${FADE_MS}ms;
}
/* Invisible bridge across the gap under the popover. It lives on the dock, not
   on the popover: the popover scrolls (overflow-y: auto), which would clip an
   outward pseudo-element away. */
.dsh-diff-review-bridge {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  height: 10px;
  pointer-events: auto;
}
@media (prefers-reduced-motion: reduce) {
  .${BUMP_CLASS}[data-fresh] { animation: none; }
  .${POPOVER_CLASS} { transition: none; }
}
`;
    if (typeof document !== 'undefined' && document.querySelector('style[data-dsh-diff-review]') === null) {
      const tag = document.createElement('style');
      tag.dataset.dshDiffReview = '';
      tag.textContent = BUMP_CSS;
      document.head.appendChild(tag);
    }

    /** A counter that bumps when `value` changes. */
    function Bump({ value, style, prefix }) {
      // The first render must not animate, later ones must: track the value.
      const seen = React.useRef(value);
      const fresh = seen.current !== value;
      if (fresh) seen.current = value;
      return React.createElement('span', {
        key: value,
        className: BUMP_CLASS,
        'data-fresh': fresh ? '' : undefined,
        style
      }, `${prefix}${value}`);
    }

    const PILL_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      height: 28,
      padding: '0 10px',
      borderRadius: 14,
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))',
      background: 'var(--dsw-alias-bg-module-platform, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      font: 'inherit',
      fontSize: 13,
      cursor: 'pointer'
    };

    /**
     * The composer dock, centered above the input box. Renders nothing until the
     * newest turn has a change, so the composer keeps its usual height on a
     * quiet turn.
     *
     * The file list is a popover that floats ABOVE the pills: hovering the dock
     * opens it, leaving closes it — hover only, no click — and it never pushes
     * the composer down.
     */
    function ChangesDock({ sessionId, t, openReview }) {
      const [state] = useChanges(sessionId);
      const [hovering, setHovering] = React.useState(false);
      // A mounted popover fades out before unmounting, so the close transition runs.
      const [mounted, setMounted] = React.useState(false);
      // Room above the dock: the popover grows upwards, so a short window needs
      // its max height clamped to what actually fits instead of overflowing.
      const [room, setRoom] = React.useState(264);
      const dockRef = React.useRef(null);
      const closeTimer = React.useRef(undefined);
      const files = state.files;
      const open = hovering;

      React.useEffect(() => {
        if (open) {
          clearTimeout(closeTimer.current);
          setMounted(true);
          return;
        }
        // Keep it mounted while the fade-out plays, then drop it.
        closeTimer.current = setTimeout(() => setMounted(false), FADE_MS);
        return () => clearTimeout(closeTimer.current);
      }, [open]);

      // Measure the free space above the dock while open (and on resize).
      React.useEffect(() => {
        if (!open) return undefined;
        const measure = () => {
          const top = dockRef.current?.getBoundingClientRect().top ?? 300;
          setRoom(Math.max(96, Math.min(264, Math.round(top) - 16)));
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
      }, [open]);

      // A dock whose list emptied out has nothing to show.
      React.useEffect(() => {
        if (files.length === 0) setHovering(false);
      }, [files.length]);

      if (files.length === 0) return null;
      const totals = totalsOf(files);
      const label = files.length === 1 ? t('dock.one') : t('dock.many', { count: String(files.length) });
      return React.createElement('div', {
        ref: dockRef,
        'data-diff-review-dock': '',
        'data-open': open ? '' : undefined,
        style: {
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          width: '100%',
          // The 6px is the composer stack's own gap; the popover adds its own.
          padding: '0 0 6px'
        },
        onPointerEnter: () => setHovering(true),
        onPointerLeave: () => setHovering(false)
      },
      React.createElement('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }
      },
        React.createElement('button', {
          type: 'button',
          style: { ...PILL_STYLE, cursor: 'default' },
          'aria-expanded': open,
          'aria-haspopup': 'dialog'
        },
        // The list floats above, so the open state points the caret up.
        React.createElement('span', { 'aria-hidden': true, style: { opacity: 0.6, width: 8, flex: 'none' } }, open ? '▴' : '▸'),
        React.createElement('span', null, label),
        // The two counters hug each other: exactly one space-width (3.25px at
        // 13px) less than the pill's own 8px gap, so they read as a pair.
        React.createElement('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: 4.75 }
        },
        React.createElement(Bump, { value: totals.added, style: ADDED_STYLE, prefix: '+' }),
        React.createElement(Bump, { value: totals.deleted, style: DELETED_STYLE, prefix: '−' })))),
      mounted
        ? React.createElement('div', {
          // Hit-area bridge across the gap to the pills (see `.dsh-diff-review-bridge`).
          className: 'dsh-diff-review-bridge',
          'aria-hidden': true
        })
        : null,
      mounted
        ? React.createElement('div', {
          className: POPOVER_CLASS,
          role: 'dialog',
          'aria-label': t('dock.listTitle'),
          'data-state': open ? 'open' : 'closed',
          'data-diff-review-popover': '',
          style: {
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            // Rise from 4px below while fading in; reversed on the way out.
            transform: `translate(-50%, ${open ? '0' : '4px'})`,
            opacity: open ? 1 : 0,
            visibility: open ? 'visible' : 'hidden',
            pointerEvents: open ? 'auto' : 'none',
            zIndex: 30,
            // A grid, not a flex row: the name column takes its max-content
            // width (so the box hugs the longest name) while the two count
            // columns are shared, which right-aligns every counter. The columns
            // carry their own padding instead of one columnGap, so the pair of
            // counters can sit much tighter than name→counter.
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto auto',
            alignItems: 'center',
            columnGap: 0,
            rowGap: 1,
            // Hug the longest file name instead of stretching to a fixed column:
            // the box ends right after its content, and only clamps at the
            // composer width when a path is genuinely long.
            width: 'fit-content',
            maxWidth: 'min(560px, 92vw)',
            maxHeight: room,
            overflowY: 'auto',
            padding: 4,
            marginBottom: 6,
            borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24))',
            // An opaque surface: the composer/harness copy behind the list made a
            // translucent panel hard to read.
            background: 'var(--dsw-alias-bg-module-platform, #2a2a2e)',
            boxShadow: '0 8px 24px rgba(0,0,0,.32)'
          }
        }, files.map((file) => React.createElement('button', {
          key: file.path,
          type: 'button',
          onClick: () => openReview(file.path),
          title: file.path,
          style: {
            display: 'grid',
            gridTemplateColumns: 'subgrid',
            gridColumn: '1 / -1',
            alignItems: 'center',
            columnGap: 0,
            width: '100%',
            padding: '2px 6px',
            border: 'none',
            background: 'none',
            color: 'inherit',
            font: 'inherit',
            cursor: 'pointer',
            textAlign: 'left',
            borderRadius: 6
          }
        },
        // Name cell: the created badge (if any) then the path, kept left-aligned.
        // Its right padding is the name→counter gap (4px, one space at 12px mono).
        React.createElement('span', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            minWidth: 0,
            paddingRight: 4,
            overflow: 'hidden',
            justifyContent: 'flex-start'
          }
        },
        file.created ? React.createElement('span', { style: { fontSize: 11, opacity: 0.7, flex: 'none' } }, t('dock.created')) : null,
        React.createElement('span', {
          style: {
            ...CODE_STYLE,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }
        }, file.path)),
        // Counter cells: no column gap, only a 1.5px nib, so the pair reads as one
        // unit and sits about two space-widths tighter than the name→counter gap
        // (the name cell keeps that 4px padding on its right).
        React.createElement('span', {
          style: { display: 'flex', justifyContent: 'flex-end', paddingRight: 1.5 }
        }, React.createElement(Bump, { value: file.added ?? 0, style: { ...ADDED_STYLE, ...CODE_STYLE }, prefix: '+' })),
        React.createElement('span', {
          style: { display: 'flex', justifyContent: 'flex-end' }
        }, React.createElement(Bump, { value: file.deleted ?? 0, style: { ...DELETED_STYLE, ...CODE_STYLE }, prefix: '−' })))))
        : null);
    }

    /**
     * One file's unified rows with syntax coloring.
     *
     * The two recorded sides are highlighted as whole files (so block comments
     * and template literals tokenize across lines) and the row's own side index
     * picks its runs: a deleted row uses the before-side line, an added one the
     * after-side line, a context row the after side.
     *
     * Scrolling a long diff is the expensive part, so the rendered rows are
     * memoized on the payload and marked `content-visibility: auto`: off-screen
     * rows skip layout and paint entirely instead of being re-laid-out on every
     * frame.
     */
    function FileDiff({ sessionId, path, t }) {
      const [state, setState] = React.useState({ status: 'loading' });
      const [tick, setTick] = React.useState(0);
      const signature = React.useRef('');
      // `useCodeHighlighter` is a hook, so it must run on every render: hold the
      // module's function and call it with the detected language.
      const useHighlighter = primitives.useCodeHighlighter;
      const highlight = useHighlighter === undefined ? undefined : useHighlighter(primitives.languageForPath?.(path));
      React.useEffect(() => {
        const controller = new AbortController();
        setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));
        getJson(`${DIFF_ROUTE}?${new URLSearchParams({ sessionId, path })}`, controller.signal).then(
          (value) => {
            const next = `${value?.afterText?.length ?? 0}:${value?.beforeText?.length ?? 0}:${value?.rows?.length ?? 0}`;
            if (next === signature.current) return;
            signature.current = next;
            setState({ status: 'ready', value });
          },
          () => {
            if (!controller.signal.aborted) setState({ status: 'error' });
          }
        );
        return () => controller.abort();
      }, [sessionId, path, tick]);
      // Re-read while on screen: the dock and the turn keep changing the file.
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') setTick((value) => value + 1);
        }, POLL_MS);
        return () => clearInterval(timer);
      }, []);

      const value = state.value ?? {};
      const rows = Array.isArray(value.rows) ? value.rows : [];
      const beforeText = typeof value.beforeText === 'string' ? value.beforeText : undefined;
      const afterText = typeof value.afterText === 'string' ? value.afterText : undefined;

      // Highlighting and element construction are the two costly steps; both are
      // keyed on the payload, so a poll that changed nothing costs one refetch.
      const content = React.useMemo(() => {
        const hasSides = beforeText !== undefined && afterText !== undefined;
        const beforeRuns = typeof highlight === 'function' && hasSides ? highlight(beforeText) : undefined;
        const afterRuns = typeof highlight === 'function' && hasSides ? highlight(afterText) : undefined;

        /** Token runs of one row: its own side, the other side, then its own line. */
        const runsOf = (row) => {
          let runs;
          if (row.type === 'del') runs = row.old === undefined ? undefined : beforeRuns?.[row.old - 1];
          else if (row.new !== undefined) runs = afterRuns?.[row.new - 1];
          if (runs !== undefined) return runs;
          if (typeof highlight !== 'function' || typeof row.text !== 'string' || row.text === '') return undefined;
          return highlight(row.text)?.[0];
        };

        const backgrounds = {
          add: { background: 'var(--dsw-alias-code-diff-added, rgba(46,160,67,.14))' },
          del: { background: 'var(--dsw-alias-code-diff-deleted, rgba(248,81,73,.14))' },
          gap: { opacity: 0.5 }
        };

        const rowElement = (row, index) => {
          const runs = row.type === 'gap' ? undefined : runsOf(row);
          let code;
          if (row.type === 'gap') code = '⋯';
          else if (row.text === '') code = ' ';
          else if (runs === undefined) code = row.text;
          else {
            code = runs.map((run, runIndex) => React.createElement('span', {
              key: runIndex,
              style: run.style.color === undefined ? undefined : { color: run.style.color }
            }, run.text));
          }
          return React.createElement('div', {
            key: index,
            style: {
              display: 'flex',
              gap: 8,
              padding: '0 12px',
              whiteSpace: 'pre',
              ...(backgrounds[row.type] ?? {})
            }
          },
          React.createElement('span', { style: { width: 36, textAlign: 'right', opacity: 0.45, flex: 'none' } }, row.old ?? ''),
          React.createElement('span', { style: { width: 36, textAlign: 'right', opacity: 0.45, flex: 'none' } }, row.new ?? ''),
          React.createElement('span', null, code));
        };

        // Group into fixed chunks that carry `content-visibility: auto`. Chunking
        // beats putting it on every row: 2000 rows measured p50 20.6ms that way,
        // 16.6ms in ~60-row chunks (and 2000 containment boxes also cost far more
        // than the handful this makes). Off-screen chunks skip layout and paint,
        // and each declares its intrinsic height so the scrollbar stays honest.
        const chunks = [];
        for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
          const slice = rows.slice(start, start + CHUNK_ROWS);
          chunks.push(React.createElement('div', {
            key: start,
            style: {
              contentVisibility: 'auto',
              containIntrinsicSize: `auto ${slice.length * 18}px`
            }
          }, slice.map((row, offset) => rowElement(row, start + offset))));
        }
        return chunks;
      }, [rows, beforeText, afterText, highlight]);

      if (state.status === 'loading') return React.createElement('div', { style: { padding: 16, opacity: 0.7 } }, t('review.loading'));
      if (state.status === 'error') return React.createElement('div', { style: { padding: 16 } }, t('review.diffFailed'));

      return React.createElement('pre', {
        style: {
          margin: 0,
          padding: '6px 0',
          overflowX: 'auto',
          fontSize: 12,
          lineHeight: '18px',
          // One paint container for the whole block: keeps a horizontal scroll
          // from re-laying-out the tab strip and summary above it.
          contain: 'paint',
          ...CODE_STYLE
        }
      },
      content,
      value.truncated ? React.createElement('div', { style: { padding: '6px 12px', opacity: 0.7 } }, t('review.truncated')) : null);
    }

    /**
     * The review page. A browser-tab strip along the top picks the file; the
     * whole area under it is that file's diff — no side-by-side panes.
     */
    function ReviewPage({ sessionId, t, useTabInfo, notify }) {
      const { tab } = useTabInfo();
      const navigation = tab.navigation;
      const [state, reload] = useChanges(sessionId);
      const [selected, setSelected] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);
      const files = state.files;
      // A navigation parameter (`path`) from the dock picks that file.
      React.useEffect(() => {
        const path = navigation?.params?.path;
        if (typeof path === 'string') setSelected(path);
      }, [navigation?.revision, navigation?.params]);
      const current = selected !== undefined && files.some((file) => file.path === selected) ? selected : files[0]?.path;

      const revert = async (paths) => {
        setBusy(true);
        try {
          const response = await fetch(REVERT_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, paths })
          });
          const body = await response.json().catch(() => ({}));
          const failed = (Array.isArray(body?.files) ? body.files : [])
            .filter((file) => file.state !== 'restored' && file.state !== 'deleted');
          notify(
            failed.length === 0 ? 'info' : 'error',
            failed.length === 0 ? t('review.reverted') : t('review.revertPartial', { count: String(failed.length) })
          );
          reload();
        } catch {
          notify('error', t('review.revertFailed'));
        } finally {
          setBusy(false);
        }
      };

      if (state.status === 'ready' && files.length === 0) {
        return React.createElement('section', {
          'data-diff-review-page': '',
          style: { height: '100%', overflowY: 'auto' }
        },
        React.createElement('div', { style: { padding: '48px 16px', textAlign: 'center' } },
          React.createElement('div', { style: { fontSize: 15, fontWeight: 500 } }, t('review.empty')),
          React.createElement('div', { style: { opacity: 0.7, marginTop: 6 } }, t('review.emptyHint'))));
      }

      return React.createElement('section', {
        'data-diff-review-page': '',
        style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, fontSize: 13 }
      },
      // Top bar: the file strip (a browser-style tab per changed file) with the
      // bulk revert pinned at its right end. Everything below is the diff.
      React.createElement('div', {
        style: {
          display: 'flex',
          alignItems: 'flex-end',
          gap: 6,
          padding: '6px 8px 0',
          flex: 'none',
          borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))'
        }
      },
      React.createElement('div', {
        'data-diff-review-tabs': '',
        role: 'tablist',
        style: {
          display: 'flex',
          alignItems: 'flex-end',
          gap: 4,
          flex: 1,
          minWidth: 0,
          overflowX: 'auto',
          overflowY: 'hidden',
          paddingBottom: 0
        }
      }, files.map((file) => {
        const active = file.path === current;
        const name = file.path.split(/[\\/]/).at(-1) ?? file.path;
        const directory = file.path.slice(0, file.path.length - name.length).replace(/[\\/]+$/, '');
        return React.createElement('button', {
          key: file.path,
          type: 'button',
          role: 'tab',
          'aria-selected': active,
          title: file.created ? t('review.createdTitle', { path: file.path }) : file.path,
          onClick: () => setSelected(file.path),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            flex: 'none',
            maxWidth: 260,
            height: 30,
            padding: '0 10px',
            borderRadius: '8px 8px 0 0',
            border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))',
            borderBottom: `1px solid ${active ? ' transparent' : 'var(--dsw-alias-border-l1, rgba(127,127,127,.2))'}`,
            background: active
              ? 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,.10))'
              : 'transparent',
            color: active ? 'var(--dsw-alias-label-primary, inherit)' : 'var(--dsw-alias-label-tertiary, inherit)',
            font: 'inherit',
            fontSize: 12,
            cursor: 'pointer',
            marginBottom: active ? -1 : 0
          }
        },
        directory === '' ? null : React.createElement('span', {
          style: { opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto' }
        }, `${directory}/`),
        React.createElement('span', {
          style: { ...CODE_STYLE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto' }
        }, name),
        React.createElement(Bump, { value: file.added ?? 0, style: { ...ADDED_STYLE, ...CODE_STYLE, flex: 'none' }, prefix: '+' }),
        React.createElement(Bump, { value: file.deleted ?? 0, style: { ...DELETED_STYLE, ...CODE_STYLE, flex: 'none' }, prefix: '−' }));
      })),
      // Trailing action, pinned to the right of the strip.
      React.createElement('button', {
        type: 'button',
        disabled: busy,
        onClick: () => revert(files.map((file) => file.path)),
        style: {
          flex: 'none',
          height: 22,
          marginBottom: 4,
          padding: '0 9px',
          borderRadius: 11,
          border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))',
          background: 'none',
          color: 'inherit',
          font: 'inherit',
          fontSize: 12,
          cursor: 'pointer'
        }
      }, busy ? t('review.reverting') : t('review.revertAll'))),
      // Everything below is the chosen file's diff.
      React.createElement('div', { style: { flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' } },
        current === undefined ? null : React.createElement(FileDiff, { sessionId, path: current, t })));
    }

    /** The tab chip's text, kept in the current language through the live title seat. */
    function ReviewTitle({ t, useTabInfo }) {
      const { tab } = useTabInfo();
      const path = tab.navigation?.params?.path;
      return React.createElement('span', null, path === undefined ? t('tab.title') : t('tab.titlePath', { name: path.split(/[\\/]/).at(-1) }));
    }

    /** Services both surfaces need. */
    const inject = ['slots', 'locale', 'sessions', 'sidebarRight', 'sidebarRightTabs'];

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, {
        zh: {
          'dock.one': '1 个文件已更改',
          'dock.many': '{count} 个文件已更改',
          'dock.reviewTitle': '在右侧边栏查看具体改动',
          'dock.listTitle': '本轮改动的文件',
          'dock.created': '已创建',
          'tab.title': '改动审查',
          'tab.titlePath': '改动审查 · {name}',
          'review.loading': '正在计算差异…',
          'review.diffFailed': '差异读取失败。',
          'review.truncated': '文件较长，差异已截断。',
          'review.empty': '本轮没有改动文件',
          'review.emptyHint': '助手每次编辑文件后，改动都会出现在这里。',
          'review.revertAll': '全部还原',
          'review.reverting': '正在还原…',
          'review.reverted': '已还原本轮改动',
          'review.revertPartial': '有 {count} 个文件还原失败或已冲突',
          'review.revertFailed': '还原失败',
          'review.createdTitle': '{path}（新建）'
        },
        en: {
          'dock.one': '1 file changed',
          'dock.many': '{count} files changed',
          'dock.reviewTitle': 'Show the exact changes in the right sidebar',
          'dock.listTitle': 'Files changed this turn',
          'dock.created': 'created',
          'tab.title': 'Change review',
          'tab.titlePath': 'Change review · {name}',
          'review.loading': 'Computing the diff…',
          'review.diffFailed': 'Could not read the diff.',
          'review.truncated': 'The file is long; the diff was truncated.',
          'review.empty': 'No file changed this turn',
          'review.emptyHint': 'Every file the assistant edits shows up here.',
          'review.revertAll': 'Revert all',
          'review.reverting': 'Reverting…',
          'review.reverted': 'Reverted this turn',
          'review.revertPartial': '{count} file(s) failed to revert or had conflicts',
          'review.revertFailed': 'The revert failed',
          'review.createdTitle': '{path} (created)'
        }
      }), 'dsh-diff-review: dictionaries');

      // The dock above the composer. A negative order lifts it above the native
      // queue (20) and todo (0) docks, so this turn's diff sits on top and both
      // native lists keep their own markup and appearance underneath.
      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'diff-review-changes',
        order: -10,
        locale: NS,
        inject: (sessionId) => ({
          openReview: (path) => {
            const options = path === undefined ? {} : { params: { path } };
            ctx.sidebarRight.openResource(addressOf(sessionId), options);
          }
        })
      }, ChangesDock)), 'dsh-diff-review: composer dock');

      // The page type, its body, and its live title.
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        priority: 'extension',
        patterns: [`${ADDRESS}**`],
        canOpen: (address) => parseAddress(address) !== undefined,
        title: () => t('tab.title'),
        guide: [{
          id: 'open',
          order: 24,
          title: () => t('tab.title'),
          description: () => t('dock.reviewTitle'),
          ...(primitives.GuideArtworkFiles === undefined ? {} : { icon: primitives.GuideArtworkFiles })
        }]
      }), 'dsh-diff-review: tab type');

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
        locale: NS,
        inject: (sessionId) => ({
          // Session-scoped notice through the chat's own conversation service.
          notify: (level, text) => {
            try {
              const actx = ctx.sessions.scope(sessionId);
              actx.get('conversation').input.for(actx).notify(level, text);
            } catch { /* the notice is best-effort */ }
          }
        })
      }, ReviewPage)), 'dsh-diff-review: review body');

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: ID,
        locale: NS
      }, ReviewTitle)), 'dsh-diff-review: review title');
    }

    return { inject, apply };
  }
});


// hmr-probe-1792661663386
