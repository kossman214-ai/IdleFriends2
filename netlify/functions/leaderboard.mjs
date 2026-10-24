import { connectLambda, getStore } from '@netlify/blobs';

const STORE_NAME = 'idle-friends-2-shared';
const LEADERBOARD_KEY = 'leaderboard-v1';
const NAMES_KEY = 'registered-names-v1';
const PRESENCE_KEY = 'presence-v1';
const BANS_KEY = 'bans-v1';
const GLOBAL_EVENT_KEY = 'global-event-v1';
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
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS'
  },
  body: JSON.stringify(data)
});

const readBody = event => {
  try { return JSON.parse(event.body || '{}'); } catch { return {}; }
};

const numeric = value => Math.max(0, Number(value) || 0);

// Kein Passwort – Admin-Aktionen sind freigeschaltet.
const isAuthorizedAdmin = () => true;

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
      const qs = event.queryStringParameters || {};
      const requestedName = cleanName(qs.name);

      if (qs.banCheck) {
        const bans = await read(BANS_KEY, {});
        const rows = await read(LEADERBOARD_KEY, []);
        const safeRows = rows.filter(row => {
          const n = normName(row?.name);
          return n && n !== ADMIN_NAME && !bans[n];
        });
        safeRows.sort((a, b) => numeric(b.rebirths) - numeric(a.rebirths));
        return json(200, safeRows.slice(0, 500));
      }

      if (requestedName) {
        const names = await read(NAMES_KEY, {});
        const bans = await read(BANS_KEY, {});
        const key = normName(requestedName);
        return json(200, {
          registered: Boolean(names[key]),
          banned: Boolean(bans[key])
        });
      }

      if (qs.event === '1' || qs.globalEvent === '1') {
        const globalEvent = await read(GLOBAL_EVENT_KEY, null);
        return json(200, { event: globalEvent });
      }

      const bans = await read(BANS_KEY, {});
      const rows = await read(LEADERBOARD_KEY, []);
      const safeRows = rows.filter(row => {
        const n = normName(row?.name);
        return n && n !== ADMIN_NAME && !bans[n];
      });

      safeRows.sort((a, b) => numeric(b.rebirths) - numeric(a.rebirths));
      return json(200, safeRows.slice(0, 500));
    }

    if (method === 'DELETE') {
      const name = cleanName(event.queryStringParameters?.name);
      const key = normName(name);
      if (!key) return json(400, { error: 'name required' });

      const rows = await read(LEADERBOARD_KEY, []);
      await write(LEADERBOARD_KEY, rows.filter(row => normName(row?.name) !== key));

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
    const action = String(body.action || '').toLowerCase();

    if (action === 'ban') {
      if (!isAuthorizedAdmin()) return json(401, { error: 'Unauthorized' });
      const name = cleanName(body.name);
      const key = normName(name);
      if (!key) return json(400, { error: 'name required' });
      if (key === ADMIN_NAME) return json(400, { error: 'Cannot ban the admin account' });

      const bans = await read(BANS_KEY, {});
      bans[key] = { name, bannedAt: Date.now(), bannedBy: ADMIN_NAME };
      await write(BANS_KEY, bans);

      const rows = await read(LEADERBOARD_KEY, []);
      await write(LEADERBOARD_KEY, rows.filter(row => normName(row?.name) !== key));

      const names = await read(NAMES_KEY, {});
      delete names[key];
      await write(NAMES_KEY, names);

      const sessions = await read(PRESENCE_KEY, {});
      for (const [id, player] of Object.entries(sessions)) {
        if (normName(player?.name) === key) delete sessions[id];
      }
      await write(PRESENCE_KEY, sessions);

      return json(200, { action: 'ban', banned: true, banVersion: 2, name, ok: true });
    }

    if (action === 'unban') {
      if (!isAuthorizedAdmin()) return json(401, { error: 'Unauthorized' });
      const name = cleanName(body.name);
      const key = normName(name);
      if (!key) return json(400, { error: 'name required' });
      const bans = await read(BANS_KEY, {});
      delete bans[key];
      await write(BANS_KEY, bans);
      return json(200, { action: 'unban', ok: true, name });
    }

    if (action === 'set-event' || action === 'clear-event') {
      if (!isAuthorizedAdmin()) return json(401, { error: 'Unauthorized' });

      if (action === 'clear-event') {
        await write(GLOBAL_EVENT_KEY, null);
        return json(200, { action: 'clear-event', ok: true, event: null });
      }

      const label = String(body.label || body.eventLabel || 'Admin-Event').slice(0, 120);
      const luckMult = Math.max(0, Number(body.luckMult) || 0);
      const incomeMult = Math.max(1, Number(body.incomeMult) || 1);
      const durationMinutes = Math.max(0, Number(body.durationMinutes) || 0);
      const endsAt = durationMinutes > 0 ? Date.now() + durationMinutes * 60 * 1000 : null;

      const globalEvent = {
        active: true,
        label,
        luckMult,
        incomeMult,
        startedAt: Date.now(),
        endsAt,
        setBy: ADMIN_NAME
      };
      await write(GLOBAL_EVENT_KEY, globalEvent);
      return json(200, { action: 'set-event', ok: true, event: globalEvent });
    }

    const name = cleanName(body.name);
    const key = normName(name);
    if (!key) return json(400, { error: 'name required' });
    if (key === ADMIN_NAME) return json(200, { ok: true, ignored: true });

    const bans = await read(BANS_KEY, {});
    if (bans[key]) {
      return json(403, {
        error: 'banned',
        banned: true,
        message: 'Dieses Konto wurde gesperrt.'
      });
    }

    const names = await read(NAMES_KEY, {});

    if (body.action === 'register') {
      if (names[key]) return json(409, { error: 'name already registered' });
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
