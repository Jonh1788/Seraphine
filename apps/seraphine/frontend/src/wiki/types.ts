export interface WikiIndexItem {
  slug: string;
  title: string;
  summary: string;
  category: string;
  updated_at: string;
}

export interface WikiPage {
  slug: string;
  title: string;
  category: string;
  updated_at: string;
  sources: string[];
  links: string[];
  body: string;
  backlinks: { slug: string; title: string }[];
}

export interface WikiGraph {
  nodes: { id: string; title: string; category: string }[];
  edges: { source: string; target: string }[];
}
