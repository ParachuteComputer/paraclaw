/**
 * Step 9 — Done.
 *
 * Terminal state. Links to the agent group's detail page so the operator
 * can see the live session and inspect status. Does NOT clear the
 * localStorage state — re-opening /setup just lands here, which is the
 * desired behavior (you can revisit any step via the indicator).
 */
import { Link } from 'react-router-dom';
import { ADAPTER_LABELS, SETUP_STORAGE_KEY, type StepProps } from './types.ts';

export function DoneStep({ state }: StepProps) {
  const folder = state.agentGroupFolder;
  const channel = state.adapter ? ADAPTER_LABELS[state.adapter] : 'your channel';
  return (
    <>
      <h3>Done.</h3>
      <p>
        <code>{state.agentGroupName ?? folder}</code> is wired to {channel} and your first inbound has round-tripped.
      </p>

      <div className="actions" style={{ marginTop: '1rem' }}>
        {folder && (
          <Link to={`/groups/${encodeURIComponent(folder)}`}>
            <button>Open group</button>
          </Link>
        )}
        <Link to="/">
          <button className="secondary">All groups</button>
        </Link>
        <button
          className="secondary"
          onClick={() => {
            if (
              confirm(
                'Clear local wizard state? Returning to /claw/setup later will restart from step 1 (your installed adapters / agent groups / wired channels are unaffected).',
              )
            ) {
              localStorage.removeItem(SETUP_STORAGE_KEY);
              window.location.href = '/';
            }
          }}
        >
          Clear wizard state
        </button>
      </div>
    </>
  );
}
