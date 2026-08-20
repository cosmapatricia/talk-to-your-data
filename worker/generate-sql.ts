/// <reference types="@cloudflare/workers-types" />
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
    const res = await this.ai.run(WORKERS_AI_MODEL, { messages, max_tokens: 512 });
    return coerceResult(res);
  }
}

function finalize(sql: unknown, rationale: unknown): GenerateResult {
  const s = String(sql).trim();
  if (!s) throw new Error('model returned empty SQL');
  return { sql: s, rationale: typeof rationale === 'string' ? rationale.trim() : '' };
}

/**
 * Extracts {sql, rationale} from a Workers AI response. Text models vary in shape:
 * a bare string, `{ response: string }`, `{ response: {...} }`, or the object itself.
 * Unwrap all of them, then either use an object with `sql` directly or pull the first
 * JSON object out of the text. Errors carry a snippet so an unexpected shape is visible.
 */
function coerceResult(res: unknown): GenerateResult {
  let payload: unknown = res;
  if (res && typeof res === 'object' && 'response' in res) {
    payload = (res as { response: unknown }).response;
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const o = payload as Record<string, unknown>;
    if (typeof o.sql === 'string') return finalize(o.sql, o.rationale);
  }

  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? res);

  // Preferred: a complete JSON object somewhere in the text.
  const braces = text.match(/\{[\s\S]*\}/);
  if (braces) {
    try {
      const obj = JSON.parse(braces[0]) as Record<string, unknown>;
      if (typeof obj.sql === 'string') return finalize(obj.sql, obj.rationale);
    } catch {
      // fall through — the JSON was likely truncated (a cut-off rationale is common)
    }
  }

  // Fallback: the response was cut off mid-JSON but the sql field itself is complete.
  // Pull it out directly; re-parsing as a JSON string handles any escapes.
  const sqlField = text.match(/"sql"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (sqlField) {
    const rationaleField = text.match(/"rationale"\s*:\s*"((?:\\.|[^"\\])*)"/);
    return finalize(
      JSON.parse(`"${sqlField[1]}"`),
      rationaleField ? JSON.parse(`"${rationaleField[1]}"`) : '',
    );
  }

  throw new Error(`could not extract SQL from model response: ${text.slice(0, 200)}`);
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
