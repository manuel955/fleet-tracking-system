// Alertas de operación en tiempo real. Firebase RTDB entrega el evento al
// dashboard sin introducir otro servidor de sockets ni duplicar el canal GPS.
(function () {
  let alertsCache = {};
  let initialized = false;
  let subscribed = false;
  let alertsRef = null;
  let vpsTimer = null;

  function escape(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function formatDate(value) {
    if (!value) return '-';
    return new Date(Number(value)).toLocaleString('es-PE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  function reasonLabel(alert) {
    if (alert.reasonLabel) return alert.reasonLabel;
    if (alert.reason === 'HEARTBEAT') return 'Pérdida de señal / heartbeat';
    if (alert.reason === 'ADMIN') return 'Desconexión administrativa';
    return 'Desconexión manual';
  }

  function sortedAlerts() {
    return Object.entries(alertsCache)
      .map(([id, alert]) => ({ id, ...(alert || {}) }))
      .filter((alert) => alert.driverId)
      .sort((a, b) => Number(b.disconnectedAt || b.createdAt || 0) - Number(a.disconnectedAt || a.createdAt || 0));
  }

  function openAlertsPanel() {
    const panel = document.getElementById('operation-alerts-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
  }

  function closeAlertsPanel() {
    const panel = document.getElementById('operation-alerts-panel');
    if (!panel) return;
    panel.classList.add('hidden');
    panel.setAttribute('aria-hidden', 'true');
  }

  function renderPanel() {
    const list = document.getElementById('operation-alerts-list');
    const badge = document.getElementById('operation-alerts-badge');
    const button = document.getElementById('operation-alerts-button');
    const openAlerts = sortedAlerts().filter((alert) => alert.status !== 'CLOSED');
    if (badge) {
      badge.textContent = String(openAlerts.length);
      badge.classList.toggle('hidden', openAlerts.length === 0);
    }
    if (button) button.classList.toggle('has-alerts', openAlerts.length > 0);
    if (!list) return;
    list.innerHTML = openAlerts.length
      ? openAlerts.slice(0, 12).map((alert) => `
        <article class="operation-alert-card">
          <div class="operation-alert-card-title"><span>⚠️</span><strong>Desconexión de conductor</strong><time>${escape(formatDate(alert.disconnectedAt))}</time></div>
          <p>Chofer <b>${escape(alert.driverName || alert.driverId)}</b> (${escape(alert.driverPlate || '-')}) se desconectó a las ${escape(formatDate(alert.disconnectedAt).slice(-5))}.</p>
          <small class="operation-alert-source">Apartado: Conductores → Alertas de desconexión</small>
          <small>Motivo: ${escape(reasonLabel(alert))}</small>
          <div class="operation-alert-actions">
            ${alert.driverPhone ? `<button type="button" data-operation-action="call" data-phone="${escape(alert.driverPhone)}">Llamar</button><button type="button" data-operation-action="notify" data-phone="${escape(alert.driverPhone)}">Notificar</button>` : ''}
            <button type="button" data-operation-action="alerts">Ver en alertas</button>
            <button type="button" data-operation-action="location" data-alert-id="${escape(alert.id)}">Ver ubicación final</button>
            <button type="button" data-operation-action="acknowledge" data-alert-id="${escape(alert.id)}">Reconocer</button>
          </div>
        </article>
      `).join('')
      : '<p class="operation-alerts-empty">No hay desconexiones abiertas.</p>';
  }

  function playAlertSound() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 760;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.32);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.34);
      oscillator.addEventListener('ended', () => context.close());
    } catch (_) {
      // Chrome puede bloquear audio hasta que el administrador interactue.
    }
  }

  function showToast(alert) {
    const region = document.getElementById('operation-alert-toast-region');
    if (!region) return;
    const toast = document.createElement('article');
    toast.className = 'operation-alert-toast';
    toast.innerHTML = `<div><strong>⚠️ Desconexión de conductor</strong><button type="button" aria-label="Cerrar">×</button></div><p>Chofer <b>${escape(alert.driverName || alert.driverId)}</b> (${escape(alert.driverPlate || '-')}) se desconectó a las ${escape(formatDate(alert.disconnectedAt).slice(-5))}. Motivo: ${escape(reasonLabel(alert))}.</p><small class="operation-alert-source">Apartado: Conductores → Alertas de desconexión</small>`;
    toast.querySelector('button').addEventListener('click', () => toast.remove());
    toast.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      openAlertsPanel();
    });
    region.appendChild(toast);
    setTimeout(() => toast.remove(), 12000);
  }

  function handleSnapshot(snapshot) {
    const next = snapshot.val() || {};
    const newAlerts = initialized
      ? Object.entries(next).filter(([id, alert]) => !alertsCache[id] && alert)
      : [];
    alertsCache = next;
    window.operationAlertsForHistory = () => sortedAlerts();
    renderPanel();
    newAlerts.forEach(([, alert]) => {
      showToast(alert);
      playAlertSound();
    });
    initialized = true;
  }

  async function refreshVpsAlerts() {
    if (!window.vpsApiBaseUrl || !auth.currentUser) return;
    if (window.latestVpsDashboardSnapshot) {
      handleSnapshot({ val: () => window.latestVpsDashboardSnapshot.operationAlerts || {} });
      return;
    }
    try {
      const token = await auth.currentUser.getIdToken();
      const response = await fetch(`${String(window.vpsApiBaseUrl).replace(/\/$/, '')}/api/v1/dashboard/overview`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return;
      handleSnapshot({ val: () => result.operationAlerts || {} });
    } catch (_) {
      // The dashboard keeps the last known alert list during a short outage.
    }
  }

  async function acknowledgeAlert(alertId, button) {
    if (!alertId || !auth.currentUser) return;
    button.disabled = true;
    try {
      const token = await auth.currentUser.getIdToken();
      const endpoint = window.vpsApiBaseUrl
        ? `${String(window.vpsApiBaseUrl).replace(/\/$/, '')}/api/v1/dashboard/alerts/${encodeURIComponent(alertId)}`
        : 'https://us-central1-rastreoflota-53052.cloudfunctions.net/manageOperationAlert';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(window.vpsApiBaseUrl
          ? { action: 'acknowledge' }
          : { action: 'acknowledge', alertId }),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || result.message || 'No se pudo reconocer la alerta.');
      alertsCache[alertId] = { ...(alertsCache[alertId] || {}), status: 'CLOSED', acknowledged: true };
      renderPanel();
    } catch (error) {
      button.disabled = false;
      window.alert(error.message || 'No se pudo reconocer la alerta.');
    }
  }

  function subscribe() {
    if (alertsRef) alertsRef.off();
    if (vpsTimer) {
      clearInterval(vpsTimer);
      vpsTimer = null;
    }
    alertsCache = {};
    initialized = false;
    if (!window.dashboardIsAdmin) {
      renderPanel();
      return;
    }
    if (window.vpsApiBaseUrl) {
      refreshVpsAlerts();
      vpsTimer = setInterval(refreshVpsAlerts, 5000);
      return;
    }
    alertsRef = db.ref('prematureDisconnectAlerts').orderByChild('createdAt').limitToLast(50);
    alertsRef.on('value', handleSnapshot);
  }

  function handleAction(event) {
    const button = event.target.closest('[data-operation-action]');
    if (!button) return;
    const action = button.getAttribute('data-operation-action');
    if (action === 'call') {
      window.location.href = `tel:${button.getAttribute('data-phone') || ''}`;
      return;
    }
    if (action === 'notify') {
      const phone = (button.getAttribute('data-phone') || '').replace(/\D/g, '');
      if (phone) window.open(`https://wa.me/${phone}`, '_blank', 'noopener');
      return;
    }
    if (action === 'alerts') {
      if (typeof window.openDriversAdminFilter === 'function') window.openDriversAdminFilter('alerts');
      return;
    }
    if (action === 'location') {
      const alert = alertsCache[button.getAttribute('data-alert-id')];
      if (!alert) return;
      if (typeof openDashboardView === 'function') openDashboardView('map');
      if (typeof map !== 'undefined' && map && alert.finalLat != null && alert.finalLng != null) {
        const finalPosition = { lat: Number(alert.finalLat), lng: Number(alert.finalLng) };
        if (typeof map.setView === 'function') map.setView(finalPosition, 15);
        else { map.setCenter(finalPosition); map.setZoom(15); }
      }
      if (typeof selectDriver === 'function' && alert.driverId) selectDriver(alert.driverId);
      return;
    }
    if (action === 'acknowledge') {
      acknowledgeAlert(button.getAttribute('data-alert-id'), button);
    }
  }

  window.operationAlertsForHistory = () => sortedAlerts();
  window.startOperationAlerts = subscribe;
  document.getElementById('operation-alerts-button')?.addEventListener('click', () => {
    const panel = document.getElementById('operation-alerts-panel');
    if (panel?.classList.contains('hidden')) openAlertsPanel();
    else closeAlertsPanel();
  });
  document.getElementById('operation-alerts-close')?.addEventListener('click', closeAlertsPanel);
  document.addEventListener('click', handleAction);

  auth.onAuthStateChanged((user) => {
    if (!user) {
      if (alertsRef) alertsRef.off();
      if (vpsTimer) clearInterval(vpsTimer);
      vpsTimer = null;
      alertsRef = null;
      alertsCache = {};
      renderPanel();
      return;
    }
    // El rol admin puede llegar unos instantes despues de la autenticacion.
    // Reintentar permite suscribirse cuando initializeDashboardAdmin actualiza
    // el token con el custom claim dashboardAdmin.
    subscribe();
    setTimeout(subscribe, 1200);
  });
})();
