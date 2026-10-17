import { useRef, useState } from 'react';

export function useActionFeedback() {
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; message: string; action?: string } | null>(null);
  const [pendingActions, setPendingActions] = useState<string[]>([]);
  const running = useRef(new Set<string>());
  const errorCount = useRef(0);

  const reportError = (error: unknown, action?: string) => {
    errorCount.current++;
    setFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error), action });
  };

  const withFeedback = <Args extends unknown[]>(label: string, task: (...args: Args) => Promise<void>) =>
    async (...args: Args): Promise<void> => {
      if (running.current.has(label)) return;
      running.current.add(label);
      setPendingActions([...running.current]);
      setFeedback(null);
      const previousErrors = errorCount.current;
      try {
        await task(...args);
        if (errorCount.current === previousErrors) {
          setFeedback({ kind: 'success', message: `${label}: resposta recebida.` });
        }
      } catch (error) {
        reportError(error, label);
      } finally {
        running.current.delete(label);
        setPendingActions([...running.current]);
      }
    };

  return { feedback, pendingActions, withFeedback, reportError, dismissFeedback: () => setFeedback(null) };
}
