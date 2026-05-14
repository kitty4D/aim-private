// AIM — Realtime abstraction. Two backends:
//   - "pulse": polls /api/pulse (lightweight Netlify Blobs lookup), fires
//     per-room callbacks when their SHA changes. Default. Works on free
//     Netlify tier.
//   - "sse":   subscribes to an Edge Functions SSE stream (planned). Falls
//     back to pulse if EventSource fails.
//
// Both implementations share the same surface so call sites don't change
// when the server flips REALTIME_MODE.

import { Client } from "./client.js";

const FALLBACK_REFRESH_MS = 60_000;

class PulseBackend {
  constructor(config, listeners, globalListeners) {
    this.config = config;
    this.listeners = listeners;
    this.globalListeners = globalListeners;
    this.lastSha = {};
    this.timer = null;
    this.fallbackTimer = null;
  }

  async start() {
    await this._tick();
    const interval = Math.max(1500, this.config.poll_interval_ms || 5000);
    this.timer = setInterval(() => this._tick(), interval);
    this.fallbackTimer = setInterval(() => this._fallback(), FALLBACK_REFRESH_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
  }

  async _tick() {
    try {
      const pulse = await Client.pulse();
      const rooms = pulse.rooms || {};
      for (const room of Object.keys(this.listeners)) {
        const sha = rooms[room]?.sha ?? null;
        if (sha && sha !== this.lastSha[room]) {
          const prev = this.lastSha[room];
          this.lastSha[room] = sha;
          if (prev !== undefined) this.listeners[room]({ room, sha, reason: "pulse" });
          else this.listeners[room]({ room, sha, reason: "initial" });
        } else if (this.lastSha[room] === undefined) {
          this.lastSha[room] = sha;
        }
      }
      for (const cb of this.globalListeners) {
        try { cb(pulse); } catch (e) { console.warn("[aim/realtime] global listener error:", e); }
      }
    } catch (e) {
      console.warn("[aim/realtime] pulse poll failed:", e.message);
    }
  }

  /** Force-fire a tick now (e.g. from a manual refresh button). */
  refresh() {
    return this._tick();
  }

  async _fallback() {
    for (const room of Object.keys(this.listeners)) {
      this.listeners[room]({ room, sha: this.lastSha[room], reason: "fallback" });
    }
  }
}

class SseBackend {
  constructor(config, listeners, globalListeners) {
    this.config = config;
    this.listeners = listeners;
    this.globalListeners = globalListeners;
    this.source = null;
    this.fallback = null;
  }

  async start() {
    const supportsSSE = typeof EventSource !== "undefined";
    if (!supportsSSE) {
      console.warn("[aim/realtime] EventSource unavailable, falling back to pulse");
      return this._fallbackToPulse();
    }
    try {
      const url = this.config.endpoint || "/api/events";
      this.source = new EventSource(url);
      this.source.addEventListener("pulse", (ev) => {
        const data = JSON.parse(ev.data);
        const cb = this.listeners[data.room];
        if (cb) cb({ room: data.room, sha: data.sha, reason: "sse" });
      });
      this.source.onerror = () => {
        console.warn("[aim/realtime] SSE error, falling back to pulse");
        this.source?.close();
        this._fallbackToPulse();
      };
    } catch (e) {
      console.warn("[aim/realtime] SSE init failed, falling back to pulse:", e.message);
      this._fallbackToPulse();
    }
  }

  _fallbackToPulse() {
    if (this.fallback) return;
    const fb = this.config.fallback || { mode: "pulse", endpoint: "/api/pulse", poll_interval_ms: 10000 };
    this.fallback = new PulseBackend(fb, this.listeners, this.globalListeners);
    this.fallback.start();
  }

  stop() {
    this.source?.close();
    this.fallback?.stop();
  }

  /** SSE has no manual tick; delegate to the pulse fallback if available. */
  refresh() {
    if (this.fallback) return this.fallback.refresh();
    return Promise.resolve();
  }
}

export const Realtime = {
  backend: null,
  listeners: {},
  globalListeners: [],

  async init(config) {
    if (this.backend) this.backend.stop();
    const mode = (config && config.mode) || "pulse";
    if (mode === "sse") this.backend = new SseBackend(config, this.listeners, this.globalListeners);
    else this.backend = new PulseBackend(config, this.listeners, this.globalListeners);
    await this.backend.start();
  },

  subscribe(room, callback) {
    this.listeners[room] = callback;
  },

  unsubscribe(room) {
    delete this.listeners[room];
  },

  subscribeGlobal(callback) {
    this.globalListeners.push(callback);
  },

  stop() {
    if (this.backend) this.backend.stop();
    this.listeners = {};
    this.globalListeners = [];
  },

  /** Force-fire a fresh pulse poll right now (used by the UI refresh button). */
  refresh() {
    if (this.backend && typeof this.backend.refresh === "function") {
      return this.backend.refresh();
    }
    return Promise.resolve();
  },
};
