// Validator seam — sits between "generate" and "run" in the loop.
//
// This is a PLACEHOLDER. The real defense-in-depth guard (AST/parser SELECT-only
// check + banned-function walk) is the next build step; see PLAN.md, validator
// section. For now it lets SQL through, and the DuckDB-WASM read-only sandbox
// (no httpfs, one registered file) is the current backstop. Keeping the seam here
// means wiring it in later is a one-function change, not a UI rewrite.

export interface ValidationResult {
  ok: boolean;
  message?: string;
}

export function validateSql(_sql: string): ValidationResult {
  return { ok: true };
}
