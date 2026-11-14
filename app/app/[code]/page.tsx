import { notFound } from 'next/navigation';
import Home from '../page';

export default async function SessionPage({params}: {params: Promise<{code: string}>}) {
  const {code} = await params;
  if (!/^[a-f0-9]{6}$/.test(code)) notFound();
  return <Home />;
}
