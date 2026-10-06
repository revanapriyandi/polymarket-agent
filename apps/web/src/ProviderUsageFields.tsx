import type { ProviderConfig } from '../../../packages/shared/src/index';
import { settingLabel } from './settings-labels';

const executionFields = ['timeoutMs', 'maxOutputTokens', 'concurrency', 'retries', 'callsPerMinute', 'callsPerDay', 'callsPerMonth', 'minimumCallIntervalMs'] as const;
const priceFields = ['dailyBudgetUsd', 'monthlyBudgetUsd', 'inputPricePerMillion', 'outputPricePerMillion'] as const;

export function ProviderUsageFields({ config, onChange }: { config: ProviderConfig; onChange: (config: ProviderConfig) => void }) {
  return <>
    <label>Mode respons<select value={config.responseMode ?? 'json'} onChange={event => onChange({ ...config, responseMode: event.target.value as ProviderConfig['responseMode'] })}>
      <option value="json">JSON · respons lengkap</option>
      <option value="sse">Streaming · Server-Sent Events</option>
    </select><small>Pilih streaming jika gateway mengirim balasan bertahap. Output akhir tetap divalidasi.</small></label>
    <label>Perhitungan biaya<select value={config.billingMode ?? 'metered'} onChange={event => onChange({ ...config, billingMode: event.target.value as ProviderConfig['billingMode'] })}>
      <option value="metered">Tarif per token · anggaran USD</option>
      <option value="internal-quota">Gateway internal · kuota panggilan</option>
    </select></label>
    {executionFields.map(key => <label key={key}>{settingLabel(key)}<input type="number" min={key === 'retries' || key === 'minimumCallIntervalMs' ? 0 : 1} step="1" value={config[key]} onChange={event => onChange({ ...config, [key]: Number(event.target.value) })}/></label>)}
    {config.billingMode === 'internal-quota'
      ? <p className="muted wide">Pemakaian token tetap dicatat. Tagihan upstream belum dilaporkan dan belum termasuk laba bersih. Kuota harian/bulanan, timeout, dan concurrency tetap berlaku.</p>
      : priceFields.map(key => <label key={key}>{settingLabel(key)}<input type="number" min="0" step="any" value={config[key] ?? ''} onChange={event => onChange({ ...config, [key]: event.target.value })}/></label>)}
  </>;
}
