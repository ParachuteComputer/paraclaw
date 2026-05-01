/**
 * Step 6 — Agent group.
 *
 * Two paths:
 *
 *   (a) Pick an existing group. If the operator already has groups, list
 *       them and let them select one — the wire-channel step works the
 *       same way regardless of how the group was created.
 *
 *   (b) Create a new group inline. Vault attach is offered on the group
 *       detail page after setup, not here, to keep the wizard fast.
 *
 * The picker UI is shared with /channels/new — both are thin wrappers
 * around <AgentGroupPicker />. Once a group is picked / created, we
 * stamp `agentGroupFolder` and `agentGroupName` on the wizard state and
 * advance.
 */
import { AgentGroupPicker, type PickedGroup } from '../AgentGroupPicker.tsx';
import type { StepProps } from './types.ts';

export function AgentGroupStep({ patchState, next, back }: StepProps) {
  const onPicked = (g: PickedGroup) => {
    patchState({ agentGroupFolder: g.folder, agentGroupName: g.name });
    next();
  };

  return (
    <>
      <h3>Agent group</h3>
      <p className="muted">
        The agent group is the entity your bot represents. Pick an existing one or create a new one.
      </p>

      <AgentGroupPicker onPicked={onPicked} />

      <div className="actions" style={{ marginTop: '1rem' }}>
        <button className="secondary" onClick={back}>
          Back
        </button>
      </div>
    </>
  );
}
