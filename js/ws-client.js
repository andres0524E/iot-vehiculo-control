import { config } from "./config.js";

export class WsClient {
  constructor(on_status_change, on_event_received) {
    this.on_status_change = on_status_change;
    this.on_event_received = on_event_received;
    this.socket = null;
    this.reconnect_timer = null;
    this.manual_close = false;
  }

  conectar(id_vehiculo = config.id_vehiculo) {
    this.manual_close = false;
    this._limpiar_timer();

    const ws_url = `${config.ws_base_url}${config.endpoints.ws_vehiculo(id_vehiculo)}`;
    this.on_status_change("connecting", "Conectando / Reconectando");

    try {
      this.socket = new WebSocket(ws_url);

      this.socket.onopen = () => {
        this.on_status_change("online", "En línea");
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
        this.on_status_change("offline", "Desconectado");
        if (!this.manual_close) {
          this.reconnect_timer = setTimeout(() => {
            this.on_status_change("connecting", "Reconectando");
            this.conectar(id_vehiculo);
          }, config.ws_reconnect_delay_ms);
        }
      };
    } catch (_error) {
      this.on_status_change("offline", "Desconectado");
    }
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
    }
  }
}