import { connectLambda, getStore } from '@netlify/blobs';

const STORE_NAME = 'idle-friends-2-shared';
const KEY = 'presence-v1';
const BANS_KEY = 'bans-v1';
const TTL_MS = 45_000;
const ADMIN_NAME = 'maxtest';

const cleanName = value => String(value ?? '').trim().slice(0, 24);
const normName = value => cleanName(value).toLowerCase();

const json = (statusCode, data) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  },
  body: JSON.stringify(data)
});

const readBody = event => {
  try { return JSON.parse(event.body || '{}'); } catch { return {}; }
};

export const handler = async event => {
  try {
    connectLambda(event);

    const store = getStore({ name: STORE_NAME });
    const now = Date.now();
    const sessions = (await store.get(KEY, { type: 'json' })) ?? {};
    const bans = (await store.get(BANS_KEY, { type: 'json' })) ?? {};

    for (const [id, player] of Object.entries(sessions)) {
      const playerKey = normName(player?.name);
      if (
        !player ||
        now - (Number(player.lastSeen) || 0) > TTL_MS ||
        playerKey === ADMIN_NAME ||
        bans[playerKey]
      ) {
        delete sessions[id];
      }
    }

    const makeList = () => {
      const byName = new Map();
      for (const player of Object.values(sessions)) {
        const key = normName(player.name);
        if (bans[key] || key === ADMIN_NAME) continue;
        const previous = byName.get(key);
        if (!previous || Number(player.lastSeen) > Number(previous.lastSeen)) {
          byName.set(key, player);
        }
      }
      return [...byName.values()].sort(
        (a, b) => String(a.name).localeCompare(String(b.name), 'de')
      );
    };

    if (event.httpMethod === 'OPTIONS') return json(204, {});

    if (event.httpMethod === 'GET') {
      await store.setJSON(KEY, sessions);
      const players = makeList();
      return json(200, { onlineCount: players.length, players });
    }

    if (event.httpMethod !== 'POST') {
      return json(405, { error: 'Method not allowed' });
    }

    const body = readBody(event);
    const sessionId = String(body.sessionId ?? '').trim().slice(0, 100);

    if (!sessionId) {
      return json(400, { error: 'sessionId required' });
    }

    if (body.action === 'leave' || body.action === 'delete-account') {
      delete sessions[sessionId];

      if (body.action === 'delete-account') {
        const deletedName = normName(body.name);
        if (deletedName) {
          for (const [id, player] of Object.entries(sessions)) {
            if (normName(player?.name) === deletedName) {
              delete sessions[id];
            }
          }
        }
      }
    } else {
      const name = cleanName(body.name);
      if (!name) return json(400, { error: 'name required' });

      const key = normName(name);

      if (bans[key]) {
        delete sessions[sessionId];
        await store.setJSON(KEY, sessions);
        return json(403, {
          error: 'banned',
          banned: true,
          message: 'Dieses Konto wurde gesperrt.',
          onlineCount: makeList().length,
          players: makeList()
        });
      }

      if (key === ADMIN_NAME) {
        delete sessions[sessionId];
      } else {
        const stats = body.stats && typeof body.stats === 'object' ? body.stats : {};

        sessions[sessionId] = {
          name,
          rebirths: Math.max(0, Number(stats.rebirths) || 0),
          totalIncome: Math.max(0, Number(stats.totalIncome) || 0),
          playtimeSeconds: Math.max(0, Number(stats.playtimeSeconds) || 0),
          bestFriend: stats.bestFriend && typeof stats.bestFriend === 'object'
            ? {
                name: String(stats.bestFriend.name ?? 'Unbekannt').slice(0, 80),
                rarity: String(stats.bestFriend.rarity ?? 'Normal').slice(0, 40),
                mutations: Array.isArray(stats.bestFriend.mutations)
                  ? stats.bestFriend.mutations.map(v => String(v).slice(0, 40)).slice(0, 8)
                  : [],
                income: Math.max(0, Number(stats.bestFriend.income) || 0)
              }
            : null,
          lastSeen: now
        };
      }
    }

    await store.setJSON(KEY, sessions);
    const players = makeList();

    return json(200, {
      ok: true,
      onlineCount: players.length,
      players
    });
  } catch (error) {
    console.error('Presence function failed:', error);
    return json(500, { error: 'Presence server error' });
  }
};
