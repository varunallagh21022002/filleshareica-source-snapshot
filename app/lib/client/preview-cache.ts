interface Registration {
  scope: string;
  active?: {scriptURL: string} | null;
  waiting?: {scriptURL: string} | null;
  installing?: {scriptURL: string} | null;
  unregister(): Promise<boolean>;
}
interface Workers {getRegistrations(): Promise<readonly Registration[]>}
interface ShellCaches {keys(): Promise<string[]>; delete(name: string): Promise<boolean>}

/** A production worker must not intercept Vite's development CSS/module URLs. */
export async function clearPreviewShell(origin: string, workers: Workers, caches?: ShellCaches): Promise<void> {
  const registrations = await workers.getRegistrations();
  const owns = (registration: Registration) => {
    if (registration.scope !== `${origin}/`) return false;
    return [registration.active, registration.waiting, registration.installing].some(worker => {
      if (!worker) return false;
      try {const url = new URL(worker.scriptURL); return url.origin === origin && url.pathname === '/sw.js';}
      catch {return false;}
    });
  };
  await Promise.all(registrations.filter(owns).map(registration => registration.unregister()));
  if (caches) {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('fileshare-shell-') || name.startsWith('fil3shareica-shell-')).map(name => caches.delete(name)));
  }
  // No reload: selected files and active peer connections must survive cleanup.
  // A normal refresh sheds an existing worker's control. IndexedDB is untouched.
}
