import { connectLambda, getStore } from "@netlify/blobs";

export const handler = async (event) => {
  try {
    connectLambda(event);

    const store = getStore({ name: "idle-friends-2-shared" });
    const key = "leaderboard-v1";
    const namesKey = "registered-names-v1";

    const read = async (k, fallback) =>
      (await store.get(k, { type: "json" })) ?? fallback;

    const save = async (k, value) =>
      store.setJSON(k, value);

    const clean = (n) => String(n ?? "").trim().slice(0, 24);
    const norm = (n) => clean(n).toLowerCase();

    const respond = (statusCode, data) => ({
      statusCode,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store"
      },
      body: JSON.stringify(data)
    });

    if (event.httpMethod === "OPTIONS") {
      return respond(204, {});
    }

    if (event.httpMethod === "GET") {
      const name = clean(event.queryStringParameters?.name);

      if (name) {
        const names = await read(namesKey, {});
        return respond(200, {
          registered: Boolean(names[norm(name)])
        });
      }

      const rows = await read(key, []);
      rows.sort((a, b) =>
        (Number(b.rebirths) || 0) - (Number(a.rebirths) || 0)
      );

      return respond(200, rows.slice(0, 500));
    }

    if (event.httpMethod !== "POST") {
      return respond(405, { error: "Method not allowed" });
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return respond(400, { error: "Invalid JSON" });
    }

    const name = clean(body.name);
    const nameKey = norm(name);

    if (!name) return respond(400, { error: "Name required" });

    const names = await read(namesKey, {});

    if (body.action === "register") {
      if (names[nameKey]) {
        return respond(409, { error: "Name already registered" });
      }

      names[nameKey] = name;
      await save(namesKey, names);
      return respond(201, { ok: true });
    }

    const rows = await read(key, []);
    const record = {
      name,
      rebirths: Math.max(0, Number(body.rebirths) || 0),
      bestFriend: body.bestFriend ?? null,
      totalIncome: Math.max(0, Number(body.totalIncome) || 0),
      playtimeSeconds: Math.max(0, Number(body.playtimeSeconds) || 0),
      updatedAt: Date.now()
    };

    const index = rows.findIndex((r) => norm(r.name) === nameKey);

    if (index >= 0) rows[index] = record;
    else rows.push(record);

    await save(key, rows);
    return respond(200, { ok: true });
  } catch (error) {
    console.error("Leaderboard error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error" })
    };
  }
};
