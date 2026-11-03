import { json } from '@sveltejs/kit';
export const GET = () => json({ live: true }, { headers: { 'Cache-Control': 'no-store' } });
