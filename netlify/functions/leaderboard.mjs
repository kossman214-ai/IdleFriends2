import { connectLambda, getStore } from '@netlify/blobs';

const STORE_NAME = 'idle-friends-2-shared';
const LEADERBOARD_KEY = 'leaderboard-v1';
const NAMES_KEY = 'registered-names-v1';
const PRESENCE_KEY = 'presence-v1';
const BANS_KEY = 'bans-v1';
const GLOBAL_EVENT_KEY = 'global-event-v1';
const EVENT_THEMES = ['gold','galaxy','forest','neon','ocean','volcano','candy'];
const EVENT_MUSIC = ['chiptune','epic','chill','mystery','none'];
const pickEventValue = (value, allowed) => value === 'random' || !allowed.includes(value) ? allowed[Math.floor(Math.random() * allowed.length)] : value;
const GLOBAL_SPAWNS_KEY = 'global-spawns-v1';
const ADMIN_MESSAGES_KEY = 'admin-messages-v1';
const ADMIN_CHAT_KEY = 'admin-chat-enabled-v1';
const ADMIN_POLL_KEY = 'admin-poll-v1';
const ADMIN_CHAT_CLEARED_KEY = 'admin-chat-cleared-at-v1';
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

      // Globalen Chat-Status für alle Clients abrufen.
      if (qs.adminChat === '1') {
        return json(200, { enabled: (await read(ADMIN_CHAT_KEY, { enabled: false }))?.enabled === true });
      }

      // Aktuelle Community-Umfrage; nach 30 Sekunden wird das Ergebnis dauerhaft in den Chat geschrieben.
      if (qs.adminPoll === '1') {
        let poll = await read(ADMIN_POLL_KEY, null);
        const clearedAt = Number(await read(ADMIN_CHAT_CLEARED_KEY, 0)) || 0;
        // Never show or resurrect a poll that was cleared by the admin.
        if (poll && Number(poll.createdAt || 0) <= clearedAt) poll = null;
        if (poll && poll.status === 'active' && Date.now() >= Number(poll.endsAt)) {
          const totals = poll.options.map((_, i) => Object.values(poll.votes || {}).filter(v => Number(v) === i).length);
          const maxVotes = Math.max(0, ...totals);
          const winners = poll.options.filter((_, i) => totals[i] === maxVotes);
          const winnerText = maxVotes === 0 ? 'Es gab keine Stimmen.' : winners.length > 1 ? 'Unentschieden: ' + winners.join(' / ') + ' (' + maxVotes + ' Stimmen).' : 'Gewonnen hat „' + winners[0] + '“ mit ' + maxVotes + ' Stimme' + (maxVotes === 1 ? '' : 'n') + '!';
          const finishedPoll = { ...poll, status: 'finished', finishedAt: Date.now(), resultText: maxVotes === 0 ? 'Gewonnen: Niemand (keine Stimmen)' : 'Gewonnen: ' + (winners.length > 1 ? winners.join(' / ') : winners[0]), totals };
          // Re-check the clear marker before writing a result, to avoid a late poll request restoring deleted results.
          const latestClearedAt = Number(await read(ADMIN_CHAT_CLEARED_KEY, 0)) || 0;
          if (Number(poll.createdAt || 0) > latestClearedAt) {
            await write(ADMIN_POLL_KEY, finishedPoll);
            const messages = await read(ADMIN_MESSAGES_KEY, []);
            const stillNotCleared = Number(await read(ADMIN_CHAT_CLEARED_KEY, 0)) || 0;
            if (Number(poll.createdAt || 0) > stillNotCleared) {
              await write(ADMIN_MESSAGES_KEY, [...messages, { id: Date.now() * 1000, createdAt: Date.now(), expiresAt: Date.now() + 10000, sender: 'Admin', message: finishedPoll.resultText, type: 'poll-result', pollId: poll.id }].slice(-3));
            }
            poll = finishedPoll;
          } else {
            poll = null;
          }
        }
        const requestedName = normName(qs.name);
        const safePoll = poll ? { ...poll, hasVoted: Boolean(poll.votes && poll.votes[requestedName]) } : null;
        return json(200, { poll: safePoll });
      }

      // Admin-Nachrichten abrufen: nur die letzten 3 Einträge bleiben erhalten.
      if (qs.adminMessages === '1') {
        const since = Math.max(0, Number(qs.since) || 0);
        const now = Date.now();
        const storedMessages = await read(ADMIN_MESSAGES_KEY, []);
        const messages = storedMessages.filter(item => now < Number(item?.expiresAt || (Number(item?.createdAt || 0) + 10000)));
        if (messages.length !== storedMessages.length) await write(ADMIN_MESSAGES_KEY, messages.slice(-3));
        if (qs.all === '1') return json(200, { messages: messages.slice(-3) });
        return json(200, { messages: messages.filter(item => Number(item?.id) > since).slice(0, 3) });
      }

      // Globale Admin-Spawns abrufen: jeder Client pollt mit seinem letzten Event-Cursor.
      if (qs.globalSpawns === '1') {
        const since = Math.max(0, Number(qs.since) || 0);
        const events = await read(GLOBAL_SPAWNS_KEY, []);
        return json(200, {
          events: events.filter(item => Number(item?.id) > since).slice(0, 100)
        });
      }

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
        let globalEvent = await read(GLOBAL_EVENT_KEY, null);
        if (globalEvent && globalEvent.endsAt && Date.now() >= Number(globalEvent.endsAt)) {
          globalEvent = null;
          await write(GLOBAL_EVENT_KEY, null);
        }
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

    // Chat-Schaltfläche global ein-/ausschalten; Status liegt serverseitig und gilt für alle Spieler.
    if (action === 'toggle-admin-chat') {
      if (normName(body.adminName) !== ADMIN_NAME) return json(401, { error: 'Unauthorized admin chat toggle' });
      const enabled = body.enabled === true;
      await write(ADMIN_CHAT_KEY, { enabled, updatedAt: Date.now() });
      return json(200, { ok: true, enabled });
    }

    // Admin-Nachrichten serverseitig speichern und global an alle Clients verteilen.
    if (action === 'send-admin-message') {
      if (normName(body.adminName) !== ADMIN_NAME) return json(401, { error: 'Unauthorized admin message' });
      const message = String(body.message ?? '').trim().slice(0, 300);
      if (!message) return json(400, { error: 'Message required' });
      const messages = await read(ADMIN_MESSAGES_KEY, []);
      const createdAt = Date.now();
      const item = { id: createdAt * 1000, createdAt, expiresAt: createdAt + 10000, sender: 'Admin', message };
      await write(ADMIN_MESSAGES_KEY, [...messages, item].slice(-3));
      return json(200, { ok: true, id: item.id });
    }

    if (action === 'clear-admin-chat') {
      if (normName(body.adminName) !== ADMIN_NAME) return json(401, { error: 'Unauthorized chat clearing' });
      const clearedAt = Date.now();
      // Write the tombstone first so a poll request already in flight cannot restore old results.
      await write(ADMIN_CHAT_CLEARED_KEY, clearedAt);
      await write(ADMIN_MESSAGES_KEY, []);
      // Delete the poll key entirely instead of storing JSON null.
      try { await store.delete(ADMIN_POLL_KEY); } catch { await write(ADMIN_POLL_KEY, null); }
      const remainingMessages = await read(ADMIN_MESSAGES_KEY, []);
      const remainingPoll = await read(ADMIN_POLL_KEY, null);
      if (remainingMessages.length || (remainingPoll && Number(remainingPoll.createdAt || 0) <= clearedAt)) {
        return json(500, { ok: false, error: 'Der Server konnte den Chat nicht vollständig leeren. Bitte erneut versuchen.' });
      }
      return json(200, { ok: true, cleared: true, clearedAt, messagesRemaining: remainingMessages.length, pollRemaining: Boolean(remainingPoll) });
    }

    if (action === 'delete-admin-message') {
      if (normName(body.adminName) !== ADMIN_NAME) return json(401, { error: 'Unauthorized message deletion' });
      const messageId = String(body.messageId ?? '');
      const messages = await read(ADMIN_MESSAGES_KEY, []);
      const filtered = messages.filter(item => String(item?.id) !== messageId);
      if (filtered.length === messages.length) return json(404, { error: 'Nachricht nicht gefunden.' });
      await write(ADMIN_MESSAGES_KEY, filtered.slice(-3));
      return json(200, { ok: true });
    }

    if (action === 'create-admin-poll') {
      if (normName(body.adminName) !== ADMIN_NAME) return json(401, { error: 'Unauthorized poll creation' });
      const question = String(body.question || '').trim().slice(0, 180);
      const options = Array.isArray(body.options) ? body.options.map(x => String(x || '').trim().slice(0, 80)).filter(Boolean).slice(0, 8) : [];
      const requestedDuration = Number(body.durationSeconds);
      const durationSeconds = [15, 30, 45, 60, 90, 120].includes(requestedDuration) ? requestedDuration : 30;
      if (!question || options.length < 2) return json(400, { error: 'Question and at least two options required' });
      const poll = { id: String(Date.now()), question, options, durationSeconds, createdAt: Date.now(), endsAt: Date.now() + durationSeconds * 1000, status: 'active', votes: {} };
      await write(ADMIN_POLL_KEY, poll);
      return json(200, { ok: true, poll });
    }

    if (action === 'vote-admin-poll') {
      const name = normName(body.name);
      if (!name) return json(400, { error: 'Player name required' });
      let poll = await read(ADMIN_POLL_KEY, null);
      const clearedAt = Number(await read(ADMIN_CHAT_CLEARED_KEY, 0)) || 0;
      if (poll && Number(poll.createdAt || 0) <= clearedAt) poll = null;
      if (!poll || poll.status !== 'active' || String(poll.id) !== String(body.pollId)) return json(409, { error: 'Diese Umfrage ist nicht mehr aktiv.' });
      if (Date.now() >= Number(poll.endsAt)) return json(409, { error: 'Die Abstimmung ist bereits beendet.' });
      if (Object.prototype.hasOwnProperty.call(poll.votes || {}, name)) return json(409, { error: 'Du hast bereits abgestimmt.' });
      const optionIndex = Number(body.optionIndex);
      if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) return json(400, { error: 'Invalid option' });
      poll.votes = { ...(poll.votes || {}), [name]: optionIndex };
      await write(ADMIN_POLL_KEY, poll);
      return json(200, { ok: true });
    }

    // Globale Spawns werden serverseitig gespeichert und von allen aktiven Clients abgeholt.
    // Nur das Admin-Konto darf diese Aktionen auslösen.
    if (action === 'spawn-friend' || action === 'spawn-friends') {
      if (normName(body.adminName) !== ADMIN_NAME) {
        return json(401, { error: 'Unauthorized admin spawn' });
      }

      const incoming = action === 'spawn-friends'
        ? (Array.isArray(body.friends) ? body.friends : [])
        : [{ ...(body.friend || {}), mutations: body.mutations }];

      if (!incoming.length) return json(400, { error: 'No friends supplied' });

      const cleanFriend = item => {
        const friend = item && typeof item === 'object' ? item : {};
        const name = String(friend.name ?? '').trim().slice(0, 80);
        if (!name) return null;
        return {
          name,
          rarity: String(friend.rarity ?? 'Normal').slice(0, 40),
          value: numeric(friend.value),
          cost: numeric(friend.cost),
          mutations: Array.isArray(friend.mutations)
            ? friend.mutations.map(value => String(value).slice(0, 40)).slice(0, 8)
            : []
        };
      };

      const friends = incoming.map(cleanFriend).filter(Boolean).slice(0, 200);
      if (!friends.length) return json(400, { error: 'No valid friends supplied' });

      const events = await read(GLOBAL_SPAWNS_KEY, []);
      const activeEvent = await read(GLOBAL_EVENT_KEY, null);
      const goldRushActive = !!(activeEvent && activeEvent.active && activeEvent.goldRush && (!activeEvent.endsAt || Date.now() < Number(activeEvent.endsAt)));
      const baseId = Date.now() * 1000;
      const added = friends.map((friend, index) => ({
        id: baseId + index,
        createdAt: Date.now(),
        friend: {
          name: friend.name,
          rarity: friend.rarity,
          value: friend.value,
          cost: friend.cost
        },
        mutations: goldRushActive ? ['Gold'] : friend.mutations
      }));
      const nextEvents = [...events, ...added].slice(-300);
      await write(GLOBAL_SPAWNS_KEY, nextEvents);
      return json(200, { ok: true, action, published: added.length });
    }

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

    if (action === 'start-gold-rush') {
      const durationSeconds = [20, 40, 60].includes(Number(body.durationSeconds)) ? Number(body.durationSeconds) : 20;
      const theme = pickEventValue(String(body.theme || 'random'), EVENT_THEMES);
      const musicStyle = pickEventValue(String(body.musicStyle || 'random'), EVENT_MUSIC);
      const startedAt = Date.now();
      const globalEvent = {
        active: true,
        type: 'gold-rush',
        goldRush: true,
        label: 'GOLD RUSH',
        theme,
        musicStyle,
        luckMult: 0,
        incomeMult: 1,
        durationSeconds,
        startedAt,
        endsAt: startedAt + durationSeconds * 1000,
        setBy: ADMIN_NAME
      };
      await write(GLOBAL_EVENT_KEY, globalEvent);
      return json(200, { action: 'start-gold-rush', ok: true, event: globalEvent });
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
      const theme = pickEventValue(String(body.theme || 'random'), EVENT_THEMES);
      const musicStyle = pickEventValue(String(body.musicStyle || 'random'), EVENT_MUSIC);
      const endsAt = durationMinutes > 0 ? Date.now() + durationMinutes * 60 * 1000 : null;

      const globalEvent = {
        active: true,
        label,
        theme,
        musicStyle,
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
