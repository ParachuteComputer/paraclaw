/**
 * Step 6 — Agent group.
 *
 * Two paths:
 *
 *   (a) Pick an existing group. If the operator already has groups, list
 *       them and let them select one — the wire-channel step works the
 *       same way regardless of how the group was created.
 *
 *   (b) Create a new group inline. We don't reuse <NewGroupWizard /> as a
 *       sub-component because its three-step internal navigation would
 *       fight the parent wizard's step indicator. Instead we render a
 *       trimmed inline form (name + folder + auto-suggested folder) and
 *       create immediately. Vault attach is offered but defaults to
 *       "skip — attach later" to keep the setup wizard fast; the
 *       operator can attach a vault from the group detail page.
 *
 * Once a group exists / is selected, we stamp `agentGroupFolder` and
 * `agentGroupName` on the wizard state and advance.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkFolderAvailability,
  createGroup,
  fetchFolderSuggestion,
  listGroups,
  type AgentGroupView,
  type FolderAvailability,
} from '../../lib/api.ts';
import type { StepProps } from './types.ts';

type Mode = 'pick' | 'create';

export function AgentGroupStep({ state, patchState, next, back }: StepProps) {
  const [groups, setGroups] = useState<AgentGroupView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('pick');

  useEffect(() => {
    let cancelled = false;
    listGroups()
      .then((g) => {
        if (cancelled) return;
        setGroups(g);
        // Default mode based on what's there.
        if (g.length === 0) setMode('create');
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onPick = (g: AgentGroupView) => {
    patchState({ agentGroupFolder: g.folder, agentGroupName: g.name });
    next();
  };

  if (loadError) {
    return (
      <>
        <h3>Agent group</h3>
        <div className="error-banner">Couldn't load groups: <code>{loadError}</code></div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button className="secondary" onClick={back}>Back</button>
        </div>
      </>
    );
  }

  if (!groups) {
    return (
      <>
        <h3>Agent group</h3>
        <ul className="skeleton-list" aria-busy="true"><li className="skeleton skeleton-row" /></ul>
      </>
    );
  }

  return (
    <>
      <h3>Agent group</h3>
      <p className="muted">
        The agent group is the entity your bot represents. Pick an existing one or create a new one.
      </p>

      {groups.length > 0 && (
        <div className="row" style={{ marginTop: '0.5rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className={mode === 'pick' ? '' : 'secondary'} onClick={() => setMode('pick')}>
              Pick existing ({groups.length})
            </button>
            <button className={mode === 'create' ? '' : 'secondary'} onClick={() => setMode('create')}>
              Create new
            </button>
          </div>
        </div>
      )}

      {mode === 'pick' && groups.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: '0.5rem' }}>
          {groups.map((g) => (
            <li key={g.id} style={{ padding: '0.6rem 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                <div>
                  <strong>{g.name}</strong> <code className="dim">{g.folder}</code>
                  {g.vault && <span className="tag" style={{ marginLeft: '0.5rem' }}>{g.vault.scope}</span>}
                </div>
                <button onClick={() => onPick(g)}>Use this group</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {mode === 'create' && <CreateGroupInline state={state} patchState={patchState} next={next} />}

      <div className="actions" style={{ marginTop: '1rem' }}>
        <button className="secondary" onClick={back}>Back</button>
      </div>
    </>
  );
}

function CreateGroupInline({
  patchState,
  next,
}: {
  state: StepProps['state'];
  patchState: StepProps['patchState'];
  next: StepProps['next'];
}) {
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [folderTouched, setFolderTouched] = useState(false);
  const [folderCheck, setFolderCheck] = useState<FolderAvailability | null>(null);
  const [folderChecking, setFolderChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-suggest folder slug from name.
  useEffect(() => {
    if (folderTouched) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setFolder('');
      return;
    }
    let cancelled = false;
    fetchFolderSuggestion(trimmed)
      .then((slug) => !cancelled && !folderTouched && setFolder(slug))
      .catch(() => {
        // Suggestion failure is non-fatal.
      });
    return () => {
      cancelled = true;
    };
  }, [name, folderTouched]);

  // Debounced folder availability.
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!folder) {
      setFolderCheck(null);
      return;
    }
    if (checkTimer.current) clearTimeout(checkTimer.current);
    setFolderChecking(true);
    checkTimer.current = setTimeout(async () => {
      try {
        setFolderCheck(await checkFolderAvailability(folder));
      } catch (err) {
        setFolderCheck({
          slug: folder,
          valid: false,
          available: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setFolderChecking(false);
      }
    }, 250);
    return () => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
    };
  }, [folder]);

  const onFolderChange = useCallback((next: string) => {
    setFolderTouched(true);
    setFolder(next);
  }, []);

  const ready =
    name.trim().length > 0 && folder.length > 0 && folderCheck?.valid === true && folderCheck?.available === true;

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await createGroup({ name: name.trim(), folder });
      patchState({ agentGroupFolder: r.group.folder, agentGroupName: r.group.name });
      next();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onCreate} style={{ marginTop: '0.5rem' }}>
      <div className="row">
        <label htmlFor="newName">Name</label>
        <input id="newName" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Forge" autoFocus />
      </div>
      <div className="row">
        <label htmlFor="newFolder">Folder slug</label>
        <input id="newFolder" type="text" value={folder} onChange={(e) => onFolderChange(e.target.value)} placeholder="e.g. forge" />
        {folder && folderChecking && <p className="dim">Checking <code>{folder}</code>…</p>}
        {folder && !folderChecking && folderCheck && !folderCheck.valid && (
          <p className="wizard-folder-error">{folderCheck.reason ?? 'Invalid slug.'}</p>
        )}
        {folder && !folderChecking && folderCheck && folderCheck.valid && !folderCheck.available && (
          <p className="wizard-folder-error">{folderCheck.reason ?? 'Already taken.'}</p>
        )}
        {folder && !folderChecking && folderCheck && folderCheck.valid && folderCheck.available && (
          <p className="wizard-folder-ok">
            <code>groups/{folder}/</code> is available.
          </p>
        )}
      </div>
      <p className="dim">
        Vault attach skipped here — you can do it from the group's detail page after setup. Keeps this flow short.
      </p>
      {error && <div className="error-banner">{error}</div>}
      <div className="actions" style={{ marginTop: '0.75rem' }}>
        <button type="submit" disabled={!ready || submitting}>
          {submitting ? 'Creating…' : 'Create + use this group'}
        </button>
      </div>
    </form>
  );
}
