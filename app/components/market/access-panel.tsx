'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Check, Crown, Monitor, Smartphone, X, Zap } from 'lucide-react';
import { useAccess } from '@/hooks/use-access';
import { accessStore } from '@/lib/client/access-store';
import type { AccessState } from '@/lib/market/types';
import { PLANS } from '@/lib/market/plans';
import './market.css';

export function useAccessClock(): number {
  const [now, setNow] = useState(() => accessStore.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(accessStore.now()), 1000); return () => clearInterval(timer); }, []);
  return now;
}
export function countdown(until: number | null | undefined, now: number): string {
  if (!until || until <= now) return 'Expired';
  const seconds = Math.ceil((until - now) / 1000); const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds % 3600 / 60);
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export async function marketAction(path: string, body: Record<string, unknown> = {}): Promise<AccessState> {
  const access = await accessStore.request<AccessState>(path, { ...body, assertion: await accessStore.assertion() });
  accessStore.setAccess(access); return access;
}
export function PremiumDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const { config } = useAccess();
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="modal market-dialog premium-dialog" data-testid="premium-dialog" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby="premium-title"><div className="modal-head"><h2 id="premium-title">Make every send effortless.</h2><button className="icon-button" aria-label="Close premium plans" onClick={onClose}><X size={20} /></button></div><div className="modal-body"><span className="market-badge"><Crown size={12} />PREMIUM SHARING</span><ul className="premium-benefits"><li><Check size={20} /><div><strong>Ad-free sharing</strong><p>Send without advertising interruptions during your plan.</p></div></li><li><Zap size={20} /><div><strong>Maximum speed</strong><p>Maximum application throughput for your connections, within your device, storage and network capacity.</p></div></li></ul><div className="premium-prices">{(config?.plans || PLANS).map(plan => <div key={plan.id}><strong>₹{plan.amountPaise / 100}</strong><span>{plan.name}</span></div>)}</div><p className="premium-devices"><Monitor size={15} />One desktop <span>+</span><Smartphone size={15} />one mobile installation</p><Link prefetch={false} href="/plans" target="_blank" rel="noopener noreferrer" data-testid="premium-plans" className="button primary full">See plans & go ad-free</Link><p className="market-fine">Opens in a new tab so your selected files and connection stay here. Your access updates after purchase. One-time payments; no automatic renewal.</p></div></dialog>;
}
export function MarketToolbar() {
  const { access, loading } = useAccess(); const [premium, setPremium] = useState(false);
  return <><nav className="market-toolbar" aria-label="Account and plans"><button className="market-upgrade" onClick={() => setPremium(true)}><Zap size={14} />Go ad-free</button><Link prefetch={false} className="market-account-link" target="_blank" rel="noopener noreferrer" href={access?.account ? '/account' : '/login'}>{access?.account ? 'My account' : loading ? 'Account…' : 'Sign in'}</Link></nav>{premium && <PremiumDialog onClose={() => setPremium(false)} />}</>;
}
/** Kept for old imports; access is now checked per send, without an hourly gate. */
export function AccessPanel() { return null; }
