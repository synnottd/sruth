import { buildApp, buildInternalApp } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = await buildApp();
await app.listen({ port: PORT, host: HOST });
console.log(`API listening on ${HOST}:${PORT}`);

const internal = await buildInternalApp();
await internal.listen({ port: INTERNAL_PORT, host: HOST });
console.log(`Internal API listening on ${HOST}:${INTERNAL_PORT}`);
