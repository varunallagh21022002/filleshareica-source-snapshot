'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FlaskConical, Loader2, LockKeyhole } from 'lucide-react';
import { useAccess } from '@/hooks/use-access';
import { marketAction } from './access-panel';
import { MarketShell } from './market-shell';

interface GoogleIdentity { accounts: { id: { initialize(options: { client_id: string; callback: (result: { credential: string }) => void; auto_select: boolean; use_fedcm_for_prompt: boolean }): void; renderButton(container: HTMLElement, options: { type: string; theme: string; size: string; text: string; width: number }): void; } } }
declare global { interface Window { google?: GoogleIdentity } }

export function LoginScreen() {
  const { access, config, loading } = useAccess();
  const button = useRef<HTMLDivElement>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [email, setEmail] = useState(''); const [name, setName] = useState(''); const [reauthenticate, setReauthenticate] = useState(false);
  // Restore the browser-only query after hydration; the server render has no location.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setReauthenticate(new URLSearchParams(window.location.search).get('reauth') === '1'); }, []);
  useEffect(() => {
    if (!config?.googleClientId || access?.account && !reauthenticate) return;
    let disposed = false;
    const render = () => {
      if (disposed || !window.google || !button.current) return;
      window.google.accounts.id.initialize({ client_id: config.googleClientId!, auto_select: false, use_fedcm_for_prompt: true, callback: result => {
        setBusy(true); setError(''); void marketAction('/auth/google', { credential: result.credential }).then(() => setReauthenticate(false)).catch(error => setError(error instanceof Error ? error.message : 'Google sign-in failed.')).finally(() => setBusy(false));
      } });
      button.current.replaceChildren(); window.google.accounts.id.renderButton(button.current, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', width: 300 });
    };
    if (window.google) render();
    else {
      const existing = document.querySelector<HTMLScriptElement>('script[data-f8-google-signin]');
      const script = existing || document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.dataset.f8GoogleSignin = 'true';
      script.addEventListener('load', render, { once: true });
      script.addEventListener('error', () => { if (!disposed) setError('Google sign-in could not load. Check your connection and try again.'); }, { once: true });
      if (!existing) document.head.appendChild(script);
    }
    return () => { disposed = true; };
  }, [config?.googleClientId, access?.account, reauthenticate]);
  async function demo(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await marketAction('/auth/demo', { email, name }); setReauthenticate(false); } catch (error) { setError(error instanceof Error ? error.message : 'Test sign-in failed.'); } finally { setBusy(false); }
  }
  return <MarketShell title="A little less interruption." subtitle="Sign in to purchase ad-free sharing, restore your plan and manage your two registered installations."><section className="market-login-card panel">{access?.account && !reauthenticate ? <><span className="market-large-icon"><CheckCircle2 size={30} /></span><h2>You’re signed in.</h2><p className="market-lead">{access.account.name || access.account.email}</p><div className="market-inline-actions"><Link prefetch={false} className="button primary" href="/plans">Choose an ad-free plan</Link><Link prefetch={false} className="button secondary" href="/account">My account</Link></div></> : <><span className="market-large-icon"><LockKeyhole size={30} /></span><h2>Your files don’t need an account.</h2><p className="market-lead">Purchases do. Google confirms your identity; we remember your plan and registered installations.</p>{loading && !config ? <p className="market-loading"><Loader2 className="spinning" size={17} />Preparing sign-in…</p> : config?.googleClientId ? <div className="market-google-button" ref={button} /> : <div className="market-notice"><LockKeyhole size={20} /><div><strong>Google sign-in is not configured yet</strong><p>The owner must add the public Google client ID and approve this website’s origin. No live account is created by this preview.</p></div></div>}{busy && <p className="market-loading" role="status"><Loader2 className="spinning" size={16} />Checking your identity…</p>}{config?.development && <form className="market-demo-login" onSubmit={event => void demo(event)}><span className="market-badge"><FlaskConical size={12} />LOCAL TEST ACCOUNT</span><p>Available only in explicit development mode on localhost. This does not sign in to Google.</p><label htmlFor="demo-name">Name<input id="demo-name" value={name} onChange={event => setName(event.target.value)} maxLength={80} required autoComplete="name" /></label><label htmlFor="demo-email">Test email<input id="demo-email" type="email" value={email} onChange={event => setEmail(event.target.value)} required autoComplete="email" /></label><button className="button secondary full" disabled={busy}>Continue with local test account</button></form>}<p className="market-fine">We request basic Google identity only, never Drive files or browsing history. Read our <Link prefetch={false} href="/privacy">privacy policy</Link>.</p><Link prefetch={false} href="/" className="text-button">Continue as a guest</Link></>}{error && <p className="market-error" role="alert">{error}</p>}</section></MarketShell>;
}
