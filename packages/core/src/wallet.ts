import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import type { ApiKeyCreds } from '@polymarket/client';
import type { BuilderApiKeyCreds } from '@polymarket/client/node';
import { z } from 'zod';
import { pool, transaction } from '../../db/src/index.js';
import { encryptSecret, decryptSecret } from '../../ai/src/security.js';
import { env } from './config.js';
import { readSettings, readState } from './state.js';

export const BuilderCredentialsSchema = z.object({ key: z.string().uuid(), secret: z.string().min(16).max(4096), passphrase: z.string().min(1).max(512) }).strict();
export interface WalletSecrets { privateKey: `0x${string}`; builder: BuilderApiKeyCreds; credentials?: ApiKeyCreds }
export const walletRpc = () => env.POLYGON_RPC_URL || polygon.rpcUrls.default.http[0];
export async function loadManagedWallet() {
  const row=(await pool.query('SELECT * FROM managed_wallet WHERE id=1')).rows[0];
  return row ? {...row,protected:JSON.parse(decryptSecret(row.secrets)) as WalletSecrets} : null;
}
export async function configureManagedWallet(builder: BuilderApiKeyCreds) {
  if(env.POLYMARKET_PRIVATE_KEY)throw new Error('WALLET_ENV_MANAGED');
  return transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(73060)');
    const control=(await client.query('SELECT mode FROM controls WHERE id=1 FOR UPDATE')).rows[0];
    const exposure=(await client.query("SELECT id::text FROM positions WHERE mode='live' AND shares>0 UNION ALL SELECT id FROM orders WHERE mode='live' AND status NOT IN('filled','cancelled','rejected','expired') LIMIT 1")).rowCount;
    if(control?.mode==='live'||exposure)throw new Error('WALLET_LIVE_ACTIVE');
    const previous=(await client.query('SELECT * FROM managed_wallet WHERE id=1 FOR UPDATE')).rows[0];
    if(previous&&['queued','connecting','ambiguous'].includes(previous.status))throw new Error('WALLET_SETUP_PENDING');
    const secrets:WalletSecrets=previous?JSON.parse(decryptSecret(previous.secrets)):{privateKey:generatePrivateKey(),builder};
    secrets.builder=builder;
    const signer=privateKeyToAccount(secrets.privateKey).address;
    await client.query("INSERT INTO managed_wallet(id,signer_address,secrets) VALUES(1,$1,$2) ON CONFLICT(id) DO UPDATE SET secrets=excluded.secrets,version=managed_wallet.version+1,status='configured',message='',updated_at=now()",[signer,encryptSecret(JSON.stringify(secrets))]);
    await client.query("INSERT INTO system_state(key,value) VALUES('wallet',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()",[JSON.stringify({ready:false,reason:'Koneksi wallet berubah; pemeriksaan baru diperlukan',checkedAt:new Date().toISOString()})]);
    return {ok:true};
  });
}
export async function walletView() {
  const [managed,{settings},status]=await Promise.all([pool.query('SELECT signer_address,wallet_address,status,message,updated_at FROM managed_wallet WHERE id=1'),readSettings(),readState<{ready:boolean;reason:string;balance?:string;checkedAt:string;approvals?:{isFullyApproved:boolean};geoblock?:{blocked:boolean}}>('wallet')]);
  const row=managed.rows[0], legacy=!!env.POLYMARKET_PRIVATE_KEY;
  return {managed:!!row,legacy,signerAddress:row?.signer_address??null,walletAddress:row?.wallet_address??settings.walletAddress,status:row?.status??'unconfigured',message:row?.message??'',updatedAt:row?.updated_at??null,readiness:status,steps:[
    {label:'Signer trading di server',ready:!!row||legacy,detail:row?'Dibuat dan disimpan terenkripsi di server':legacy?'Menggunakan konfigurasi server':'Dibuat otomatis setelah koneksi Polymarket disimpan'},
    {label:'Autentikasi Polymarket',ready:row?.status==='connected'||legacy&&!!env.POLYMARKET_CLOB_API_KEY,detail:row?.status==='connected'?'Kredensial CLOB diturunkan oleh SDK':'Isi koneksi awal lalu pilih Hubungkan wallet'},
    {label:'Allowance & akses trading',ready:!!status?.approvals?.isFullyApproved&&!status?.geoblock?.blocked,detail:status?.geoblock?.blocked?'Akses trading diblokir dari lokasi server':'Diperiksa melalui SDK dan Polygon'},
    {label:'Dana & profil risiko',ready:!!settings.live&&!!status?.balance&&Number(status.balance)>=Number(settings.live.capital),detail:status?.balance?`Saldo ${status.balance} pUSD; deposit tidak dihitung sebagai laba`:'Isi saldo wallet setelah alamat akun terkonfirmasi'},
    {label:'Kesiapan live',ready:!!status?.ready,detail:status?.reason??'Simulasi dapat berjalan tanpa wallet; aktivasi live tetap terpisah'}]};
}
