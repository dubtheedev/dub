import type { Env as DubEnv } from '../src/types';

declare global {
  namespace Cloudflare {
    interface Env extends DubEnv {}
  }
}

declare module 'cloudflare:test' {
  interface ProvidedEnv extends DubEnv {}
}
