// AIM — REST API client wrapper

const TOKEN_KEY = "aim.token";

export const Client = {
  getToken() {
    return localStorage.getItem(TOKEN_KEY);
  },
  setToken(t) {
    localStorage.setItem(TOKEN_KEY, t);
  },
  clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  },

  async req(path, opts = {}) {
    const headers = {
      "content-type": "application/json",
      ...(opts.headers || {}),
    };
    const token = this.getToken();
    if (token) headers["authorization"] = `Bearer ${token}`;
    const res = await fetch(path, { ...opts, headers });
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = body.error || JSON.stringify(body);
      } catch {
        detail = await res.text();
      }
      const err = new Error(`HTTP ${res.status}: ${detail}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return await res.json();
  },

  me() {
    return this.req("/api/me");
  },
  rooms() {
    return this.req("/api/rooms");
  },
  createRoom(name, topic) {
    const body = topic ? { name, topic } : { name };
    return this.req("/api/rooms", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  readRoom(room, { since, limit = 50 } = {}) {
    const params = new URLSearchParams({ room, limit: String(limit) });
    if (since) params.set("since", since);
    return this.req("/api/messages?" + params.toString());
  },
  send(room, text, client_id) {
    return this.req("/api/messages", {
      method: "POST",
      body: JSON.stringify({ room, text, client_id }),
    });
  },
  editMessage(path, text) {
    const params = new URLSearchParams({ path });
    return this.req("/api/messages?" + params.toString(), {
      method: "PATCH",
      body: JSON.stringify({ text }),
    });
  },
  deleteMessage(path) {
    const params = new URLSearchParams({ path });
    return this.req("/api/messages?" + params.toString(), { method: "DELETE" });
  },
  listPins(room) {
    return this.req("/api/pins?room=" + encodeURIComponent(room));
  },
  pin(room, sha) {
    return this.req("/api/pins", {
      method: "POST",
      body: JSON.stringify({ room, sha }),
    });
  },
  unpin(room, sha) {
    const params = new URLSearchParams({ room, sha });
    return this.req("/api/pins?" + params.toString(), { method: "DELETE" });
  },
  search(query, room) {
    const params = new URLSearchParams({ q: query });
    if (room) params.set("room", room);
    return this.req("/api/search?" + params.toString());
  },
  pulse(room) {
    const path = room ? "/api/pulse?room=" + encodeURIComponent(room) : "/api/pulse";
    return this.req(path);
  },
  heartbeat(status) {
    return this.req("/api/presence", {
      method: "POST",
      body: JSON.stringify({ status }),
    });
  },
  online() {
    return this.req("/api/presence");
  },
  clearPresence() {
    return this.req("/api/presence", { method: "DELETE" });
  },
  getTopic(room) {
    return this.req("/api/topic?room=" + encodeURIComponent(room));
  },
  setTopic(room, content) {
    return this.req("/api/topic?room=" + encodeURIComponent(room), {
      method: "PUT",
      body: JSON.stringify({ content }),
    });
  },

  // Admin operations — requires an admin-role token (or X-Admin-Secret, but
  // the UI uses Bearer auth via the signed-in user's token).
  adminListTokens() {
    return this.req("/api/admin/tokens");
  },
  adminCreateToken(name, role) {
    return this.req("/api/admin/tokens", {
      method: "POST",
      body: JSON.stringify({ name, role }),
    });
  },
  adminRevokeToken(token) {
    return this.req("/api/admin/tokens?token=" + encodeURIComponent(token), {
      method: "DELETE",
    });
  },
  adminRevokeByName(name) {
    return this.req("/api/admin/tokens?name=" + encodeURIComponent(name), {
      method: "DELETE",
    });
  },
};
