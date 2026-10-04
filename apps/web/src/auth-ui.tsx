import { useState } from 'react';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import { api } from './api';
import { Drawer } from './Drawer';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <main className="login"><div className="login-brand"><span className="brand">P<span>/</span>M</span><span className="eyebrow">POLYMARKET · TRADING</span></div>
    <form onSubmit={event => { event.preventDefault(); setBusy(true); setError(''); void api('/auth/sign-in/email', { email, password }).then(() => { setPassword(''); onSuccess(); }).catch(error => setError(error.message)).finally(() => setBusy(false)); }}>
      <span className="eyebrow">AKSES PEMILIK</span><h1>Portofolio Anda, dalam satu tempat.</h1><p className="muted">Masuk untuk memantau trading dan mengelola strategi.</p>
      <label>Email<input type="email" required autoComplete="username" value={email} onChange={event => setEmail(event.target.value)}/></label>
      <label>Password<input type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)}/></label>
      {error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? 'Memverifikasi…' : 'Masuk'}<ArrowUpRight size={16}/></button><small>Akun pertama dibuat melalui CLI. Registrasi publik dinonaktifkan.</small>
    </form><div className="login-note"><ShieldCheck size={16}/>Akses khusus pemilik melalui sesi yang aman.</div></main>;
}

export function Reauth({ onClose, onToken }: { onClose: () => void; onToken: (token: string) => void }) {
  const [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <Drawer title="Verifikasi perubahan sensitif" onClose={onClose} nested><form className="form" onSubmit={event => {
    event.preventDefault(); setBusy(true); setError('');
    void api<{ token: string }>('/security/reauth', { password }).then(result => { if (!result.token) throw new Error('Token verifikasi tidak tersedia'); setPassword(''); onToken(result.token); }).catch(error => setError(error.message)).finally(() => setBusy(false));
  }}><p className="muted">Masukkan password owner untuk melanjutkan aksi ini.</p><label>Password owner<input type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)}/></label>{error && <p className="error" role="alert">{error}</p>}<button disabled={busy} className="primary">{busy ? 'Memverifikasi…' : 'Verifikasi dan lanjutkan'}</button></form></Drawer>;
}
