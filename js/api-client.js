import { config } from "./config.js";

export class ApiClient {
  constructor() {
    this.base_url = config.api_base_url;
    this.timeout_ms = config.http_timeout_ms;
  }

  async _request(endpoint, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout_ms);

    const url = `${this.base_url}${endpoint}`;
    const headers = {
      "Accept": "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    };

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal
      });

      let data = null;
      const content_type = response.headers.get("content-type") || "";
      if (content_type.includes("application/json")) {
        data = await response.json();
      } else {
        const text = await response.text();
        data = { detail: text };
      }

      if (!response.ok) {
        const msg = (data && data.detail) ? String(data.detail) : `error http ${response.status}`;
        const err = new Error(msg);
        err.status = response.status;
        err.is_db_error = msg.toLowerCase().includes("error db") || msg.toLowerCase().includes("pymysql");
        throw err;
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeout_err = new Error("tiempo de espera agotado hacia aws ec2");
        timeout_err.status = 408;
        throw timeout_err;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async verificar_salud_api() {
    return await this._request(config.endpoints.salud, { method: "GET" });
  }

  async obtener_vehiculo(id_vehiculo = config.id_vehiculo) {
    return await this._request(config.endpoints.vehiculo(id_vehiculo), { method: "GET" });
  }

  async obtener_comandos(id_vehiculo = config.id_vehiculo) {
    return await this._request(config.endpoints.comandos(id_vehiculo), { method: "GET" });
  }

  async obtener_demos(id_vehiculo = config.id_vehiculo) {
    return await this._request(config.endpoints.demos(id_vehiculo), { method: "GET" });
  }

  async enviar_movimiento(id_comando, id_vehiculo = config.id_vehiculo) {
    const payload = {
      id_vehiculo: Number(id_vehiculo),
      id_comando: Number(id_comando),
      origen: config.origen_control
    };
    return await this._request(config.endpoints.movimientos, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async iniciar_demo(id_demo, id_vehiculo = config.id_vehiculo) {
    const payload = {
      id_vehiculo: Number(id_vehiculo),
      id_demo: Number(id_demo)
    };
    return await this._request(config.endpoints.ejecutar_demo, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async cancelar_demo(id_vehiculo = config.id_vehiculo) {
    return await this._request(config.endpoints.cancelar_demo(id_vehiculo), {
      method: "POST"
    });
  }
}