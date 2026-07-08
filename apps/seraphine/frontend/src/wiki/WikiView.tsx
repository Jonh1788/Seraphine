import './obsidian.css';

import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';

import { getWikiGraph, getWikiPage, listWikiIndex } from './api';
import type { WikiGraph, WikiPage } from './types';

interface WikiViewProps { onBack: () => void; }

export function WikiView({ onBack }: WikiViewProps) {
  const [graph, setGraph] = useState<WikiGraph>({ nodes: [], edges: [] });
  const [page, setPage] = useState<WikiPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 400, h: 400 });

  useEffect(() => {
    getWikiGraph().then(setGraph).catch((e) => setError(String(e)));
    listWikiIndex().then((items) => {
      if (items[0]) void openPage(items[0].slug);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  async function openPage(slug: string) {
    try { setPage(await getWikiPage(slug)); } catch (e) { setError(String(e)); }
  }

  // react-force-graph wants { nodes, links } with source/target.
  const graphData = useMemo(() => ({
    nodes: graph.nodes.map((n) => ({ id: n.id, name: n.title })),
    links: graph.edges.map((e) => ({ source: e.source, target: e.target })),
  }), [graph]);

  return (
    <div className="wiki">
      <div className="wiki__graph" ref={wrapRef}>
        <ForceGraph2D
          width={dims.w}
          height={dims.h}
          graphData={graphData}
          nodeLabel="name"
          onNodeClick={(n: { id?: string | number }) => { if (n.id) void openPage(String(n.id)); }}
        />
      </div>
      <div className="wiki__panel">
        <button type="button" onClick={onBack} className="btn-back">← Chat</button>
        {error && <div className="wiki__empty">{error}</div>}
        {!page && !error && <div className="wiki__empty">A wiki ainda está vazia — rode uma pesquisa ou anexe um PDF; ela é montada à noite.</div>}
        {page && (
          <article>
            <h1>{page.title}</h1>
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{page.body}</Markdown>
            {page.sources.length > 0 && (
              <div className="wiki__src">Fontes: {page.sources.join(', ')}</div>
            )}
            {page.backlinks.length > 0 && (
              <div className="wiki__src">
                Linkado por: {page.backlinks.map((b) => (
                  <a key={b.slug} href="#" onClick={(e) => { e.preventDefault(); void openPage(b.slug); }}>{b.title} </a>
                ))}
              </div>
            )}
          </article>
        )}
      </div>
    </div>
  );
}
