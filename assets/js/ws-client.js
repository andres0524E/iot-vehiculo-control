import { config } from "./config.js";

export class WsClient {
  constructor(on_status_change, on_event_received, on_reconnect = null) {
    this.on_status_change = on_status_change;
    this.on_event_received = on_event_received;
    this.on_reconnect = on_reconnect;
    this.socket = null;
    this.reconnect_timer = null;
    this.manual_close = false;
    this.intentos_reconexion = 0;
    this.tuvo_conexion_previa = false;
    this.id_vehiculo_actual = config.id_vehiculo;
    this._fn_get_auth_params = null;
  }

  establecer_proveedor_auth(fn_params) {
    this._fn_get_auth_params = typeof fn_params === "function" ? fn_params : null;
  }

  esta_conectado() {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  _construir_url_ws(id_vehiculo) {
    const base = `${config.ws_base_url}${config.endpoints.ws_vehiculo(id_vehiculo)}`;
    const params = new URLSearchParams();
    if (this._fn_get_auth_params) {
      const auth = this._fn_get_auth_params() || {};
      if (auth.token && !String(auth.token).startsWith("jwt_local_")) {
        params.set("token", auth.token);
      }
      if (auth.guest_token) {
        params.set("guest_token", auth.guest_token);
      }
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  conectar(id_vehiculo = config.id_vehiculo) {
    const nuevo_id = Number(id_vehiculo);
    if (this.socket && this.id_vehiculo_actual !== nuevo_id) {
      this.desconectar();
    }

    this.id_vehiculo_actual = nuevo_id;
    this.manual_close = false;
    this._limpiar_timer();

    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const ws_url = this._construir_url_ws(nuevo_id);
    const etiqueta = this.tuvo_conexion_previa ? "Reconectando" : "Conectando";
    this.on_status_change("connecting", etiqueta);

    try {
      this.socket = new WebSocket(ws_url);

      this.socket.onopen = () => {
        const es_reconexion = this.tuvo_conexion_previa;
        this.tuvo_conexion_previa = true;
        this.intentos_reconexion = 0;
        this.on_status_change("online", "En línea");
        if (es_reconexion && typeof this.on_reconnect === "function") {
          this.on_reconnect();
        }
      };

      this.socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload && typeof payload === "object") {
            this.on_event_received(payload);
          }
        } catch (_err) {
          // ignora tramas malformadas sin romper la interfaz
        }
      };

      this.socket.onerror = () => {
        this.on_status_change("offline", "Desconectado");
      };

      this.socket.onclose = (ev) => {
        this.socket = null;
        if (ev && (ev.code === 4401 || ev.code === 4403 || ev.code === 4003 || ev.code === 4008)) {
          this.manual_close = true;
          this.on_status_change("offline", ev.code === 4008 ? "Prueba finalizada" : "Acceso denegado");
          return;
        }
        this.on_status_change("offline", "Desconectado");
        if (!this.manual_close) {
          this._programar_reconexion();
        }
      };
    } catch (_error) {
      this.socket = null;
      this.on_status_change("offline", "Desconectado");
      if (!this.manual_close) {
        this._programar_reconexion();
      }
    }
  }

  _programar_reconexion() {
    this._limpiar_timer();
    const base = config.ws_reconnect_delay_ms || 2000;
    const max_delay = config.ws_reconnect_max_delay_ms || 15000;
    const espera_ms = Math.min(base * Math.pow(2, this.intentos_reconexion), max_delay);
    this.intentos_reconexion += 1;

    this.reconnect_timer = setTimeout(() => {
      this.on_status_change("connecting", "Reconectando");
      this.conectar(this.id_vehiculo_actual);
    }, espera_ms);
  }

  _limpiar_timer() {
    if (this.reconnect_timer) {
      clearTimeout(this.reconnect_timer);
      this.reconnect_timer = null;
    }
  }

  desconectar() {
    this.manual_close = true;
    this._limpiar_timer();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}
