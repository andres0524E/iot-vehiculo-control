export const config = {
  api_base_url: "https://3.214.170.24.nip.io",
  ws_base_url: "wss://3.214.170.24.nip.io",
  id_vehiculo: 1,
  origen_control: "WEB-CONTROL",
  http_timeout_ms: 6000,
  health_poll_interval_ms: 15000,
  ws_reconnect_delay_ms: 2000,
  ws_reconnect_max_delay_ms: 15000,
  max_historial_rows: 10,
  historial_resync_debounce_ms: 300,
  endpoints: {
    salud: "/",
    vehiculo: (id) => `/vehiculos/${id}`,
    comandos: (id) => `/vehiculos/${id}/comandos`,
    estado: (id) => `/vehiculos/${id}/estado`,
    historial: (id) => `/vehiculos/${id}/historial`,
    movimientos: "/movimientos",
    demos: (id) => `/vehiculos/${id}/demos`,
    ejecutar_demo: "/demos/ejecutar",
    cancelar_demo: (id) => `/demos/${id}/cancelar`,
    ws_vehiculo: (id) => `/ws/vehiculos/${id}`
  }
};
