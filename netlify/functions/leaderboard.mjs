import { getStore } from "@netlify/blobs";

const store = getStore({ name: "idle-friends-2-shared" });
const KEY = "leaderboard-v1";
const NAMES = "registered-names-v1";

const clean = n => String(n ?? "").trim().slice(0, 24);
const norm = n => clean(n).toLowerCase();

const json = (statusCode, data) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  },
  body: JSON.stringify(data)
});

const readBody = event => {
  try {
    return JSON.parse(event.body || "{}");
  } catch {
    return {};
  }
};

async function getData(key, fallback) {
  return (await store.get(key, { type: "json" })) ?? fallback;
}

async function save(key, value) {
  await store.setJSON(key, value);
}

export default async event => {
  try {
    const method = event.httpMethod;

    if (method === "OPTIONS") {
      return json(204, {});
    }

    if (method === "GET") {
      const name = clean(event.queryStringParameters?.name);

      if (name) {
        const names = await getData(NAMES, {});
        return json(200, {
          registered: Boolean(names[norm(name)])
        });
      }

      const rows = await getData(KEY, []);

      rows.sort(
        (a, b) =>
          (Number(b.rebirths) || 0) -
          (Number(a.rebirths) || 0)
      );

      return json(200, rows.slice(0, 500));
    }

    if (method !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const body = readBody(event);
    const name = clean(body.name);
    const key = norm(name);

    if (!name) {
      return json(400, { error: "Name required" });
    }

    const names = await getData(NAMES, {});

    if (body.action === "register") {
      if (names[key]) {
        return json(409, { error: "Name already registered" });
      }

      names[key] = name;
      await save(NAMES, names);

      return json(201, { ok: true });
    }

    if (names[key] && names[key] !== name) {
      return json(409, { error: "Name already registered" });
    }

    if (!names[key]) {
      names[key] = name;
      await save(NAMES, names);
    }

    const rows = await getData(KEY, []);

    const record = {
      name: names[key],
      rebirths: Math.max(0, Number(body.rebirths) || 0),
      bestFriend:
        body.bestFriend &&
        typeof body.bestFriend === "object"
          ? body.bestFriend
          : null,
      totalIncome: Math.max(0, Number(body.totalIncome) || 0),
      playtimeSeconds: Math.max(
        0,
        Number(body.playtimeSeconds) || 0
      ),
      updatedAt: Date.now()
    };

    const index = rows.findIndex(
      row => norm(row.name) === key
    );

    if (index >= 0) {
      rows[index] = record;
    } else {
      rows.push(record);
    }

    await save(KEY, rows);

    return json(200, { ok: true });
  } catch (error) {
    console.error("Leaderboard error:", error);

    return json(500, {
      error: "Server error"
    });
  }
};
