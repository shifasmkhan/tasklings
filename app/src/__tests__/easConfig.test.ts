import eas from '../../eas.json';

// The owner-only email and password sign-in (EXPO_PUBLIC_ENABLE_DEV_SIGNIN) must exist only in builds made
// with the `simulator-live` profile. The flag's value lives in the EAS `development` environment,
// so this guards the two ways it could leak into another build: a profile that sets the variable
// itself, and a profile that resolves to the `development` environment (or extends simulator-live).

const FLAG = 'EXPO_PUBLIC_ENABLE_DEV_SIGNIN';
const LIVE_PROFILE = 'simulator-live';

type Profile = Record<string, unknown> & { ios?: Record<string, unknown>; env?: Record<string, unknown> };
const easJson = eas as unknown as { build: Record<string, Profile> };
const profiles = Object.entries(easJson.build);
const others = profiles.filter(([name]) => name !== LIVE_PROFILE);

/** The EAS environment a profile resolves to: explicit, else development for a dev client. */
function environmentOf(profile: Profile): string {
  if (typeof profile.environment === 'string') return profile.environment;
  if (profile.developmentClient === true) return 'development';
  return profile.distribution === 'store' ? 'production' : 'preview';
}

describe('eas.json', () => {
  it('has the simulator-live profile', () => {
    expect(easJson.build[LIVE_PROFILE]).toBeDefined();
  });

  it.each(others)('%s does not set the dev sign-in flag', (_name, profile) => {
    expect(JSON.stringify(profile)).not.toContain(FLAG);
  });

  it.each(others)('%s does not use the development environment or extend simulator-live', (_name, profile) => {
    expect(environmentOf(profile)).not.toBe('development');
    expect(profile.extends).not.toBe(LIVE_PROFILE);
  });

  it.each(profiles)('%s carries no Supabase values (they come from EAS environment variables)', (_name, profile) => {
    expect(JSON.stringify(profile)).not.toMatch(/EXPO_PUBLIC_SUPABASE|SUPABASE_URL|ANON_KEY|service_role|sb_secret_/i);
  });

  it('simulator-live is an internal Simulator build that reads the development environment', () => {
    const live = easJson.build[LIVE_PROFILE]!;
    expect(live.distribution).toBe('internal');
    expect(live.ios?.simulator).toBe(true);
    expect(live.environment).toBe('development');
    expect(live.extends).toBeUndefined();
  });

  it('simulator-live does not set the flag itself either (its value is an EAS variable)', () => {
    expect(JSON.stringify(easJson.build[LIVE_PROFILE])).not.toContain(FLAG);
  });
});
