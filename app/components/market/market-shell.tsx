'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, ShieldCheck } from 'lucide-react';
import './market.css';

export function MarketShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return <div className="market-page"><header className="market-header"><Link prefetch={false} href="/" className="brand" aria-label="fil3shareica home"><span className="brand-mark"><ArrowUpRight size={23} /></span>fil3shareica<span className="brand-dot">.</span></Link><Link prefetch={false} className="market-back" href="/"><ArrowLeft size={16} />Back to sharing</Link></header><main className="market-main"><p className="eyebrow"><span />YOUR FILES. YOUR CHOICE.</p><h1>{title}</h1><p className="market-subtitle">{subtitle}</p>{children}</main><footer className="market-footer"><span><ShieldCheck size={15} />Your files stay between your devices.</span><nav aria-label="Legal and support"><Link prefetch={false} href="/privacy">Privacy</Link><Link prefetch={false} href="/terms">Terms</Link><Link prefetch={false} href="/contact">Help & contact</Link></nav></footer></div>;
}
