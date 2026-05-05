/**
 * Setup wizard orchestrator (paraclaw#27 phase 1).
 *
 * Mounts at /setup. Renders the active step and a step indicator. State
 * lives in localStorage under SETUP_STORAGE_KEY so a tab close mid-install
 * survives — the bot token is the one thing we never persist (handled in
 * the credentials step itself).
 *
 * Step navigation:
 *   - The step indicator shows all 9 steps; the user can click any step at
 *     or before `furthestStep` to revisit it.
 *   - `next()` advances and stamps furthestStep monotonically.
 *   - `goto()` lets a step jump (e.g. credentials → install).
 *   - `back()` is purely visual — no state mutation.
 *
 * The orchestrator does NOT do smart-resume on its own. Each step renders
 * its current state from the server (PrereqStep polls /setup/status,
 * AdapterInstallStep polls the in-flight task, etc.) so the UI is always
 * faithful to the actual filesystem rather than what we think happened.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { AdapterInstallStep } from '../components/setup/AdapterInstallStep.tsx';
import { AgentGroupStep } from '../components/setup/AgentGroupStep.tsx';
import { ChannelPickStep } from '../components/setup/ChannelPickStep.tsx';
import { DoneStep } from '../components/setup/DoneStep.tsx';
import { PrereqStep } from '../components/setup/PrereqStep.tsx';
import { TestConnectionStep } from '../components/setup/TestConnectionStep.tsx';
import { TestMessageStep } from '../components/setup/TestMessageStep.tsx';
import { WireChannelStep } from '../components/setup/WireChannelStep.tsx';
import {
  ADAPTER_LABELS,
  DEFAULT_SETUP_STATE,
  SETUP_STEPS,
  SETUP_STORAGE_KEY,
  type SetupState,
  type SetupStepKey,
  type StepProps,
} from '../components/setup/types.ts';

function loadState(): SetupState {
  try {
    const raw = localStorage.getItem(SETUP_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETUP_STATE };
    const parsed = JSON.parse(raw) as Partial<SetupState>;
    return { ...DEFAULT_SETUP_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_SETUP_STATE };
  }
}

function saveState(state: SetupState): void {
  try {
    localStorage.setItem(SETUP_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded / private browsing; non-fatal.
  }
}

const STEP_INDEX: Record<SetupStepKey, number> = SETUP_STEPS.reduce(
  (acc, s, i) => {
    acc[s.key] = i;
    return acc;
  },
  {} as Record<SetupStepKey, number>,
);

export function SetupWizard() {
  const [state, setState] = useState<SetupState>(() => loadState());

  useEffect(() => {
    saveState(state);
  }, [state]);

  const patchState = useCallback((patch: Partial<SetupState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const goto = useCallback((step: SetupStepKey) => {
    setState((prev) => {
      const stepIdx = STEP_INDEX[step];
      const furthestIdx = STEP_INDEX[prev.furthestStep];
      return {
        ...prev,
        currentStep: step,
        furthestStep: stepIdx > furthestIdx ? step : prev.furthestStep,
      };
    });
  }, []);

  const next = useCallback(() => {
    setState((prev) => {
      const idx = STEP_INDEX[prev.currentStep];
      const nextIdx = Math.min(idx + 1, SETUP_STEPS.length - 1);
      const nextStep = SETUP_STEPS[nextIdx].key;
      const furthestIdx = STEP_INDEX[prev.furthestStep];
      return {
        ...prev,
        currentStep: nextStep,
        furthestStep: nextIdx > furthestIdx ? nextStep : prev.furthestStep,
      };
    });
  }, []);

  const back = useCallback(() => {
    setState((prev) => {
      const idx = STEP_INDEX[prev.currentStep];
      const prevStep = SETUP_STEPS[Math.max(idx - 1, 0)].key;
      return { ...prev, currentStep: prevStep };
    });
  }, []);

  const stepProps: StepProps = useMemo(
    () => ({ state, patchState, next, back, goto }),
    [state, patchState, next, back, goto],
  );

  const onReset = () => {
    if (
      !confirm(
        'Reset wizard state? This clears local progress (bot user id, agent group folder, etc.) but does NOT undo backend changes (installed adapters, agent groups, saved secrets).',
      )
    )
      return;
    localStorage.removeItem(SETUP_STORAGE_KEY);
    setState({ ...DEFAULT_SETUP_STATE });
  };

  return (
    <div>
      <Link to="/" className="muted">
        ← Skip setup, view groups
      </Link>
      <h2 style={{ marginTop: '0.5rem' }}>
        Set up parachute-agent
        {state.adapter && (
          <span className="dim" style={{ fontSize: '0.7em', marginLeft: '0.5rem' }}>
            · {ADAPTER_LABELS[state.adapter]}
          </span>
        )}
      </h2>
      <p className="muted" style={{ marginTop: '-0.5rem' }}>
        Fresh install? Walk these steps to land your first agent. You can re-open this wizard any time at <code>/agent/setup</code>.
      </p>
      <SetupStepIndicator current={state.currentStep} furthest={state.furthestStep} onJump={goto} />

      <div className="section">{renderStep(state.currentStep, stepProps)}</div>

      <div className="actions" style={{ marginTop: '1rem' }}>
        <button className="secondary" onClick={onReset}>
          Reset wizard
        </button>
      </div>
    </div>
  );
}

function renderStep(step: SetupStepKey, props: StepProps): ReactElement {
  switch (step) {
    case 'prereqs':
      return <PrereqStep {...props} />;
    case 'channel-pick':
      return <ChannelPickStep {...props} />;
    case 'install':
      return <AdapterInstallStep {...props} />;
    case 'test-connection':
      return <TestConnectionStep {...props} />;
    case 'agent-group':
      return <AgentGroupStep {...props} />;
    case 'wire-channel':
      return <WireChannelStep {...props} />;
    case 'test-message':
      return <TestMessageStep {...props} />;
    case 'done':
      return <DoneStep {...props} />;
  }
}

function SetupStepIndicator({
  current,
  furthest,
  onJump,
}: {
  current: SetupStepKey;
  furthest: SetupStepKey;
  onJump: (step: SetupStepKey) => void;
}) {
  const furthestIdx = STEP_INDEX[furthest];
  return (
    <ol className="wizard-steps">
      {SETUP_STEPS.map((s, i) => {
        const reachable = i <= furthestIdx;
        const isCurrent = s.key === current;
        return (
          <li key={s.key} className={`wizard-step${isCurrent ? ' active' : ''}`}>
            {reachable ? (
              <button
                type="button"
                onClick={() => onJump(s.key)}
                style={{
                  background: 'transparent',
                  border: 0,
                  padding: 0,
                  color: 'inherit',
                  font: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {s.label}
              </button>
            ) : (
              <span style={{ opacity: 0.6 }}>{s.label}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
