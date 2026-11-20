import type { Merchant } from '../db/schema.js';

declare module 'fastify' {
  interface FastifyRequest {
    merchant: Merchant;
  }
}
