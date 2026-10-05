import { useQuery } from '@tanstack/react-query';
import { api, date } from '../api';

interface Run { id:string;tool:string;skill_version:string;duration_ms:number;created_at:string;result:{ok:boolean;source:string;observedAt:string;freshUntil:string;data?:unknown;error?:{message:string}} }
export function AgentRuns({role}:{role:string}) {
  const query=useQuery({queryKey:['agent-runs',role],queryFn:()=>api<Run[]>(`/agents/${role}/runs`),refetchInterval:5000});
  return <section><h3>30 pekerjaan terakhir</h3>{query.error&&<p className="error">{query.error.message}</p>}{query.isPending&&<p role="status">Memuat pekerjaan…</p>}{query.data?.map(run=><details className="research-stage" key={run.id}><summary><span>{run.tool} · v{run.skill_version}</span><span className={`badge ${run.result.ok?'ready':'blocked'}`}>{run.result.ok?'Selesai':'Gagal'}</span><small>{run.duration_ms} ms · {date(run.created_at)}</small></summary><p className="muted">Sumber {run.result.source} · berlaku hingga {date(run.result.freshUntil)}</p>{run.result.error&&<p className="error">{run.result.error.message}</p>}<pre>{JSON.stringify(run.result.data??{},null,2)}</pre></details>)}{query.data?.length===0&&<p className="empty">Belum ada hasil runtime agent ini.</p>}</section>;
}
export function QueueHealth() {
  const query=useQuery({queryKey:['queues'],queryFn:()=>api<{name:string;active:number;waiting:number;delayed:number;failed:number}[]>('/queues'),refetchInterval:5000});
  return <section className="panel"><h2>Antrean worker</h2>{query.error&&<p className="error">{query.error.message}</p>}<div className="table-scroll"><table><thead><tr><th>Pekerjaan</th><th>Aktif</th><th>Menunggu</th><th>Dijadwalkan</th><th>Gagal tersimpan</th></tr></thead><tbody>{query.data?.map(queue=><tr key={queue.name}><td>{queue.name.replace('polymarket-','')}</td><td>{queue.active}</td><td>{queue.waiting}</td><td>{queue.delayed}</td><td>{queue.failed}</td></tr>)}</tbody></table></div><small>Signals memeriksa kandidat streaming. Operations mengelola posisi dan order. Discovery menemukan pasar; research mengerjakan bukti dan model. Sinyal yang terlambat dilewati dan tidak dikirim ulang.</small></section>;
}
