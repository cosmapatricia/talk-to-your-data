import type { GenerateResult, SchemaSnapshot, Snippet, SnippetsFile } from '../shared/types';
import schemaJson from '../shared/schema.json';
import snippetsJson from '../shared/snippets.json';
import { buildMessages } from './prompt';

const schema = schemaJson as unknown as SchemaSnapshot;
const snippets: Snippet[] = (snippetsJson as unknown as SnippetsFile).snippets;

/**
 * The model seam. Swapping Workers AI for a frontier model (Claude/GPT behind a key)
 * means implementing this interface and changing one line in `getProvider` — nothing
 * upstream changes. See PLAN.md ("generateSQL() seam").
 */
export interface SqlProvider {
  generate(question: string, context: Snippet[]): Promise<GenerateResult>;
}

// The default: Workers AI, no external key. A small Llama 3.x — deliberately the
// "weaker writer" from PLAN.md, so retrieval has something to prove and some
// golden-set failures may be model capability, not pipeline.
const WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

class WorkersAiProvider implements SqlProvider {
  constructor(private readonly ai: Ai) {}

  async generate(question: string, context: Snippet[]): Promise<GenerateResult> {
    const messages = buildMessages({ question, schema, snippets: context });
    const res = (await this.ai.run(WORKERS_AI_MODEL, { messages, max_tokens: 512 })) as {
      response?: string;
    };
    return parseResult(typeof res === 'string' ? res : res.response ?? '');
  }
}

/** Extracts {sql, rationale} from the model's text, tolerating prose or code fences around the JSON. */
function parseResult(text: string): GenerateResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('model did not return a JSON object');
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error('model returned malformed JSON');
  }
  const obj = parsed as { sql?: unknown; rationale?: unknown };
  if (typeof obj.sql !== 'string' || !obj.sql.trim()) throw new Error('model returned no SQL');
  return {
    sql: obj.sql.trim(),
    rationale: typeof obj.rationale === 'string' ? obj.rationale.trim() : '',
  };
}

export interface Env {
  AI: Ai;
}

function getProvider(env: Env): SqlProvider {
  return new WorkersAiProvider(env.AI);
}

/**
 * Generate SQL for a question. `withContext` toggles the retrieval snippets on/off —
 * the browser and the golden harness both use this to run the context-on vs
 * context-off A/B.
 */
export function generateSql(env: Env, question: string, withContext = true): Promise<GenerateResult> {
  return getProvider(env).generate(question, withContext ? snippets : []);
}
