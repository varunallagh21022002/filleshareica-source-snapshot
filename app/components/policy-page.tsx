import Link from 'next/link';
import type { ReactNode } from 'react';
export function PolicyPage({title, children}: {title: string; children: ReactNode}) {
  return <main className="policy-page"><Link prefetch={false} className="policy-home" href="/">← Back to sharing</Link><p className="eyebrow">fil3shareica / PRODUCT INFORMATION</p><h1>{title}</h1><div className="policy-copy">{children}</div><nav aria-label="Product information"><Link prefetch={false} href="/privacy">Privacy</Link><Link prefetch={false} href="/terms">Terms & refunds</Link><Link prefetch={false} href="/contact">Contact</Link></nav></main>;
}
