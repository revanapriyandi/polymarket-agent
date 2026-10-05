import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Circle, Copy, Link2, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router';
import { api, date } from './api';
import type { SecureWrite } from './Settings';
import type { Settings } from '../../../packages/shared/src/index';

interface WalletView { managed:boolean;legacy:boolean;signerAddress:string|null;walletAddress:string|null;status:string;message:string;updatedAt:string|null;steps:{label:string;ready:boolean;detail:string}[];readiness:{ready:boolean;reason:string;checkedAt:string}|null }
export function WalletSetup({data,secure}:{data:{settings:Settings;version:number};secure:SecureWrite}) {
  const query=useQuery({queryKey:['wallet-setup'],queryFn:()=>api<WalletView>('/wallet/setup'),refetchInterval:5000}),client=useQueryClient();
  const [key,setKey]=useState(''),[secret,setSecret]=useState(''),[passphrase,setPassphrase]=useState(''),[showForm,setShowForm]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  async function action(kind:'save'|'connect'|'check'|'ack'){
    setBusy(true);setError('');setMessage('');
    try {
      if(kind==='save'){await secure('/wallet/setup',{key,secret,passphrase},'PUT');setKey('');setSecret('');setPassphrase('');setShowForm(false);setMessage('Koneksi disimpan. Pilih Hubungkan wallet untuk menyiapkan akun trading.');}
      else if(kind==='ack'){await secure('/settings',{settings:{...data.settings,liveRiskAcknowledged:!data.settings.liveRiskAcknowledged},expectedVersion:data.version},'PUT');setMessage('Preferensi live disimpan.');}
      else {await secure(kind==='connect'?'/wallet/connect':'/wallet/check',{});setMessage('Pekerjaan diantrikan; status diperbarui otomatis.');}
      await query.refetch();await client.invalidateQueries({queryKey:['settings']});
    }catch(error){setError((error as Error).message);}finally{setBusy(false);}
  }
  const wallet=query.data,pending=wallet&&['queued','connecting','ambiguous'].includes(wallet.status);
  return <div className="form"><div className="wallet-intro"><ShieldCheck size={30}/><div><h2>Wallet trading otomatis</h2><p>Agent menggunakan wallet khusus di server dan dapat bekerja saat browser ditutup. Simulasi dapat berjalan tanpa menghubungkan wallet.</p></div></div>
    {query.error&&<p className="error">{query.error.message}</p>}{error&&<p className="error" role="alert">{error}</p>}{message&&<p className="success" role="status">{message}</p>}
    {wallet?.walletAddress&&<div className="wallet-address"><small>Alamat akun trading · Polygon / pUSD</small><code>{wallet.walletAddress}</code><button className="text-button" onClick={()=>void navigator.clipboard.writeText(wallet.walletAddress!).then(()=>setMessage('Alamat wallet disalin.')).catch(()=>setError('Clipboard tidak tersedia; salin alamat yang ditampilkan.'))}><Copy size={13}/>Salin alamat</button></div>}
    <div className="actions">{wallet?.managed&&<button disabled={busy||!!pending} className="primary" onClick={()=>void action('connect')}><Link2 size={15}/>{wallet.status==='connected'?'Periksa koneksi':'Hubungkan wallet'}</button>}<button disabled={busy} onClick={()=>void action('check')}>Perbarui status</button>{!wallet?.legacy&&<button disabled={busy||!!pending} onClick={()=>setShowForm(value=>!value)}>{wallet?.managed?'Ubah koneksi':'Siapkan koneksi awal'}</button>}</div>
    {wallet?.message&&<p className={wallet.status==='ambiguous'?'error':'muted'}>{wallet.message}</p>}
    {showForm&&!wallet?.legacy&&<fieldset><legend>Koneksi Builder Polymarket · sekali pengisian</legend><p className="muted">Buka akun Polymarket → Settings → Builders, lalu buat Builder API key. Tiga nilai ini memberi SDK akses relayer untuk menyiapkan Deposit Wallet. Signer dibuat otomatis di server; private key tidak diminta di form.</p><a className="inline-link" href="https://docs.polymarket.com/trading/wallets-auth" target="_blank" rel="noreferrer">Panduan resmi Polymarket ↗</a><label>Builder API key<input type="password" autoComplete="off" value={key} onChange={event=>setKey(event.target.value)} placeholder="Key dari pengaturan Builders"/></label><label>Builder secret<input type="password" autoComplete="new-password" value={secret} onChange={event=>setSecret(event.target.value)}/></label><label>Builder passphrase<input type="password" autoComplete="new-password" value={passphrase} onChange={event=>setPassphrase(event.target.value)}/></label><button disabled={busy||!key||!secret||!passphrase} className="primary" onClick={()=>void action('save')}>Simpan koneksi</button><small>RPC Polygon memakai konfigurasi server atau endpoint bawaan library. Rahasia dienkripsi dengan kunci server yang terpisah.</small></fieldset>}
    <div className="wallet-steps">{wallet?.steps.map(step=><div key={step.label}><span className={step.ready?'good':'muted'}>{step.ready?<Check size={17}/>:<Circle size={17}/>}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div><span className={`badge ${step.ready?'ready':'unconfigured'}`}>{step.ready?'Siap':'Belum siap'}</span></div>)}</div>
    {wallet?.legacy&&<p className="muted">Wallet ini dikelola melalui konfigurasi VPS. Gunakan Perbarui status untuk memeriksa wallet yang sudah terpasang.</p>}
    <div className="wallet-next"><h3>Setelah terhubung</h3><p>Isi saldo ke alamat akun trading yang sudah terkonfirmasi, tetapkan modal dan risiko, lalu tunggu evaluasi strategi memenuhi syarat.</p><div className="actions"><Link className="button" to="/settings/risk">Modal & risiko</Link><Link className="button" to="/analytics/evaluation">Evaluasi strategi</Link></div><label className="check"><input type="checkbox" checked={data.settings.liveRiskAcknowledged} disabled={busy} onChange={()=>void action('ack')}/>Saya memahami risiko kehilangan modal pada perdagangan live.</label><small>Terhubung ke wallet tidak mengaktifkan trading live. Pemeriksaan terakhir {date(wallet?.readiness?.checkedAt)}.</small></div>
  </div>;
}
