// Connectivity gate. All external calls go through netFetch so that the
// "simulate offline" switch and real outages behave identically.

export class OfflineError extends Error {
  constructor(msg = "No internet connectivity") {
    super(msg);
    this.name = "OfflineError";
  }
}

let forcedOffline = false;
let lastCheck = { at: 0, online: false };

export const net = {
  get forcedOffline() {
    return forcedOffline;
  },
  setForcedOffline(v: boolean) {
    forcedOffline = v;
    lastCheck = { at: 0, online: false };
  },
  async isOnline(): Promise<boolean> {
    if (forcedOffline) return false;
    if (Date.now() - lastCheck.at < 20_000) return lastCheck.online;
    let online = false;
    try {
      const r = await fetch("https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=wind_speed_10m", {
        signal: AbortSignal.timeout(4000),
      });
      online = r.ok;
    } catch {
      online = false;
    }
    lastCheck = { at: Date.now(), online };
    return online;
  },
  markResult(ok: boolean) {
    lastCheck = { at: Date.now(), online: ok };
  },
};

export async function netFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  if (forcedOffline) throw new OfflineError("Offline mode is active (simulated loss of connectivity)");
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 60_000) });
    net.markResult(true);
    return res;
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError") throw new Error(`Request timed out: ${new URL(url).host}`);
    net.markResult(false);
    throw new OfflineError(`Network unreachable (${new URL(url).host}): ${err.message}`);
  }
}
