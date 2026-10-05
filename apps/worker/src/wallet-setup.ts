import { createSecureClient, forkEnvironmentConfig, production } from '@polymarket/client';
import { builderApiKey } from '@polymarket/client/node';
import { privateKey } from '@polymarket/client/viem';
import { http } from 'viem';
import { polygon } from 'viem/chains';
import { pool, transaction } from '../../../packages/db/src/index.js';
import { loadManagedWallet, walletRpc } from '../../../packages/core/src/wallet.js';
import { encryptSecret } from '../../../packages/ai/src/security.js';
import { audit } from '../../../packages/core/src/state.js';
import { refreshManagedRuntime, type Runtime } from './context.js';
import { walletCheck } from './portfolio.js';

export async function connectManagedWallet(version:number,runtime:Runtime) {
  const row=await loadManagedWallet();if(!row||row.version!==version||!['configured','queued'].includes(row.status))return;
  try { if((await runtime.public.getGeoblock()).blocked){await pool.query("UPDATE managed_wallet SET status='configured',message='Akses Polymarket diblokir dari lokasi server',updated_at=now() WHERE id=1 AND version=$1",[version]);return;} }
  catch {await pool.query("UPDATE managed_wallet SET status='configured',message='Pemeriksaan akses gagal sebelum setup; coba lagi setelah koneksi pulih',updated_at=now() WHERE id=1 AND version=$1",[version]);return;}
  const claim=await pool.query("UPDATE managed_wallet SET status='connecting',message='SDK menyiapkan akun dan kredensial',updated_at=now() WHERE id=1 AND version=$1 AND status IN('configured','queued') RETURNING id",[version]);
  if(!claim.rowCount)return;
  try {
    const secure=await createSecureClient({environment:forkEnvironmentConfig({name:'managed-wallet',rpc:walletRpc()},production),signer:privateKey(row.protected.privateKey,{chain:polygon,transport:http(walletRpc())}),apiKey:builderApiKey(row.protected.builder),...(row.wallet_address?{wallet:row.wallet_address}:{}),...(row.protected.credentials?{credentials:row.protected.credentials}:{})});
    row.protected.credentials=secure.credentials;
    // Persist account identity before allowance transactions so an interrupted setup can be inspected.
    await pool.query('UPDATE managed_wallet SET wallet_address=$1,secrets=$2,message=$3,updated_at=now() WHERE id=1 AND version=$4',[secure.account.wallet,encryptSecret(JSON.stringify(row.protected)),'Akun terkonfirmasi; menyiapkan allowance',version]);
    await secure.setupTradingApprovals();
    await transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(73011)');
      await client.query("UPDATE managed_wallet SET status='connected',message='Wallet terhubung; menunggu dana dan persyaratan live',updated_at=now() WHERE id=1 AND version=$1",[version]);
      await client.query("UPDATE settings SET payload=jsonb_set(payload,'{walletAddress}',to_jsonb($1::text)),version=version+1,updated_at=now() WHERE id=1",[secure.account.wallet]);
    });
    await refreshManagedRuntime(runtime);await walletCheck(runtime);
    await audit('supervisor','Wallet server terhubung','Akun dan allowance selesai; aktivasi live tidak berubah');
  } catch {
    await pool.query("UPDATE managed_wallet SET status='ambiguous',message='Setup belum terkonfirmasi. Periksa akun dan transaksi relayer sebelum mencoba lagi; signer dipertahankan.',updated_at=now() WHERE id=1 AND version=$1",[version]);
    await audit('supervisor','Setup wallet perlu diperiksa','Tidak ada pengulangan otomatis pada operasi wallet yang hasilnya belum pasti','warning');
  }
}
