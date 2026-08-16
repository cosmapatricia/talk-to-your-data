import type { SchemaSnapshot, Snippet } from '../shared/types';

/** Compact schema rendering: table grain + row count + date range, then `name type` per column. */
function renderSchema(schema: SchemaSnapshot): string {
  return schema.tables
    .map((t) => {
      const cols = t.columns.map((c) => `${c.name} ${c.type}`).join(', ');
      const range = t.date_range ? `, dates ${t.date_range[0]}..${t.date_range[1]}` : '';
      return `${t.name} (${t.grain}; ${t.row_count} rows${range}):\n  ${cols}`;
    })
    .join('\n');
}

const SYSTEM = [
  'You translate an English question into a single read-only DuckDB SQL query over the given schema.',
  '',
  'Hard rules:',
  '- Output exactly ONE statement. It must be a SELECT (a leading WITH ... is allowed only if it resolves to a SELECT).',
  '- Never emit INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, ATTACH, COPY, INSTALL, LOAD, PRAGMA, SET, or CALL.',
  '- Use only the tables and columns given in the schema. Do not invent columns.',
  '- Categorical columns are stored as INTEGER CODES, not text. Use the provided context to map words to codes',
  '  (e.g. "fog" is a weather code, "fatal" is a severity code). Never compare a coded column to a string.',
  '- Exclude sentinel codes (-1 = missing, and 9/99 = unknown where noted) from category breakdowns and from',
  '  rate denominators, unless the question is explicitly about missing/unknown data.',
  '',
  'Respond with ONLY a JSON object and nothing else:',
  '{"sql": "<the DuckDB SELECT>", "rationale": "<one sentence explaining the mapping/assumptions>"}',
].join('\n');

export interface PromptInput {
  question: string;
  schema: SchemaSnapshot;
  snippets: Snippet[];
}

/** Builds the chat messages. `snippets` is the retrieval context; pass [] for the no-context A/B arm. */
export function buildMessages(input: PromptInput): { role: 'system' | 'user'; content: string }[] {
  const context = input.snippets.length
    ? input.snippets.map((s) => `- ${s.text}`).join('\n')
    : '(no dataset context provided)';

  const user = [
    `Schema:\n${renderSchema(input.schema)}`,
    ``,
    `Dataset context:\n${context}`,
    ``,
    `Question: ${input.question}`,
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
