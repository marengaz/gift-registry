// Match the container upload allowance when running directly with Node.
process.env.BODY_SIZE_LIMIT ||= '64M';
await import(new URL('../build/index.js', import.meta.url).href);
