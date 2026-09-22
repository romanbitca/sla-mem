import { useId, useRef, useState } from 'react';
import { AI_MODELS, type AiKeyStatusDTO, type AiModel } from '../../../shared/types';
import { AI_MODEL_INFO } from '../../lib/aiModels';
import { describeError } from '../../lib/api';
import { useFlag } from '../../lib/hooks';
import { useOpenExternal, useRemoveAiKey, useSaveAiKey, useUpdatePreferences } from '../../lib/queries';
import { AlertIcon, CheckIcon, ExternalLinkIcon, InfoIcon, KeyIcon, SparklesIcon, TrashIcon } from '../icons';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Callout';
import { Card } from '../ui/Card';
import { ConfirmDialog } from '../ui/Dialog';
import { FieldError, SecretInput, Select, SettingRow } from './fields';

/** Where Anthropic's Console lists API keys (console.anthropic.com redirects here). */
export const ANTHROPIC_KEYS_URL = 'https://platform.claude.com/settings/keys';

/**
 * Ask AI: the reader's own Anthropic API key and which Claude model answers. The key is checked
 * with Anthropic before it's saved, kept encrypted like the Slack sign-in, and never shown again
 * (only its last four characters). What leaves the computer, and when, is said right here.
 */
export function AskAiCard({ ai, model }: { ai: AiKeyStatusDTO; model: AiModel }) {
  const save = useSaveAiKey();
  const remove = useRemoveAiKey();
  const update = useUpdatePreferences();
  const openConsole = useOpenExternal();
  const [key, setKey] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [saved, flashSaved] = useFlag(2000);
  const removeRef = useRef<HTMLButtonElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const ids = { key: useId(), keyHint: useId(), model: useId(), modelHint: useId() };

  const submit = () => {
    if (!key.trim() || save.isPending) return;
    save.mutate(key.trim(), {
      onSuccess: () => {
        setKey('');
        flashSaved();
      },
    });
  };

  return (
    <Card
      id="ask-ai"
      title="Ask AI"
      icon={<SparklesIcon size={15} />}
      aside={
        <span role="status" className="text-xs text-ink-faint">
          {update.isPending ? (
            'Saving…'
          ) : saved ? (
            <span className="inline-flex items-center gap-1 text-success">
              <CheckIcon size={13} /> Saved
            </span>
          ) : null}
        </span>
      }
    >
      <p className="text-[13.5px] leading-relaxed text-ink-muted">
        Ask about your archive in plain words, like “Where did Ana mention the tests?” or “What happened in #design this
        week?”. Claude, by Anthropic, searches the archive and answers with links to the messages. It uses your own API
        key, so you pay Anthropic for what you ask; each answer shows what it cost.
      </p>
      <Callout tone="info" icon={<InfoIcon size={15} />}>
        When you ask, your question and the messages Claude reads from your archive are sent to Anthropic to write the
        answer. Nothing is sent otherwise, and chats aren’t saved.
      </Callout>

      <div className="flex flex-col divide-y divide-line">
        <SettingRow
          label="Anthropic API key"
          labelId={ids.key}
          htmlFor={ai.saved ? undefined : `${ids.key}-input`}
          descriptionId={ids.keyHint}
          description={
            ai.saved ? (
              <>Saved, ending in “{ai.hint}”. It’s kept encrypted on this computer.</>
            ) : (
              <>
                Create one in the{' '}
                <button
                  type="button"
                  onClick={() => openConsole.mutate(ANTHROPIC_KEYS_URL)}
                  className="focus-ring inline-flex items-center gap-0.5 rounded font-medium text-accent-text hover:underline"
                >
                  Anthropic Console
                  <ExternalLinkIcon size={11} />
                </button>
                , then paste it here.
              </>
            )
          }
        >
          {ai.saved ? (
            <Button ref={removeRef} variant="danger" icon={<TrashIcon size={14} />} onClick={() => setConfirming(true)}>
              Remove
            </Button>
          ) : (
            <form
              className="flex w-full items-center gap-2 sm:w-auto"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <SecretInput
                ref={keyInputRef}
                id={`${ids.key}-input`}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  if (save.isError) save.reset();
                }}
                placeholder="sk-ant-…"
                aria-describedby={ids.keyHint}
                invalid={save.isError}
                className="min-w-0 flex-1 sm:w-64"
              />
              <Button
                type="submit"
                variant="primary"
                icon={<KeyIcon size={14} />}
                loading={save.isPending}
                disabled={!key.trim()}
              >
                {save.isPending ? 'Checking…' : 'Save'}
              </Button>
            </form>
          )}
        </SettingRow>
        <SettingRow
          label="Model"
          labelId={ids.model}
          htmlFor={`${ids.model}-select`}
          descriptionId={ids.modelHint}
          description={
            model === 'claude-opus-5' ? (
              <span className="inline-flex items-start gap-1 text-warn">
                <AlertIcon size={13} className="mt-px shrink-0" />
                <span>
                  Opus is the most expensive model: each answer costs about 2.5 times as much as with Sonnet. Use it
                  only now and then, for questions Sonnet can’t answer.
                </span>
              </span>
            ) : (
              'Sonnet gives the best balance of answers, speed and price. Haiku is faster and costs half as much.'
            )
          }
        >
          <Select
            id={`${ids.model}-select`}
            value={model}
            aria-describedby={ids.modelHint}
            onChange={(e) => update.mutate({ aiModel: e.target.value as AiModel }, { onSuccess: flashSaved })}
            className="w-full sm:w-84"
          >
            {AI_MODELS.map((m) => (
              <option key={m} value={m}>
                {AI_MODEL_INFO[m].name} — {AI_MODEL_INFO[m].note}
              </option>
            ))}
          </Select>
        </SettingRow>
      </div>
      {save.isError && <FieldError>{describeError(save.error)}</FieldError>}
      {update.isError && <FieldError>Couldn’t save: {describeError(update.error)}</FieldError>}
      {openConsole.isError && <FieldError>{describeError(openConsole.error)}</FieldError>}

      <ConfirmDialog
        open={confirming}
        title="Remove the API key?"
        description="Ask AI stops answering until you add a key again. Nothing else changes."
        confirmLabel="Remove"
        destructive
        busy={remove.isPending}
        returnFocusRef={removeRef}
        error={remove.isError ? describeError(remove.error) : null}
        onCancel={() => {
          setConfirming(false);
          remove.reset();
        }}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              setConfirming(false);
              // The Remove button is gone: the key box that replaces it takes the focus.
              requestAnimationFrame(() => keyInputRef.current?.focus());
            },
          })
        }
      />
    </Card>
  );
}
