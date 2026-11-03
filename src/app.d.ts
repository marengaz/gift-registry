import type { Actor } from './lib/server/access';
declare global {
	namespace App {
		interface Locals {
			actor: Actor | null;
		}
	}
}
export {};
