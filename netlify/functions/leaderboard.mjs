import { connectLambda, getStore } from '@netlify/blobs';

const STORE_NAME = 'idle-friends-2-shared';
const LEADERBOARD_KEY = 'leaderboard-v1';
const NAMES_KEY = 'registered-names-v1';
const PRESENCE_KEY = 'presence-v1';
const ADMIN_NAME = 'test123';

const cleanName = value => String(value ?? '').trim().slice(0, 24);
const normName = value => cleanName(value).toLowerCase();

const json = (statusCode, data) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  },
  body: JSON.stringify(data)
});

const readBody = event => {
  try { return JSON.parse(event.body || '{}'); } catch { return {}; }
};

const numeric = value => Math.max(0, Number(value) || 0);

export const handler = async event => {
  try {
    connectLambda(event);
    const store = getStore({ name: STORE_NAME });
    const method = event.httpMethod;

    const read = async (key, fallback) =>
      (await store.get(key, { type: 'json' })) ?? fallback;
    const write = async (key, value) => store.setJSON(key, value);

    if (method === 'OPTIONS') return json(204, {});

    if (method === 'GET') {
      const requestedName = cleanName(event.queryStringParameters?.name);

      if (requestedName) {
        const names = await read(NAMES_KEY, {});
        return json(200, {
          registered: Boolean(names[normName(requestedName)])
        });
      }

      const rows = await read(LEADERBOARD_KEY, []);
      const safeRows = rows.filter(
        row => normName(row?.name) !== ADMIN_NAME
      );

      safeRows.sort(
        (a, b) => numeric(b.rebirths) - numeric(a.rebirths)
      );

      return json(200, safeRows.slice(0, 500));
    }

    if (method === 'DELETE') {
      const name = cleanName(event.queryStringParameters?.name);
      const key = normName(name);

      if (!key) return json(400, { error: 'name required' });

      const rows = await read(LEADERBOARD_KEY, []);
      await write(
        LEADERBOARD_KEY,
        rows.filter(row => normName(row?.name) !== key)
      );

      const names = await read(NAMES_KEY, {});
      delete names[key];
      await write(NAMES_KEY, names);

      const sessions = await read(PRESENCE_KEY, {});
      for (const [id, player] of Object.entries(sessions)) {
        if (normName(player?.name) === key) delete sessions[id];
      }
      await write(PRESENCE_KEY, sessions);

      return json(200, { ok: true, deleted: name });
    }

    if (method !== 'POST') {
      return json(405, { error: 'Method not allowed' });
    }

    const body = readBody(event);
    const name = cleanName(body.name);
    const key = normName(name);

    if (!key) return json(400, { error: 'name required' });
    if (key === ADMIN_NAME) return json(200, { ok: true, ignored: true });

    const names = await read(NAMES_KEY, {});

    if (body.action === 'register') {
      if (names[key]) {
        return json(409, { error: 'name already registered' });
      }

      names[key] = name;
      await write(NAMES_KEY, names);
      return json(201, { ok: true });
    }

    if (names[key] && names[key] !== name) {
      return json(409, { error: 'name already registered' });
    }

    if (!names[key]) {
      names[key] = name;
      await write(NAMES_KEY, names);
    }

    const rows = await read(LEADERBOARD_KEY, []);

    const best = body.bestFriend && typeof body.bestFriend === 'object'
      ? {
          name: String(body.bestFriend.name ?? 'Unbekannt').slice(0, 80),
          rarity: String(body.bestFriend.rarity ?? 'Normal').slice(0, 40),
          mutations: Array.isArray(body.bestFriend.mutations)
            ? body.bestFriend.mutations.map(v => String(v).slice(0, 40)).slice(0, 8)
            : [],
          income: numeric(body.bestFriend.income)
        }
      : null;

    const record = {
      name: names[key],
      rebirths: numeric(body.rebirths),
      bestFriend: best,
      totalIncome: numeric(body.totalIncome),
      playtimeSeconds: numeric(body.playtimeSeconds),
      updatedAt: Date.now()
    };

    const index = rows.findIndex(row => normName(row?.name) === key);

    if (index >= 0) rows[index] = record;
    else rows.push(record);

    await write(LEADERBOARD_KEY, rows);
    return json(200, { ok: true });
  } catch (error) {
    console.error('Leaderboard function failed:', error);
    return json(500, { error: 'Leaderboard server error' });
  }
};
