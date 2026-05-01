/**
 * Picker that resolves an agent group — either an existing one (selected
 * from the list) or a new one created inline. Lifted out of the setup
 * wizard's step-6 component so the new /channels/new page can reuse the
 * same UX without duplicating the folder-availability + slug-suggestion
 * dance.
 *
 * The wizard's AgentGroupStep now thin-wraps this picker; the surface
 * isn't aware of wizard steps, just "give me a group, then call onPicked".
 *
 * What this component is NOT:
 *   - A vault-attach UI. Vault attach is offered on the group's detail page
 *     after creation. Keeping the picker minimal means the wire-channel
 *     flow stays under a minute.
 *   - A pre-existing group editor. Click-through to /groups/:folder for that.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  checkFolderAvailability,
  createGroup,
  fetchFolderSuggestion,
  listGroups,
  type AgentGroupView,
  type FolderAvailability,
} from '../lib/api.ts';

type Mode = 'pick' | 'create';

export interface PickedGroup {
  id: string;
  folder: string;
  name: string;
}

export interface AgentGroupPickerProps {
  /** Called once a group is picked or created. The caller decides what's next. */
  onPicked: (group: PickedGroup) => void;
  /** When true, hides the "Pick existing" affordance — used in flows that
   *  always want a fresh group. Default: false (offer pick when groups exist). */
  forceCreate?: boolean;
  /** Optional initial mode preference; ignored when there are 0 existing groups. */
  initialMode?: Mode;
}

export function AgentGroupPicker({ onPicked, forceCreate = false, initialMode }: AgentGroupPickerProps) {
  const [groups, setGroups] = useState<AgentGroupView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode ?? 'pick');

  useEffect(() => {
    let cancelled = false;
    listGroups()
      .then((g) => {
        if (cancelled) return;
        setGroups(g);
        if (g.length === 0 || forceCreate) setMode('create');
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [forceCreate]);

  if (loadError) {
    return (
      <div className="error-banner">
        Couldn't load groups: <code>{loadError}</code>
      </div>
    );
  }
  if (!groups) {
    return (
      <ul className="skeleton-list" aria-busy="true">
        <li className="skeleton skeleton-row" />
      </ul>
    );
  }

  const onPick = (g: AgentGroupView) => onPicked({ id: g.id, folder: g.folder, name: g.name });

  return (
    <div>
      {!forceCreate && groups.length > 0 && (
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
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                }}
              >
                <div>
                  <strong>{g.name}</strong> <code className="dim">{g.folder}</code>
                  {g.vault && (
                    <span className="tag" style={{ marginLeft: '0.5rem' }}>
                      {g.vault.scope}
                    </span>
                  )}
                </div>
                <button onClick={() => onPick(g)}>Use this group</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {mode === 'create' && <CreateGroupInline onCreated={onPicked} />}
    </div>
  );
}

function CreateGroupInline({ onCreated }: { onCreated: (g: PickedGroup) => void }) {
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
        // Suggestion failure is non-fatal; operator can type their own slug.
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
    name.trim().length > 0 &&
    folder.length > 0 &&
    folderCheck?.valid === true &&
    folderCheck?.available === true;

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await createGroup({ name: name.trim(), folder });
      onCreated({ id: r.group.id, folder: r.group.folder, name: r.group.name });
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
        <input
          id="newName"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Forge"
          autoFocus
        />
      </div>
      <div className="row">
        <label htmlFor="newFolder">Folder slug</label>
        <input
          id="newFolder"
          type="text"
          value={folder}
          onChange={(e) => onFolderChange(e.target.value)}
          placeholder="e.g. forge"
        />
        {folder && folderChecking && (
          <p className="dim">
            Checking <code>{folder}</code>…
          </p>
        )}
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
