'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, CreditCard, Loader2, Monitor, ShieldCheck, Smartphone, Zap } from 'lucide-react';
import { useAccess } from '@/hooks/use-access';
import { accessStore } from '@/lib/client/access-store';
import { PLANS } from '@/lib/market/plans';
import type { PlanId, PublicOrder } from '@/lib/market/types';
import { MarketShell } from './market-shell';

interface CashfreeCheckout { checkout(options: { paymentSessionId: string; redirectTarget: string }): Promise<{ error?: { message?: string } } | void>; }
declare global { interface Window { Cashfree?: (options: { mode: 'sandbox' | 'production' }) => CashfreeCheckout } }
async function loadCashfree(): Promise<void> {
  if (window.Cashfree) return;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-f8-cashfree]');
    const script = existing || document.createElement('script');
    const timer = window.setTimeout(() => { script.remove(); reject(new Error('Checkout took too long to load. Try again from your account.')); }, 15000);
    script.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
    script.addEventListener('error', () => { clearTimeout(timer); script.remove(); reject(new Error('Secure checkout could not load. Please try again.')); }, { once: true });
    script.src = 'https://sdk.cashfree.com/js/v3/cashfree.js'; script.async = true; script.dataset.f8Cashfree = 'true';
    if (!existing) document.head.appendChild(script);
  });
}
export function PlansScreen() {
  const { access, config, loading } = useAccess(); const router = useRouter();
  const [busy, setBusy] = useState<PlanId | 'demo' | 'check' | null>(null); const [error, setError] = useState(''); const [phone, setPhone] = useState(''); const [order, setOrder] = useState<PublicOrder | null>(null); const [success, setSuccess] = useState<'demo' | 'live' | null>(null);
  const plans = config?.plans || PLANS; const realCheckout = config?.paymentMode === 'sandbox' || config?.paymentMode === 'live';
  async function buy(planId: PlanId) {
    if (!access?.account) { router.push('/login'); return; }
    setBusy(planId); setError(''); setSuccess(null);
    try {
      const result = await accessStore.request<{ order: PublicOrder }>('/orders', { planId, customerPhone: phone || undefined, assertion: await accessStore.assertion() }); setOrder(result.order);
      if (result.order.status === 'paid') {
        await accessStore.refresh(); setOrder(null); setSuccess(result.order.provider === 'demo' ? 'demo' : 'live'); return;
      }
      if (result.order.status !== 'pending') throw new Error('This order cannot open checkout. Check its status in your account before trying again.');
      if (result.order.provider === 'cashfree') {
        if (!result.order.checkoutSessionId) throw new Error('The payment provider did not return a checkout session. Check the order from your account.');
        await loadCashfree();
        if (!window.Cashfree) throw new Error('The secure checkout could not initialize. Check this order from your account before trying again.');
        const checkout = await window.Cashfree!({ mode: config?.paymentMode === 'live' ? 'production' : 'sandbox' }).checkout({ paymentSessionId: result.order.checkoutSessionId, redirectTarget: '_self' });
        if (checkout?.error) throw new Error(checkout.error.message || 'Checkout did not complete. Your order is available in your account.');
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not create checkout.'); } finally { setBusy(null); }
  }
  async function finishDemo(outcome: 'paid' | 'failed') {
    if (!order) return; setBusy('demo'); setError('');
    try {
      await accessStore.request(`/orders/${encodeURIComponent(order.id)}/demo`, { outcome, assertion: await accessStore.assertion() });
      await accessStore.refresh(); setOrder(null); setSuccess(outcome === 'paid' ? 'demo' : null);
      if (outcome === 'failed') setError('Test payment failed. No entitlement was granted and no money was charged.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not complete the test payment.'); } finally { setBusy(null); }
  }
  async function checkPending() {
    if (!order) return; setBusy('check'); setError('');
    try {
      const result = await accessStore.request<{ order: PublicOrder }>(`/orders/${encodeURIComponent(order.id)}`);
      if (result.order.status === 'paid') { await accessStore.refresh(); setOrder(null); setSuccess(result.order.provider === 'demo' ? 'demo' : 'live'); }
      else { setOrder(result.order); if (result.order.status === 'failed') setError('This payment was not completed. No new access was granted.'); }
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not check the existing payment.'); } finally { setBusy(null); }
  }
  return <MarketShell title="Less waiting. More sharing." subtitle="Simple prepaid plans. Ad-free access and Maximum speed for one desktop and one mobile installation."><div className="market-plan-notice"><ShieldCheck size={17} /><p>{config?.paymentMode === 'demo' ? 'LOCAL SANDBOX: payments are simulated. No money is charged.' : config?.paymentMode === 'sandbox' ? 'PAYMENT SANDBOX: use provider test credentials only. No live benefits are sold.' : config?.paymentMode === 'disabled' ? 'Live checkout is not configured yet. Prices below show the planned prepaid offers.' : 'One-time payments. No automatic renewals. Gateway fees are included.'}</p></div>{realCheckout && <label className="market-phone" htmlFor="payment-phone">Indian mobile number for the payment provider<input id="payment-phone" type="tel" inputMode="numeric" autoComplete="tel-national" pattern="[6-9][0-9]{9}" maxLength={10} placeholder="10-digit mobile number" value={phone} onChange={event => setPhone(event.target.value.replace(/\D/g, '').slice(0, 10))} /><small>Sent to the payment provider for checkout. Never shown to other participants.</small></label>}<div className="market-plans">{plans.map(plan => <article className={`market-plan panel${plan.id === 'year' ? ' recommended' : ''}`} key={plan.id}>{plan.id === 'year' && <span className="market-plan-tag">BEST VALUE</span>}<span className="market-plan-icon"><Zap size={23} /></span><h2>{plan.name}</h2><div className="market-plan-price">₹{plan.amountPaise / 100}<span> / {plan.months === 1 ? 'month' : plan.months === 12 ? 'year' : '6 months'}</span></div><p className="market-plan-summary">One payment. {plan.months} calendar {plan.months === 1 ? 'month' : 'months'} of access.</p><ul><li><Check size={15} />No ads during your plan</li><li><Check size={15} />Maximum speed on your connections</li><li><Monitor size={15} />One desktop installation</li><li><Smartphone size={15} />One mobile installation</li></ul><button className={`button full ${plan.id === 'year' ? 'primary' : 'secondary'}`} disabled={loading || !!busy || (access?.account ? config?.paymentMode === 'disabled' || !config || realCheckout && !/^[6-9]\d{9}$/.test(phone) : false)} onClick={() => void buy(plan.id)}>{busy === plan.id ? <Loader2 className="spinning" size={16} /> : <CreditCard size={16} />}{access?.account ? config?.paymentMode === 'demo' ? 'Try sandbox checkout' : config?.paymentMode === 'disabled' ? 'Checkout coming soon' : 'Choose plan' : 'Sign in to choose'}</button></article>)}</div>{order?.provider === 'demo' && <section className="panel market-demo-checkout" aria-label="Local sandbox checkout"><span className="market-badge">SIMULATED PAYMENT · NO MONEY CHARGED</span><h2>Test your checkout</h2><p>Order {order.id} · ₹{order.amountPaise / 100}. Choose an outcome to test entitlement handling.</p><div className="market-inline-actions"><button className="button primary" disabled={!!busy} onClick={() => void finishDemo('paid')}>Simulate successful payment</button><button className="button secondary" disabled={!!busy} onClick={() => void finishDemo('failed')}>Simulate failure</button></div></section>}{order?.provider === 'cashfree' && order.status === 'pending' && <section className="panel market-demo-checkout" aria-label="Pending payment"><h2>Check your existing payment</h2><p>Order {order.id} is awaiting confirmation. Use this order to recover checkout; do not pay again while it is pending.</p><div className="market-inline-actions"><button className="button secondary" disabled={!!busy} onClick={() => void checkPending()}>{busy === 'check' ? 'Checking…' : 'Check payment'}</button><Link prefetch={false} className="button secondary" href="/account">View purchase history</Link></div></section>}{success && <div className="market-success" role="status"><Check size={20} /><div><strong>{success === 'demo' ? 'Test purchase confirmed' : 'Payment confirmed'}</strong><p>Register this installation in <Link prefetch={false} href="/account">your account</Link> to use paid access here.</p></div></div>}{error && <p className="market-error" role="alert">{error}</p>}<section className="market-plan-details"><div><h3>What is Maximum speed?</h3><p>Standard sharing uses 65% of an observed uncapped transfer reference. Premium removes that application tier limit and aims for the maximum useful throughput. Device, Wi-Fi, storage, receiver capacity and any bandwidth limit you choose still apply. Either Premium endpoint unlocks Maximum speed for that pair.</p></div><div><h3>Your plan, your devices.</h3><p>Early renewal extends the current expiry. Device registration is per browser/PWA installation; you can replace one device in each category every 24 hours.</p></div><div><h3>Finish what you started.</h3><p>Accepted transfers and saving continue after access expires. New transfers require renewed access. Standard senders can complete an eligible ad per selected batch. Receiving and chat need no ad.</p></div></section><p className="market-fine">By purchasing, you accept the <Link prefetch={false} href="/terms">terms and duplicate-charge refund policy</Link>. Mandatory consumer rights still apply.</p></MarketShell>;
}
