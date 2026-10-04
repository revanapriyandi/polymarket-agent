export class ApiError extends Error {
    constructor(message: string, public status: number) { super(message); }
}
export async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', token?: string): Promise<T> {
    const response = await fetch(`/api${path}`, { method, credentials: 'include', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'x-step-up-token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => ({ error: 'Respons server tidak valid' }));
    if (!response.ok)
        throw new ApiError(data.error ?? data.message ?? 'Permintaan gagal', response.status);
    return data as T;
}
export const money = (v: string | number | null | undefined) => v == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(v));
export const date = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? new Date(v).toLocaleString('id-ID') : '—';
export const label = (s: string) => s.replace(/([A-Z])/g, ' $1').replaceAll('_', ' ');

export const percent=(value:string|number|null|undefined)=>value==null?"—":new Intl.NumberFormat("id-ID",{style:"percent",maximumFractionDigits:2}).format(Number(value));

export const collateral=(value:string|number|null|undefined)=>value==null?"—":`pUSD ${new Intl.NumberFormat("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value))}`;
