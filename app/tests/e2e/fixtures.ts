import { randomBytes } from 'node:crypto';
import { test as base, expect } from '@playwright/test';

/** Each independent local scenario gets its own anonymous-client quota. */
export const test = base.extend({
  context: async ({ context, baseURL, extraHTTPHeaders }, run) => {
    if (baseURL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname)) {
      const address = randomBytes(2);
      await context.setExtraHTTPHeaders({ ...extraHTTPHeaders, 'CF-Connecting-IP': `198.18.${address[0]}.${address[1]}` });
    }
    await run(context);
  },
});
export { expect };
