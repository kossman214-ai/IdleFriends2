import { connectLambda, getStore } from "@netlify/blobs";

export const handler = async (event) => {
  try {
    connectLambda(event);

    const store = getStore({ name: "idle-friends-2-shared" });
    const KEY = "online-players-v1";

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
      const players =
        (await store.get(KEY, { type: "json" })) ?? {};

      const now = Date.now();
      const online = Object.values(players).filter(
        player => now - player.lastSeen < 60000
      );

      return respond(200, online);
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

    const name = String(body.name ?? "").trim().slice(0, 24);

    if (!name) {
      return respond(400, { error: "Name required" });
    }

    const players =
      (await store.get(KEY, { type: "json" })) ?? {};

    const playerKey = name.toLowerCase();

    players[playerKey] = {
      name,
      lastSeen: Date.now()
    };

    for (const [key, player] of Object.entries(players)) {
      if (Date.now() - player.lastSeen >= 60000) {
        delete players[key];
      }
    }

    await store.setJSON(KEY, players);

    return respond(200, { ok: true });
  } catch (error) {
    console.error("Presence error:", error);

    return respond(500, { error: "Server error" });
  }
};
