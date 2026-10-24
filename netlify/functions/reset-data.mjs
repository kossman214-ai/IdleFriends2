import { connectLambda, getStore } from '@netlify/blobs';

const STORE_NAME = 'idle-friends-2-shared';
const LEADERBOARD_KEY = 'leaderboard-v1';
const NAMES_KEY = 'registered-names-v1';
const PRESENCE_KEY = 'presence-v1';
const BANS_KEY = 'bans-v1';
const GLOBAL_EVENT_KEY = 'global-event-v1';

const json = (statusCode, data) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'access-control-allow-methods': 'POST, OPTIONS'
  },
  body: JSON.stringify(data)
});

const getAdminSecret = () => String(process.env.ADMIN_SECRET || '').trim();

const isAuthorizedAdmin = event => {
  const secret = getAdminSecret();
  if (!secret) return false;
  const authHeader = String(event.headers?.authorization || event.headers?.Authorization || '').trim();
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  return bearer === secret;
};

export const handler = async event => {
  try {
    if (event.httpMethod === 'OPTIONS') return json(204, {});
    if (event.httpMethod !== 'POST') {
      return json(405, { error: 'Method not allowed' });
    }

    if (!isAuthorizedAdmin(event)) {
      return json(401, { error: 'Unauthorized – invalid or missing ADMIN_SECRET' });
    }

    connectLambda(event);
    const store = getStore({ name: STORE_NAME });

    await store.setJSON(LEADERBOARD_KEY, []);
    await store.setJSON(NAMES_KEY, {});
    await store.setJSON(PRESENCE_KEY, {});
    await store.setJSON(BANS_KEY, {});
    await store.setJSON(GLOBAL_EVENT_KEY, null);

    return json(200, {
      ok: true,
      cleared: [
        'leaderboard',
        'registered-names',
        'presence',
        'bans',
        'global-event'
      ]
    });
  } catch (error) {
    console.error('reset-data failed:', error);
    return json(500, { error: 'Reset failed' });
  }
};
