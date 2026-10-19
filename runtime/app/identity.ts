export type Identity = Readonly<{
  caller: "user" | "api" | "agent";
  user: Readonly<{ id: string; email: string }> | null;
}>;

const identityKey = Symbol("request identity");
type IdentityEnv = { [identityKey]?: Identity };

export function withIdentity<E extends object>(env: E, identity: Identity): E {
  const copy = { ...env };
  const value = Object.freeze({
    caller: identity.caller,
    user: identity.user ? Object.freeze({ ...identity.user }) : null,
  });
  Object.defineProperty(copy, identityKey, { value });
  return copy;
}

export function caller(c: { env: object }): Identity["caller"] | null {
  return (c.env as IdentityEnv)[identityKey]?.caller ?? null;
}

export function user(c: { env: object }): Identity["user"] {
  return (c.env as IdentityEnv)[identityKey]?.user ?? null;
}
