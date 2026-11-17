import { useEffect } from 'react';
import { API_BASE } from '../lib/apiClient';

// Each mount owns a cumulative counter; switching panels flushes the old one.
export function useAdminActivity(panel: string) {
  useEffect(() => {
    const sessionId = crypto.randomUUID();
    let lastInteraction = Date.now();
    let previous = Date.now();
    let wasActive = document.visibilityState === 'visible' && document.hasFocus();
    const totals = new Map<string, number>();
    const interact = () => { sample(); lastInteraction = Date.now(); };
    const sample = () => {
      const now = Date.now();
      if (wasActive) {
        // Discard suspended browser time and stop at the idle threshold.
        const elapsed = Math.max(0, Math.min(now, lastInteraction + 120000) - Math.max(previous, now - 15000));
        const creditedEnd = Math.min(now, lastInteraction + 120000);
        let cursor = creditedEnd - elapsed;
        while (cursor < creditedEnd) {
          const date = new Date(cursor);
          const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
          const end = Math.min(creditedEnd, midnight);
          totals.set(day, (totals.get(day) || 0) + (end - cursor) / 1000);
          cursor = end;
        }
      }
      previous = now;
      wasActive = document.visibilityState === 'visible' && document.hasFocus();
    };
    const flush = () => {
      for (const [day, seconds] of totals) {
        if (!seconds) continue;
        void fetch(`${API_BASE}/api/metrics/admin-activity`, {
          method: 'POST', credentials: 'include', keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, panel, activity_date: day, seconds }),
        }).catch(() => { /* Retry the cumulative total at the next flush. */ });
      }
    };
    const boundary = () => { sample(); flush(); };
    const events = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart'];
    events.forEach(event => window.addEventListener(event, interact, { passive: true }));
    window.addEventListener('blur', boundary);
    window.addEventListener('focus', boundary);
    window.addEventListener('pagehide', boundary);
    document.addEventListener('visibilitychange', boundary);
    const timer = window.setInterval(sample, 5000);
    const saveTimer = window.setInterval(flush, 30000);
    return () => {
      boundary();
      window.clearInterval(timer);
      window.clearInterval(saveTimer);
      events.forEach(event => window.removeEventListener(event, interact));
      window.removeEventListener('blur', boundary);
      window.removeEventListener('focus', boundary);
      window.removeEventListener('pagehide', boundary);
      document.removeEventListener('visibilitychange', boundary);
    };
  }, [panel]);
}
