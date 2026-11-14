'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, Loader2, RefreshCw } from 'lucide-react';
import { useAccess } from '@/hooks/use-access';
import { accessStore } from '@/lib/client/access-store';
import type { PublicOrder } from '@/lib/market/types';
import { MarketShell } from './market-shell';

export function PaymentReturn() {
  const { access } = useAccess(); const [order, setOrder] = useState<PublicOrder | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function check() {
    const query = new URLSearchParams(window.location.search); const id = query.get('order_id') || query.get('order');
    if (!id) { setError('No order reference was included. Your account can show your recent purchases.'); return; }
    setBusy(true); setError('');
    try { const result = await accessStore.request<{ order: PublicOrder }>(`/orders/${encodeURIComponent(id)}`); setOrder(result.order); await accessStore.refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : 'We could not check this order yet.'); } finally { setBusy(false); }
  }
  useEffect(() => { void accessStore.initialize().then(check); }, []);
  return <MarketShell title="Let’s check your payment." subtitle="Only a verified provider confirmation activates a plan. Returning from checkout is not proof of payment."><section className="panel market-payment-result"><span className="market-large-icon">{busy ? <Loader2 size={32} className="spinning" /> : order?.status === 'paid' ? <CheckCircle2 size={32} /> : <Clock3 size={32} />}</span><h2>{busy ? 'Checking confirmation…' : order?.status === 'paid' ? 'Payment confirmed' : order?.status === 'failed' ? 'Payment was not completed' : order?.status === 'refunded' ? 'This payment was refunded' : 'Waiting for confirmation'}</h2><p className="market-lead">{order?.status === 'paid' ? 'Your purchase is recorded. Register this installation from your account to use your paid plan here.' : order?.status === 'failed' ? 'No new access was granted for this payment. You can try another checkout.' : 'Confirmation can arrive after checkout closes. Check again or return to your account; do not pay twice while an order is pending.'}</p>{order && <p className="market-fine">Order {order.id} · ₹{order.amountPaise / 100}</p>}{error && <p className="market-error" role="alert">{error}</p>}<div className="market-inline-actions"><Link prefetch={false} className="button primary" href={access?.account ? '/account' : '/login'}>{access?.account ? 'Go to my account' : 'Sign in to restore'}</Link><button className="button secondary" disabled={busy} onClick={() => void check()}><RefreshCw size={15} />Check again</button></div></section></MarketShell>;
}
