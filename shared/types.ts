// Shared types used by both the Worker (SQL generation) and the browser (loop + render).

export interface SchemaColumn {
  name: string;
  type: string;
}

export interface SchemaTable {
  name: string;
  grain: string;
  file: string;
  row_count: number;
  date_range?: [string, string];
  columns: SchemaColumn[];
}

export interface SchemaSnapshot {
  dialect: string;
  tables: SchemaTable[];
}

export interface Snippet {
  id: string;
  category: string;
  text: string;
}

export interface SnippetsFile {
  table: string;
  snippets: Snippet[];
}

/** What the Worker returns to the browser: the proposed SQL plus a one-line rationale. */
export interface GenerateResult {
  sql: string;
  rationale: string;
}
