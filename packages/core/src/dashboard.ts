import { pool } from '../../db/src/index.js';
import { metrics } from './ledger.js';
import { readControl, readSettings, readState } from './state.js';
import { evaluate } from './evaluation.js';
import { providerViews } from './ai-service.js';
import { readServiceView, loadTrends } from '../../services/src/index.js';
import type { DashboardSnapshot, AgentView, Readiness, Mode, Activity } from '../../shared/src/index.js';
import type { ExchangeRequestState } from '../../trading/src/request-control.js';
export async function dashboard(): Promise<DashboardSnapshot> {
  const [control, configured, heartbeat, feed, reconciled, wallet] = await Promise.all([readControl(), readSettings(), readState<{ at: string; pid: number }>('worker-heartbeat'), readState<{ connected: boolean; at: string }>('market-feed'), readState<{ ok: boolean; at: string }>('live-reconciliation'), readState<{ ready: boolean; reason: string; checkedAt: string }>('wallet')]);
  const mode = control.mode as Mode, online = !!heartbeat && Date.now() - Date.parse(heartbeat.at) < 20000;
  const [totals, series, agentRows, logs, evaluations, counts, providers] = await Promise.all([
    metrics(mode, configured.settings), pool.query('SELECT extract(epoch from at)::bigint::float8 time,value::float8 equity,pnl::float8 pnl,drawdown::float8 drawdown FROM (SELECT * FROM equity WHERE mode=$1 ORDER BY at DESC LIMIT 5000) e ORDER BY at', [mode]),
    pool.query<{ payload: AgentView }>('SELECT payload FROM agents'), pool.query("SELECT id,at,role,level,title,detail FROM audit ORDER BY at DESC LIMIT 35"), evaluate(configured.settings),
    pool.query("SELECT (SELECT count(*) FROM positions WHERE mode=$1 AND shares>0)::int positions,(SELECT count(*) FROM orders WHERE mode=$1 AND status IN ('open','partial','approved','submitting','ambiguous','settling'))::int orders,(SELECT count(*) FROM opportunities WHERE expires_at>now())::int opportunities,(SELECT count(*) FROM markets)::int markets", [mode]),
    providerViews()
  ]);
  type QueueHealth = { ok: boolean; at: string; pid: number };
  const [services, trends, operations, discovery, research, exchange] = await Promise.all([readServiceView(), loadTrends(), readState<QueueHealth>('queue-health:polymarket-operations'), readState<QueueHealth>('queue-health:polymarket-discovery'), readState<QueueHealth>('queue-health:polymarket-research'), readState<ExchangeRequestState>('exchange-request-control')]);
  const queueFresh = (health: QueueHealth | null, age: number) => !!health && health.ok && health.pid === heartbeat?.pid && Date.parse(health.at) <= Date.now() && Date.now() - Date.parse(health.at) < age;
  const queuesReady = online && queueFresh(operations, 30000) && queueFresh(discovery, 180000) && !!research?.ok && research.pid === heartbeat?.pid;
  const readyProvider = providers.find(provider => provider.status === 'ready' && provider.capabilities?.tools);
  const enabledStrategies = (['prediction', 'arbitrage'] as const).filter(strategy => configured.settings.strategyEnabled[strategy]);
  const evaluationReady = enabledStrategies.length > 0 && enabledStrategies.every(strategy => evaluations.some(evaluation => evaluation.strategy === strategy && evaluation.eligible));
  const freshNews = services.config.news.enabled && trends.items.some(item => item.freshness === 'fresh' && services.config.news.feeds.some(feed => feed.enabled && feed.id === item.sourceId));
  const feedReady = online && !!feed?.connected && Date.now() - Date.parse(feed.at) < 30000;
  const exchangeUntil = Math.max(exchange?.rateLimitUntil ?? 0, exchange?.ordersBlockedUntil ?? 0, exchange?.postOnlyUntil ?? 0);
  const walletReady = !!wallet?.ready && Date.now() - Date.parse(wallet.checkedAt) < 120000;
  const readiness: Readiness[] = [
    { key: 'database', name: 'Database & ledger', state: totals.equity === null ? 'degraded' : 'ready', reason: totals.equity === null ? 'PostgreSQL terhubung; valuasi atau fill belum final sehingga equity dan entry baru diblokir' : 'PostgreSQL terhubung; valuasi tersedia, ledger paper dan live terpisah', checkedAt: new Date().toISOString() },
    { key: 'worker', name: 'Worker 24/7', state: online ? 'ready' : 'degraded', reason: online ? 'Heartbeat worker aktif' : 'Heartbeat worker belum tersedia atau kadaluwarsa', checkedAt: heartbeat?.at ?? null },
    { key: 'queues', name: 'Antrean pekerjaan', state: queuesReady ? 'ready' : 'degraded', reason: queuesReady ? 'Operations dan discovery baru berhasil pada worker aktif; research siap atau idle' : 'Antrean belum teruji, gagal, atau hasil milik worker lama; heartbeat saja belum membuktikan pemrosesan', checkedAt: operations?.at ?? null },
    { key: 'market', name: 'Data pasar', state: feedReady ? 'ready' : 'degraded', reason: feedReady ? 'WebSocket pasar aktif; order divalidasi ulang lewat REST' : 'WebSocket belum tersambung atau stale; entry memerlukan snapshot REST segar', checkedAt: feed?.at ?? null },
    { key: 'exchange', name: 'Jeda exchange', state: exchangeUntil > Date.now() ? 'degraded' : 'ready', reason: exchangeUntil > Date.now() ? `${exchange?.reason}; cooldown sampai ${new Date(exchangeUntil).toISOString()}, tanpa retry order otomatis` : 'Tidak ada cooldown exchange aktif; izin pasar tetap diperiksa tiap order', checkedAt: exchange?.observedAt ?? null },
    { key: 'ai', name: 'Koneksi AI', state: readyProvider ? 'ready' : providers.length ? 'blocked' : 'unconfigured', reason: readyProvider ? 'Provider aktif lulus text, tools, structured, dan usage; tes belum kedaluwarsa. Assignment dan budget diperiksa tiap panggilan' : 'Tambahkan provider aktif dan luluskan tes kemampuan terbaru di Settings', checkedAt: readyProvider?.capabilities?.testedAt ?? null },
    ...(providers.some(provider => provider.enabled && provider.billingMode === 'internal-quota') ? [{ key: 'ai-cost', name: 'Biaya gateway internal', state: 'degraded' as const, reason: 'Pemakaian token dan kuota tercatat. Tagihan upstream tidak dilaporkan; biaya tersebut belum termasuk laba bersih.', checkedAt: null }] : []),
    { key: 'research', name: 'Pencarian & sumber', state: services.searchStatus === 'ready' ? 'ready' : freshNews ? 'degraded' : services.searchStatus === 'blocked' ? 'blocked' : 'unconfigured', reason: services.searchStatus === 'ready' ? 'Tavily teruji pada versi konfigurasi saat ini; budget tetap diperiksa per panggilan' : freshNews ? 'Feed berita segar tersedia; Tavily belum siap dan cuplikan tetap perlu verifikasi' : 'Aktifkan Tavily, simpan key, isi budget, lalu jalankan probe; key tersimpan saja belum membuktikan koneksi', checkedAt: services.probe?.checkedAt ?? trends.checkedAt },
    { key: 'wallet', name: 'Wallet live', state: walletReady ? 'ready' : wallet?.ready ? 'degraded' : 'unconfigured', reason: wallet?.ready && !walletReady ? 'Pemeriksaan wallet kedaluwarsa; tunggu worker memverifikasi ulang' : wallet?.reason ?? 'Wallet, signer, pUSD, allowance, relayer, dan akses belum diverifikasi', checkedAt: wallet?.checkedAt ?? null },
    { key: 'risk', name: 'Batas risiko live', state: configured.settings.live && configured.settings.liveRiskAcknowledged ? 'ready' : 'unconfigured', reason: configured.settings.live && configured.settings.liveRiskAcknowledged ? 'Batas eksplisit tersimpan' : 'Isi modal dan konfirmasi batas risiko live', checkedAt: null },
    { key: 'evaluation', name: 'Gerbang live', state: evaluationReady ? 'ready' : 'blocked', reason: 'Setiap strategi aktif memerlukan minimal satu profil saat ini yang eligible; permit tetap memeriksa profil persis dari usulan. 30 hari, 100 transaksi selesai, net positif; prediksi 50 event selesai', checkedAt: new Date().toISOString() },
  ];
  return { at: new Date().toISOString(), mode, control: control.state as DashboardSnapshot['control'], policyVersion: configured.version, metrics: totals, equity: series.rows, agents: agentRows.rows.map(r => ({ ...r.payload, status: online ? r.payload.status : 'degraded', reason: online ? r.payload.reason : 'Worker tidak aktif; status tugas terakhir tersimpan' })), readiness, activities: logs.rows.map(r => ({ ...r, at: r.at.toISOString() })) as Activity[], evaluations, counts: counts.rows[0], worker: { online, heartbeatAt: heartbeat?.at ?? null, feedConnected: feedReady, reconciliationAt: reconciled?.at ?? null } };
}
