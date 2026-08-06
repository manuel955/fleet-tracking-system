// Configuracion publica del proveedor de mapas. El token se inyecta en
// window.__MAPBOX_ACCESS_TOKEN__ durante el despliegue; nunca se versiona un
// token real en este archivo.
window.DASHBOARD_MAP_CONFIG = Object.freeze({
  accessToken: window.__MAPBOX_ACCESS_TOKEN__ || '',
  style: window.__MAPBOX_STYLE_URI__ || 'mapbox://styles/mapbox/standard',
});
