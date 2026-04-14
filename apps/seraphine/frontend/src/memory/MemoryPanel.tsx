import { useCallback, useEffect, useRef, useState } from 'react';

// Same origin — Vite proxies /memory to the backend.
const API_BASE = '';

interface Fact {
  id: string;
  text: string;
  source: string;
  confidence: number;
  created_at: string;
  superseded_by: string | null;
}

export function MemoryPanel(): JSX.Element {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [newFact, setNewFact] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchFacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/memory/facts?limit=100`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: Fact[] = await res.json();
      setFacts(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchFacts();
  }, [fetchFacts]);

  const handleAdd = async () => {
    const text = newFact.trim();
    if (!text) return;
    try {
      const res = await fetch(`${API_BASE}/memory/facts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source: 'explicit', confidence: 1.0 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNewFact('');
      await fetchFacts();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/memory/facts/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      setFacts((prev) => prev.filter((f) => f.id !== id));
    } catch (e) {
      setError(String(e));
    }
  };

  const handleEditStart = (fact: Fact) => {
    setEditingId(fact.id);
    setEditText(fact.text);
  };

  const handleEditSave = async () => {
    if (!editingId) return;
    const text = editText.trim();
    if (!text) return;
    try {
      const res = await fetch(`${API_BASE}/memory/facts/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditingId(null);
      setEditText('');
      await fetchFacts();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditText('');
  };

  const handleExport = async () => {
    try {
      const res = await fetch(`${API_BASE}/memory/export`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `seraphine-memorias-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleImport = async (file: File) => {
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const res = await fetch(`${API_BASE}/memory/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      setError(null);
      await fetchFacts();
      alert(`Importado: ${result.imported} | Ignorado (duplicados): ${result.skipped}`);
    } catch (e) {
      setError(String(e));
    }
  };

  const sourceLabel = (s: string) => {
    switch (s) {
      case 'reflection': return 'reflexao';
      case 'user_taught': return 'ensinado';
      case 'explicit': return 'manual';
      default: return s;
    }
  };

  return (
    <div className="memory-panel">
      <h3 className="memory-panel__title">Memorias</h3>

      {error && (
        <div className="memory-panel__error">
          {error}
          <button type="button" onClick={() => setError(null)}>x</button>
        </div>
      )}

      <div className="memory-panel__add">
        <input
          type="text"
          placeholder="Ensinar um fato novo..."
          value={newFact}
          onChange={(e) => setNewFact(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleAdd();
          }}
        />
        <button type="button" onClick={() => void handleAdd()} disabled={!newFact.trim()}>
          +
        </button>
      </div>

      {loading && <div className="memory-panel__loading">Carregando...</div>}

      <ul className="memory-panel__list">
        {facts.map((fact) => (
          <li key={fact.id} className="memory-panel__item">
            {editingId === fact.id ? (
              <div className="memory-panel__edit">
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={2}
                />
                <div className="memory-panel__edit-actions">
                  <button type="button" onClick={() => void handleEditSave()}>Salvar</button>
                  <button type="button" onClick={handleEditCancel}>Cancelar</button>
                </div>
              </div>
            ) : (
              <>
                <div className="memory-panel__text">{fact.text}</div>
                <div className="memory-panel__meta">
                  <span className="memory-panel__source">{sourceLabel(fact.source)}</span>
                  <span className="memory-panel__confidence">
                    {Math.round(fact.confidence * 100)}%
                  </span>
                </div>
                <div className="memory-panel__actions">
                  <button type="button" onClick={() => handleEditStart(fact)}>Editar</button>
                  <button
                    type="button"
                    className="memory-panel__delete"
                    onClick={() => void handleDelete(fact.id)}
                  >
                    Esquecer
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
        {!loading && facts.length === 0 && (
          <li className="memory-panel__empty">Nenhuma memoria ainda.</li>
        )}
      </ul>

      <div className="memory-panel__io">
        <button type="button" className="memory-panel__io-btn" onClick={() => void handleExport()}>
          Exportar
        </button>
        <button
          type="button"
          className="memory-panel__io-btn"
          onClick={() => fileInputRef.current?.click()}
        >
          Importar
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleImport(file);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
