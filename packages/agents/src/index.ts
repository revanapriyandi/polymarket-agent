import { createHash, randomUUID } from 'node:crypto';
import { pool, transaction } from '../../db/src/index.js';
import { d } from '../../core/src/ledger.js';
import { agentState } from '../../core/src/state.js';
import { toolBudget } from '../../core/src/tool-budget.js';
import type { AgentRole, ToolResult } from '../../shared/src/index.js';
import { skillFor, safeReadTools, validateToolInput, validateToolResult } from './registry.js';
export { skills, skillFor } from './registry.js';
export { researchMarket } from './research.js';
export interface ToolContext { signal: AbortSignal; operationId: string; maxCostUsd: string }
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value; }
/** Handler is trusted server code, never generated model code. Mutation idempotency belongs to its persisted business boundary. */
export async function runTool<T>(role: AgentRole, tool: string, jobId: string, input: Record<string, unknown>, handler: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult<T>>): Promise<ToolResult<T>> {
  const skill = skillFor(role);
  if (!skill.tools.includes(tool) || !/^[A-Za-z0-9:_-]{1,200}$/.test(jobId)) throw new Error('Tool or job not authorized');
  const validated = validateToolInput(role, tool, input), started = Date.now();
  const digest = createHash('sha256').update(JSON.stringify(canonical(validated))).digest('hex');
  const key = `tool:${jobId}:${role}:${tool}:${skill.version}:${digest}`, safe = safeReadTools.has(`${role}:${tool}`);
  if (safe) {
    const cached = (await pool.query('SELECT result FROM checkpoints WHERE id=$1 AND stage=$2', [key, 'tool-complete'])).rows[0];
    if (cached) { try { const result = validateToolResult(role, tool, cached.result); if (result.ok && Date.parse(result.observedAt) <= started + 1000 && Date.parse(result.freshUntil) > started && Date.parse(result.freshUntil) >= Date.parse(result.observedAt) && Date.parse(result.freshUntil) <= Date.parse(result.observedAt) + skill.freshnessSeconds * 1000) return result as ToolResult<T>; } catch { /* Invalid cached output cannot authorize a tool result. */ } }
  }
  const operationId = randomUUID(), budgetKey = `agent-budget:${jobId}:${role}`;
  const budgetRemaining = await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [budgetKey]);
    const prior = (await client.query('SELECT result FROM checkpoints WHERE id=$1', [budgetKey])).rows[0]?.result as { steps: number; startedAt: number } | undefined;
    const budget = prior ?? { steps: 0, startedAt: started };
    if (budget.steps >= skill.maxSteps || started - budget.startedAt >= skill.maxDurationMs) throw new Error('Agent step or elapsed budget exceeded');
    const cost = (await client.query('SELECT coalesce(sum(coalesce(cost,reserved_cost)),0)::text cost FROM invocations WHERE role=$1 AND created_at>=to_timestamp($2/1000.0)', [role, budget.startedAt])).rows[0].cost;
    if (d(cost).gte(skill.maxCostUsd)) throw new Error('Agent cost budget exceeded');
    const priorRun = (await client.query('SELECT result FROM tool_runs WHERE job_id=$1 AND role=$2 AND tool=$3', [jobId,role,tool])).rows[0];
    if (priorRun && !safe) throw new Error('Mutation already attempted; reconcile through persisted business state');
    if (priorRun?.result?.source === 'running' || priorRun?.result?.error?.code === 'TOOL_DEADLINE_UNCERTAIN') throw new Error('Tool outcome uncertain; reconcile before retry');
    await client.query("INSERT INTO checkpoints(id,stage,result) VALUES($1,'agent-budget',$2) ON CONFLICT(id) DO UPDATE SET result=excluded.result,updated_at=now()", [budgetKey, { ...budget, steps: budget.steps + 1 }]);
    await client.query("INSERT INTO tool_runs(job_id,role,skill,skill_version,tool,input,result,duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7,0) ON CONFLICT(job_id,role,tool) DO UPDATE SET input=excluded.input,result=excluded.result,duration_ms=0,created_at=now()", [jobId, role, skill.id, skill.version, tool, validated, { ok: false, source: 'running', observedAt: new Date(started).toISOString(), freshUntil: new Date(started).toISOString(), error: { code: 'RUNNING', message: 'Tool invocation reserved', retryable: false } }]);
    return { durationMs: skill.maxDurationMs - (started - budget.startedAt), costUsd: d(skill.maxCostUsd).minus(cost).toFixed() };
  });
  await agentState(role, { status: 'running', skill: skill.id, lastTool: tool, lastRunAt: new Date(started).toISOString(), reason: 'Tool running' });
  let result: ToolResult<T>;
  let deadlineExceeded = false;
  try {
    const signal = AbortSignal.timeout(budgetRemaining.durationMs);
    const returned = await new Promise<ToolResult<T>>((done, fail) => {
      const abort = () => { deadlineExceeded = true; fail(new Error('Tool deadline exceeded')); };
      signal.addEventListener('abort', abort, { once: true });
      toolBudget.run({remaining:d(budgetRemaining.costUsd),signal},()=>handler(validated, { signal, operationId, maxCostUsd: budgetRemaining.costUsd })).then(done, fail).finally(() => signal.removeEventListener('abort', abort));
    });
    signal.throwIfAborted();
    result = validateToolResult(role, tool, returned) as ToolResult<T>;
    const observed = Date.parse(result.observedAt), fresh = Date.parse(result.freshUntil);
    if (observed > Date.now() + 1000 || fresh < observed || fresh > observed + skill.freshnessSeconds * 1000 || result.ok && fresh <= Date.now()) throw new Error('Tool freshness invalid');
  } catch (error) {
    const code = deadlineExceeded ? 'TOOL_DEADLINE_UNCERTAIN' : error instanceof Error && error.name === 'ZodError' ? 'TOOL_OUTPUT_INVALID' : error instanceof Error && error.message === 'Tool freshness invalid' ? 'TOOL_FRESHNESS_INVALID' : error instanceof Error && error.message === 'Agent cost budget exceeded' ? 'TOOL_COST_EXCEEDED' : 'TOOL_HANDLER_FAILED';
    result = { ok: false, source: `${role}:${tool}`, observedAt: new Date().toISOString(), freshUntil: new Date().toISOString(), operationId, error: { code, message: deadlineExceeded ? 'Tool deadline exceeded; downstream work may still run. Reconcile before retry.' : `Tool rejected (${code}); mutation and billing outcomes may be uncertain`, retryable: false } };
  }
  await transaction(async client => {
    await client.query('UPDATE tool_runs SET result=$1,duration_ms=$2 WHERE job_id=$3 AND role=$4 AND tool=$5', [result, Date.now() - started, jobId,role,tool]);
    if (safe && result.ok) await client.query("INSERT INTO checkpoints(id,stage,result) VALUES($1,'tool-complete',$2) ON CONFLICT(id) DO UPDATE SET result=excluded.result,updated_at=now()", [key, result]);
  });
  await agentState(role, { status: result.ok ? 'idle' : 'blocked', reason: result.ok ? 'Tool completed' : result.error!.message, durationMs: Date.now() - started });
  await pool.query("UPDATE agents SET payload=jsonb_set(payload,'{runs}',to_jsonb(coalesce((payload->>'runs')::int,0)+1)),updated_at=now() WHERE role=$1", [role]);
  return result;
}
