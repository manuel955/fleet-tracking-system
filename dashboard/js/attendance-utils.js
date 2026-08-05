(function attachAttendanceUtils(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AttendanceUtils = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createAttendanceUtils() {
  function isQaRecord(driverId, driverName) {
    const id = String(driverId || '').trim();
    const name = String(driverName || '').trim();
    return /^qa[_-]/i.test(id) || /^qa\s+(auto|suv)\b/i.test(name);
  }

  function buildSessions(history = {}, drivers = {}) {
    return Object.entries(history || {}).flatMap(([driverId, events]) => {
      const driver = drivers[driverId] || {};
      const sorted = Object.values(events || {})
        .filter((event) => event && Number.isFinite(Number(event.at)))
        .sort((a, b) => Number(a.at) - Number(b.at));
      const sessions = [];
      let open = null;

      sorted.forEach((event) => {
        const at = Number(event.at);
        if (event.status === 'online') {
          // Repeated online events are heartbeat/status refreshes, not new turns.
          if (!open) {
            open = {
              driverId,
              driverName: event.driverName || driver.name || driverId,
              startAt: at,
              endAt: null,
              active: true,
            };
          }
          return;
        }
        if (event.status === 'offline' && open) {
          open.endAt = at;
          open.active = false;
          sessions.push(open);
          open = null;
        }
      });

      if (open) {
        const driverOnline = driver.status === 'online' || driver.status === 'busy';
        if (!driverOnline && driver.lastUpdate) open.endAt = Number(driver.lastUpdate);
        open.active = !open.endAt && driverOnline;
        sessions.push(open);
      }

      return sessions.filter((session) => !isQaRecord(session.driverId, session.driverName));
    });
  }

  return { isQaRecord, buildSessions };
}));
