import { z } from 'zod';

export const modes = ['paper', 'live'] as const;
export const ModeSchema = z.enum(modes);
export type Mode = z.infer<typeof ModeSchema>;
export const roles = ['scanner', 'research', 'forecast', 'strategy', 'risk', 'execution', 'portfolio', 'evaluation', 'supervisor'] as const;
export type AgentRole = typeof roles[number];
export const agentNames: Record<AgentRole, string> = { scanner: 'Market Scanner', research: 'Research Agent', forecast: 'Forecast Agent', strategy: 'Strategy Agent', risk: 'Risk Guardian', execution: 'Execution Agent', portfolio: 'Portfolio Agent', evaluation: 'Evaluation Agent', supervisor: 'Operations Supervisor' };
export const ProviderProtocolSchema = z.enum(['openai-responses', 'openai-chat', 'anthropic', 'google', 'custom-chat', 'custom-responses', 'custom-anthropic']);
export type ProviderProtocol = z.infer<typeof ProviderProtocolSchema>;
const money = z.string().regex(/^\d+(\.\d{1,8})?$/, 'Gunakan angka positif, maksimal 8 desimal');
const ratio = z.number().min(0).max(1);
export const ProviderConfigSchema = z.object({
  name: z.string().min(1).max(80), protocol: ProviderProtocolSchema, endpoint: z.string().url().optional().or(z.literal('')), model: z.string().min(1).max(200), enabled: z.boolean().default(false),
  timeoutMs: z.number().int().min(3000).max(120000).default(30000), maxOutputTokens: z.number().int().min(64).max(32000).default(2000), concurrency: z.number().int().min(1).max(8).default(1), retries: z.number().int().min(0).max(2).default(0), callsPerMinute: z.number().int().min(1).max(120).default(10),
  dailyBudgetUsd: money.default('0'), monthlyBudgetUsd: money.default('0'), inputPricePerMillion: money.optional(), outputPricePerMillion: money.optional(),
  billingMode: z.enum(['metered', 'internal-quota']).default('metered'),
  responseMode: z.enum(['json', 'sse']).default('json'),
  minimumCallIntervalMs: z.number().int().min(0).max(60000).default(0),
  callsPerDay: z.number().int().min(1).max(100000).default(300), callsPerMonth: z.number().int().min(1).max(3000000).default(9000),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export const ProviderSecretsSchema = z.object({ apiKey: z.string().max(4096).optional(), authHeader: z.string().max(100).optional(), headers: z.record(z.string(), z.string().max(4096)).default({}) });
export type ProviderSecrets = z.infer<typeof ProviderSecretsSchema>;
export interface Capabilities { text: boolean; tools: boolean; structured: boolean; usage: boolean; testedAt: string; errors: string[] }
export interface ProviderView extends ProviderConfig { id: string; version: number; hasSecret: boolean; capabilities: Capabilities | null; spentTodayUsd: string; spentMonthUsd: string; callsToday: number; callsMonth: number; status: 'unconfigured' | 'ready' | 'degraded' | 'blocked'; reason?: string }
export const AssignmentSchema = z.object({ role: z.enum(['research', 'forecast', 'evidence', 'summary']), primaryId: z.string().uuid(), fallbackEnabled: z.boolean().default(false), fallbackIds: z.array(z.string().uuid()).max(5).default([]) });
export type ModelAssignment = z.infer<typeof AssignmentSchema>;
export const RiskSettingsSchema = z.object({
  maxTotalLoss: money.refine(value => Number(value) > 0, 'Batas rugi total harus positif').optional(),
  capital: money, eventExposure: ratio.max(0.25), totalExposure: ratio.max(1), dailyLoss: ratio.min(0.001).max(0.25), maxDrawdown: ratio.min(0.001).max(0.5), slippageBps: z.number().int().min(0).max(500), maxRecoveryLoss: money, maxHoldingHours: z.number().int().min(1).max(720), minimumEdge: ratio.min(0.01), minimumLiquidity: money, minimumVolume: money, mergeCost: money, arbitrageAllocation: ratio, predictionAllocation: ratio,
}).refine(v => v.eventExposure <= v.totalExposure, 'Exposure event harus di bawah exposure total').refine(v => v.arbitrageAllocation + v.predictionAllocation <= 1, 'Total alokasi maksimal 100%');
export type RiskSettings = z.infer<typeof RiskSettingsSchema>;
export const SettingsSchema = z.object({ paper: RiskSettingsSchema, live: RiskSettingsSchema.nullable(), scanIntervalSeconds: z.number().int().min(15).max(3600), maxMarkets: z.number().int().min(2).max(200), paperLatencyMs: z.number().int().min(100).max(10000), paperFailureRate: ratio.max(0.25), researchDailyBudgetUsd: money, researchMonthlyBudgetUsd: money, infrastructureDailyCostUsd: money, serviceCostConversion: money, liveRiskAcknowledged: z.boolean(), walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).nullable(), strategyEnabled: z.object({ arbitrage: z.boolean(), prediction: z.boolean() }) });
export type Settings = z.infer<typeof SettingsSchema>;
export const defaultRisk: RiskSettings = { capital: '1000', eventExposure: .01, totalExposure: .1, dailyLoss: .01, maxDrawdown: .05, slippageBps: 30, maxRecoveryLoss: '1', maxHoldingHours: 168, minimumEdge: .05, minimumLiquidity: '1000', minimumVolume: '100', mergeCost: '0.01', arbitrageAllocation: .5, predictionAllocation: .5 };
export const defaultSettings: Settings = { paper: defaultRisk, live: null, scanIntervalSeconds: 60, maxMarkets: 40, paperLatencyMs: 750, paperFailureRate: .01, researchDailyBudgetUsd: '0', researchMonthlyBudgetUsd: '0', infrastructureDailyCostUsd: '0', serviceCostConversion: '1', liveRiskAcknowledged: false, walletAddress: null, strategyEnabled: { arbitrage: true, prediction: true } };
export interface Market { id: string; conditionId: string; eventId: string; slug: string; question: string; description: string; resolutionSource: string; rulesHash: string; yesToken: string; noToken: string; endDate: string; active: boolean; closed: boolean; acceptingOrders: boolean; negRisk: boolean; liquidity: string; volume: string; tickSize: string; minOrderSize: string; category: string; observedAt: string; resolved: boolean; outcomePrices: string[]; fee: { rate: string; exponent: number; takerOnly: boolean } | null }
export interface BookLevel { price: string; size: string }
export interface OrderBook { tokenId: string; bids: BookLevel[]; asks: BookLevel[]; tickSize: string; minOrderSize: string; observedAt: string; hash: string }
export interface Evidence { id: string; url: string; title: string; content: string; publishedAt: string | null; retrievedAt: string; primary: boolean; hash: string }
export const ForecastSchema = z.object({ probability: z.number().min(0.001).max(.999), lower: ratio, upper: ratio, confidence: ratio, abstain: z.boolean(), reason: z.string().min(1).max(4000), supportingSources: z.array(z.string().url()).max(20), opposingSources: z.array(z.string().url()).max(20), expiresAt: z.string().datetime() }).refine(v => v.lower <= v.probability && v.probability <= v.upper, 'Probability must lie inside interval');
export type Forecast = z.infer<typeof ForecastSchema>;
export interface OrderIntent { operationId: string; mode: Mode; strategy: 'arbitrage' | 'prediction' | 'exit'; marketId: string; conditionId: string; eventId: string; tokenId: string; side: 'BUY' | 'SELL'; shares: string; limitPrice: string; orderType: 'GTC' | 'GTD' | 'FOK' | 'FAK'; postOnly: boolean; expiration?: number; policyVersion: number; profileVersion: string; rulesHash: string; createdAt: string; maxCost: string; recoveryFor?: string }
export interface ToolResult<T = unknown> { ok: boolean; data?: T; error?: { code: string; message: string; retryable: boolean }; source: string; observedAt: string; freshUntil: string; operationId?: string }
export interface SkillDefinition { id: string; version: string; role: AgentRole; name: string; description: string; tools: string[]; maxSteps: number; maxDurationMs: number; maxCostUsd: string; freshnessSeconds: number; failurePolicy: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }
export interface AgentView { role: AgentRole; name: string; status: 'idle' | 'running' | 'waiting' | 'degraded' | 'blocked'; skill: string; lastTool: string | null; reason: string; heartbeatAt: string | null; lastRunAt: string | null; durationMs: number | null; runs: number }
export interface Readiness { key: string; name: string; state: 'unconfigured' | 'ready' | 'degraded' | 'blocked'; reason: string; checkedAt: string | null }
export interface Metrics { cash: string; reserved: string; available: string; positionValue: string | null; pendingSettlement: string; equity: string | null; realizedPnl: string; unrealizedPnl: string | null; totalPnl: string | null; tradingFees: string; operatingCosts: string; exposure: string; drawdown: string; dailyPnl: string; capital: string; unmarkedPositions: number }
export interface EquityPoint { time: number; equity: number; pnl: number; drawdown: number }
export interface Activity { id: string; at: string; role: string; level: 'info' | 'warning' | 'error'; title: string; detail: string }
export interface EvaluationView { strategy: string; profileVersion: string; paperDays: number; closedTrades: number; resolvedEvents: number; netPnl: string; maxDrawdown: string; unresolved: number; brier: number | null; baselineBrier: number | null; eligible: boolean; reasons: string[] }
export interface DashboardSnapshot { at: string; mode: Mode; control: 'running' | 'paused' | 'emergency' | 'risk-stopped'; policyVersion: number; metrics: Metrics; equity: EquityPoint[]; agents: AgentView[]; readiness: Readiness[]; activities: Activity[]; evaluations: EvaluationView[]; counts: Record<string, number>; worker: { online: boolean; heartbeatAt: string | null; feedConnected: boolean; reconciliationAt: string | null } }
export type TableName = 'positions' | 'orders' | 'opportunities' | 'decisions' | 'history' | 'forecasts' | 'invocations' | 'tools';
export interface TablePage { rows: Record<string, unknown>[]; total: number; page: number; pageSize: number }
