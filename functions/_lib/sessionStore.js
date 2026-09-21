const sessions = new Map();

export function saveSession(token, actorType, actorId, permissions) {
  sessions.set(token, {
    actorType,
    actorId,
    permissions,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
  });
}

export function getSession(token) {
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function deleteSession(token) {
  sessions.delete(token);
}

export function isDbAvailable(env) {
  return !!(env.NEON_DATABASE_URL && env.NEON_AUTH_TOKEN);
}
