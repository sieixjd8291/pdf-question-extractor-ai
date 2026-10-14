process.env.NODE_ENV='production';
await import(new URL('../dist/server.mjs', import.meta.url).href);
