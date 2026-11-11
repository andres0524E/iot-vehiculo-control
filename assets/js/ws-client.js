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
  }

  esta_conectado() {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  conectar(id_vehiculo = config.id_vehiculo) {
    this.id_vehiculo_actual = id_vehiculo;
    this.manual_close = false;
    this._limpiar_timer();

    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const ws_url = `${config.ws_base_url}${config.endpoints.ws_vehiculo(id_vehiculo)}`;
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

      this.socket.onclose = () => {
        this.socket = null;
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
