import { signal } from '@angular/core';
import { errorMessage } from '../../core/api.service';

/** The loading / error / data triple every Storage page keeps, plus one `run` to fill it. */
export function loader<T>(fetch: () => Promise<T>) {
  const data = signal<T | null>(null);
  const loading = signal(false);
  const error = signal<string | null>(null);
  const run = async (): Promise<void> => {
    loading.set(true);
    error.set(null);
    try {
      data.set(await fetch());
    } catch (e) {
      error.set(errorMessage(e));
    } finally {
      loading.set(false);
    }
  };
  return { data, loading, error, run };
}

/** ISO date from the agent → ms for the formatters. */
export const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : 0);
