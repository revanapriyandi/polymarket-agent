import type { ProviderConfig } from '../../../packages/shared/src/index';

export const settingLabels: Record<string, string> = {
  capital: 'Modal (pUSD)', eventExposure: 'Exposure per event (rasio)', totalExposure: 'Exposure total (rasio)',
  dailyLoss: 'Batas rugi harian (rasio)', maxDrawdown: 'Batas drawdown (rasio)', minimumEdge: 'Edge minimum (rasio)',
  slippageBps: 'Slippage maksimum (bps)', maxRecoveryLoss: 'Biaya pemulihan maksimum (pUSD)', maxHoldingHours: 'Lama posisi maksimum (jam)',
  minimumLiquidity: 'Likuiditas minimum (pUSD)', minimumVolume: 'Volume minimum (pUSD)', mergeCost: 'Estimasi biaya merge (pUSD)',
  arbitrageAllocation: 'Alokasi arbitrase (rasio)', predictionAllocation: 'Alokasi prediksi (rasio)',
  maxMarkets: 'Jumlah pasar maksimum', scanIntervalSeconds: 'Interval pemindaian (detik)', paperLatencyMs: 'Latensi simulasi (ms)',
  paperFailureRate: 'Rasio kegagalan simulasi', researchDailyBudgetUsd: 'Budget riset harian (USD)', researchMonthlyBudgetUsd: 'Budget riset bulanan (USD)',
  infrastructureDailyCostUsd: 'Biaya infrastruktur harian (USD)', serviceCostConversion: 'Konversi biaya (pUSD per USD)',
  timeoutMs: 'Batas waktu (ms)', maxOutputTokens: 'Token output maksimum', concurrency: 'Panggilan bersamaan',
  retries: 'Cadangan biaya retry', callsPerMinute: 'Batas panggilan per menit', dailyBudgetUsd: 'Budget harian (USD)',
  monthlyBudgetUsd: 'Budget bulanan (USD)', inputPricePerMillion: 'Harga input per 1 juta token (USD)', outputPricePerMillion: 'Harga output per 1 juta token (USD)',
  arbitrage: 'Strategi arbitrase', prediction: 'Strategi prediksi',
};
export const settingLabel = (key: string) => settingLabels[key] ?? key;

export const providerLabels: Record<ProviderConfig['protocol'], string> = {
  'openai-responses': 'OpenAI resmi · Responses', 'openai-chat': 'OpenAI resmi · Chat Completions',
  anthropic: 'Anthropic resmi · Messages', google: 'Google resmi · Gemini',
  'custom-chat': 'Custom · OpenAI Chat Completions', 'custom-responses': 'Custom · Responses', 'custom-anthropic': 'Custom · Anthropic Messages',
};
export const providerEndpointHint = (protocol: ProviderConfig['protocol']) => protocol === 'custom-responses'
  ? 'Isi URL lengkap endpoint Responses, misalnya https://gateway.example/v1/responses.'
  : protocol.startsWith('custom-') ? 'Isi base URL API, misalnya https://gateway.example/v1. Protokol harus didukung oleh server tersebut.'
  : 'Boleh dikosongkan. Koneksi resmi memakai endpoint langsung milik penyedia.';
