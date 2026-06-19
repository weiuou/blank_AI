import { FormEvent, KeyboardEvent, useState } from 'react';

type PromptComposerProps = {
  onSubmit: (prompt: string) => Promise<void> | void;
  onUndo?: () => Promise<void> | void;
  busy?: boolean;
  compact?: boolean;
  placeholder?: string;
  canUndo?: boolean;
};

export function PromptComposer({
  onSubmit,
  onUndo,
  busy = false,
  compact = false,
  placeholder = 'Describe the page you want to create...',
  canUndo = false,
}: PromptComposerProps) {
  const [value, setValue] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextValue = value.trim();
    if (!nextValue || busy) {
      return;
    }
    await onSubmit(nextValue);
    setValue('');
  }

  async function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && canUndo && onUndo) {
      event.preventDefault();
      await onUndo();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const nextValue = value.trim();
      if (!nextValue || busy) {
        return;
      }
      await onSubmit(nextValue);
      setValue('');
    }
  }

  return (
    <form className={compact ? 'prompt-composer prompt-composer--compact' : 'prompt-composer'} onSubmit={handleSubmit}>
      <textarea
        aria-label="Prompt input"
        className="prompt-composer__input"
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => void handleKeyDown(event)}
        placeholder={placeholder}
        rows={1}
        value={value}
      />
    </form>
  );
}
