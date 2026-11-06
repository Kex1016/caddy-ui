import { LoginLimiter, effectiveAuth, type EffectiveAuth } from './auth';
import { config } from './env';
import { makeSecret } from './session';

/** Process-wide singletons built from the config on first use. */
type Runtime = { auth: EffectiveAuth; secret: Buffer; limiter: LoginLimiter; startedAt: number };

let runtime: Runtime | undefined;

export function getRuntime(): Runtime {
	if (!runtime) {
		const cfg = config();
		runtime = {
			auth: effectiveAuth(cfg),
			secret: makeSecret(cfg.sessionSecret),
			limiter: new LoginLimiter(),
			startedAt: Date.now()
		};
	}
	return runtime;
}
