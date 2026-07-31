import { useEffect, useState } from 'react';

export interface FetchState<T> { data: T | null; error: string | null; loading: boolean }

/** Busca JSON distinguindo TRÊS estados: carregando, erro e dado (que pode ser vazio).
 *  O helper anterior engolia o erro com `.catch(() => {})`, e falha de rede ficava
 *  indistinguível de "não há dados" — a tela apenas sumia. */
export function useFetchJson<T>(url: string | null): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({ data: null, error: null, loading: url !== null });

  useEffect(() => {
    if (url === null) { setState({ data: null, error: null, loading: false }); return; }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as T;
      })
      .then((d) => { if (alive) setState({ data: d, error: null, loading: false }); })
      .catch((e: unknown) => {
        if (alive) setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false });
      });
    return () => { alive = false; };
  }, [url]);

  return state;
}
