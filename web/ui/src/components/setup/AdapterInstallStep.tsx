/**
 * Step 4 — Adapter install.
 *
 * Triggers POST /setup/install-channel with the chosen adapter, then polls
 * GET /tasks/:id every second until the task lands in a terminal state.
 * Renders the per-step checklist live as the orchestrator advances.
 *
 * Per-channel step counts: discord = 5, telegram = 6 (extra
 * register-setup-step that wires the pair-telegram setup script).
 *
 * Idempotency: if the chosen adapter is already installed (status check
 * before dispatch shows channels.<adapter>.installed=true), we skip
 * kicking off the task and let the user advance immediately. The
 * dirty-tree 409 surfaces as an inline error with the offending file
 * list — operator commits/stashes and re-clicks.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getSetupStatus,
  getTask,
  startInstallChannel,
  type TaskRecord,
  type SetupStatus,
} from '../../lib/api.ts';
import { ADAPTER_LABELS, type StepProps } from './types.ts';

const POLL_MS = 1000;

export function AdapterInstallStep({ state, patchState, next, back }: StepProps) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirtyFiles, setDirtyFiles] = useState<string[] | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const adapter = state.adapter;

  useEffect(() => {
    getSetupStatus()
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const startPolling = useCallback((taskId: string) => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = setInterval(() => {
      getTask(taskId)
        .then((t) => {
          setTask(t);
          if (t.status === 'completed' || t.status === 'failed') {
            if (pollTimer.current) clearInterval(pollTimer.current);
            pollTimer.current = null;
          }
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
          if (pollTimer.current) clearInterval(pollTimer.current);
          pollTimer.current = null;
        });
    }, POLL_MS);
  }, []);

  useEffect(() => {
    if (state.installTaskId && !task) {
      getTask(state.installTaskId).then(setTask).catch(() => {
        patchState({ installTaskId: null });
      });
      startPolling(state.installTaskId);
    }
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [state.installTaskId, task, startPolling, patchState]);

  if (!adapter) {
    return (
      <>
        <h3>Install adapter</h3>
        <div className="error-banner">No channel selected — go back to step 2.</div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button className="secondary" onClick={back}>Back</button>
        </div>
      </>
    );
  }

  const onStart = async () => {
    setStarting(true);
    setError(null);
    setDirtyFiles(null);
    try {
      const res = await startInstallChannel(adapter);
      patchState({ installTaskId: res.taskId });
      startPolling(res.taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('uncommitted changes')) {
        setDirtyFiles([msg]);
      }
      setError(msg);
    } finally {
      setStarting(false);
    }
  };

  const installed = status?.channels[adapter]?.installed ?? false;
  const taskTerminal = task?.status === 'completed' || task?.status === 'failed';
  const adapterLabel = ADAPTER_LABELS[adapter];

  return (
    <>
      <h3>Install {adapterLabel} adapter</h3>
      {installed && !task && (
        <div className="empty empty-rich" style={{ marginTop: '0.5rem' }}>
          <p className="empty-headline" style={{ margin: 0 }}>{adapterLabel} adapter is already installed.</p>
          <p className="muted" style={{ marginTop: '0.4rem' }}>
            Move on to test the connection.
          </p>
        </div>
      )}

      {!installed && !task && (
        <p className="muted">
          {adapter === 'discord' ? (
            <>
              We'll fetch the adapter from the <code>channels</code> branch, copy it into <code>src/channels/discord.ts</code>,
              register the import, run <code>pnpm install @chat-adapter/discord</code>, and rebuild. Takes ~1–3 min depending on cache.
            </>
          ) : (
            <>
              We'll fetch the adapter from the <code>channels</code> branch, copy 6 files into <code>src/channels/</code> + <code>setup/</code>,
              register the import + setup step, run <code>pnpm install @chat-adapter/telegram</code>, and rebuild.
              Takes ~1–3 min depending on cache.
            </>
          )}
        </p>
      )}

      {task && (
        <ol style={{ listStyle: 'none', padding: 0, marginTop: '0.5rem' }}>
          {task.steps.map((s) => (
            <li key={s.name} style={{ padding: '0.4rem 0', display: 'flex', gap: '0.5rem' }}>
              <span aria-hidden style={{ width: '1.2rem' }}>
                {s.status === 'completed' ? '✓' : s.status === 'running' ? '…' : s.status === 'failed' ? '✗' : '○'}
              </span>
              <code>{s.name}</code>
              {s.error && <span className="dim" style={{ color: 'var(--error)' }}>— {s.error}</span>}
            </li>
          ))}
        </ol>
      )}

      {error && (
        <div className="error-banner" style={{ marginTop: '0.75rem' }}>
          {error}
          {dirtyFiles && (
            <p style={{ marginTop: '0.4rem' }}>
              Commit or stash the listed files, then click <strong>Retry</strong>.
            </p>
          )}
        </div>
      )}

      <div className="actions" style={{ marginTop: '1rem' }}>
        <button className="secondary" onClick={back}>Back</button>
        {!installed && (
          <button onClick={onStart} disabled={starting || (!!task && !taskTerminal)}>
            {starting ? 'Starting…' : task && !taskTerminal ? 'Installing…' : task?.status === 'failed' ? 'Retry install' : 'Start install'}
          </button>
        )}
        <button onClick={next} disabled={!installed && task?.status !== 'completed'}>
          Next: test connection
        </button>
      </div>
    </>
  );
}
