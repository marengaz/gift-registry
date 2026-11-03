import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { getDatabase, type DatabaseConnection } from './db/client';
import * as schema from './db/auth-schema';
export type AuthEnvironment = {
	origin?: string;
	secret?: string;
	googleClientId?: string;
	googleClientSecret?: string;
	administratorEmail?: string;
	administratorGoogleSubject?: string;
};
export function authEnvironment(): AuthEnvironment {
	return {
		origin: process.env.ORIGIN,
		secret: process.env.BETTER_AUTH_SECRET,
		googleClientId: process.env.GOOGLE_CLIENT_ID,
		googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
		administratorEmail: process.env.ADMINISTRATOR_EMAIL,
		administratorGoogleSubject: process.env.ADMINISTRATOR_GOOGLE_SUBJECT
	};
}
export function authSetup(environment: AuthEnvironment = authEnvironment()) {
	const missing: string[] = [];
	if (!environment.origin) missing.push('ORIGIN');
	else {
		try {
			const url = new URL(environment.origin);
			if (
				url.origin !== environment.origin ||
				!['http:', 'https:'].includes(url.protocol) ||
				(url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
			)
				missing.push('ORIGIN (an HTTPS origin, or localhost for development)');
		} catch {
			missing.push('ORIGIN (a valid origin)');
		}
	}
	if (!environment.secret || environment.secret.length < 32)
		missing.push('BETTER_AUTH_SECRET (at least 32 random characters)');
	if (!environment.googleClientId) missing.push('GOOGLE_CLIENT_ID');
	if (!environment.googleClientSecret) missing.push('GOOGLE_CLIENT_SECRET');
	if (!environment.administratorEmail && !environment.administratorGoogleSubject)
		missing.push('ADMINISTRATOR_EMAIL or ADMINISTRATOR_GOOGLE_SUBJECT');
	return { ready: missing.length === 0, missing };
}
export function createAuth(connection: DatabaseConnection, environment: AuthEnvironment) {
	if (!authSetup(environment).ready) throw new Error('Google sign-in is not configured.');
	return betterAuth({
		baseURL: environment.origin!,
		secret: environment.secret!,
		trustedOrigins: [environment.origin!],
		database: drizzleAdapter(connection.db, { provider: 'sqlite', schema }),
		emailAndPassword: { enabled: false },
		socialProviders: {
			google: {
				clientId: environment.googleClientId!,
				clientSecret: environment.googleClientSecret!,
				scope: ['openid', 'email', 'profile'],
				disableDefaultScope: true,
				includeGrantedScopes: false,
				accessType: 'online',
				overrideUserInfoOnSignIn: true
			}
		},
		account: { accountLinking: { enabled: false, disableImplicitLinking: true } },
		session: { cookieCache: { enabled: false } },
		onAPIError: { errorURL: '/login' }
	});
}
export type AuthService = ReturnType<typeof createAuth>;
let instance: AuthService | undefined;
export function getAuth(): AuthService | null {
	const environment = authEnvironment();
	if (!authSetup(environment).ready) return null;
	return (instance ??= createAuth(getDatabase(), environment));
}
