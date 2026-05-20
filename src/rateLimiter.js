'use strict';

/**
 * RateLimiter – fixed 1-minute window, max 5 accepted requests per user_id.
 *
 * Why fixed window?
 *   Simpler, perfectly correct for the stated "1-minute" semantics,
 *   and clearly documented (see README).
 *
 * Concurrency safety:
 *   Node.js is single-threaded (event loop). All state mutations are
 *   synchronous, so there are no races between concurrent async requests.
 *   No additional locking is required.
 */

const WINDOW_MS   = 60_000; // 1 minute
const MAX_ACCEPTS = 5;

class RateLimiter {
  constructor() {
    /**
     * Map<userId, { windowStart: number, accepted: number, rejected: number }>
     * rejected is cumulative (across all windows) – see README.
     */
    this._users = new Map();
  }

  /**
   * Try to accept a request for userId.
   * Returns { allowed: boolean, accepted: number, rejected: number, windowStart: number }
   */
  check(userId) {
    const now = Date.now();
    let record = this._users.get(userId);

    if (!record) {
      record = { windowStart: now, accepted: 0, rejected: 0 };
      this._users.set(userId, record);
    }

    // Rotate window if expired
    if (now - record.windowStart >= WINDOW_MS) {
      record.windowStart = now;
      record.accepted    = 0;
      // rejected is intentionally NOT reset – it is cumulative
    }

    if (record.accepted < MAX_ACCEPTS) {
      record.accepted += 1;
      return { allowed: true, accepted: record.accepted, rejected: record.rejected, windowStart: record.windowStart };
    } else {
      record.rejected += 1;
      return { allowed: false, accepted: record.accepted, rejected: record.rejected, windowStart: record.windowStart };
    }
  }

  /**
   * Returns per-user stats snapshot.
   * For users whose window has expired we still report their cumulative rejected count
   * and 0 accepted in the current window.
   */
  stats() {
    const now    = Date.now();
    const result = {};

    for (const [userId, record] of this._users.entries()) {
      const windowExpired  = now - record.windowStart >= WINDOW_MS;
      const acceptedNow    = windowExpired ? 0 : record.accepted;
      const windowStartISO = new Date(windowExpired ? now : record.windowStart).toISOString();
      const windowEndsISO  = new Date((windowExpired ? now : record.windowStart) + WINDOW_MS).toISOString();

      result[userId] = {
        accepted_current_window: acceptedNow,
        rejected_cumulative:     record.rejected,
        window_start:            windowStartISO,
        window_ends:             windowEndsISO,
        limit:                   MAX_ACCEPTS,
      };
    }

    return result;
  }
}

module.exports = new RateLimiter(); // singleton
