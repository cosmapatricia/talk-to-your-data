import { generateSql, type Env } from './generate-sql';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/generate-sql') {
      let body: { question?: unknown; withContext?: unknown };
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid JSON body' }, 400);
      }
      if (typeof body.question !== 'string' || !body.question.trim()) {
        return json({ error: 'a non-empty "question" string is required' }, 400);
      }
      // withContext defaults to true; the golden harness passes false for the no-context arm.
      const withContext = body.withContext !== false;
      try {
        const result = await generateSql(env, body.question.trim(), withContext);
        return json(result);
      } catch (err) {
        return json({ error: (err as Error).message }, 502);
      }
    }

    return json({ error: 'not found' }, 404);
  },
};
