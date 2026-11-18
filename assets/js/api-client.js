import { config } from "./config.js";

export class ApiClient {
  constructor() {
    this.base_url = config.api_base_url;
    this.timeout_ms = config.http_timeout_ms;
    this._fn_get_token = null;
    this._fn_get_guest_token = null;
  }

  establecer_proveedor_auth(fn_token, fn_guest_token = null) {
    this._fn_get_token = typeof fn_token === "function" ? fn_token : null;
    this._fn_get_guest_token = typeof fn_guest_token === "function" ? fn_guest_token : null;
  }

  _construir_headers_auth(headers_extra = {}) {
    const out = { ...headers_extra };
    const token = this._fn_get_token ? this._fn_get_token() : "";
    const guest_token = this._fn_get_guest_token ? this._fn_get_guest_token() : "";

    if (token && !out.Authorization) {
      out.Authorization = `Bearer ${token}`;
    }
    if (guest_token && !out["X-Guest-Token"]) {
      out["X-Guest-Token"] = guest_token;
    }
    return out;
  }

  async _request(endpoint, options = {}, timeout_override_ms = null) {
    const controller = new AbortController();
    const limite_ms = timeout_override_ms || this.timeout_ms;
    const timer = setTimeout(() => controller.abort(), limite_ms);

    const url = `${this.base_url}${endpoint}`;
    const headers = this._construir_headers_auth({
      "Accept": "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    });

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
        err.data = data;
        err.is_db_error = msg.toLowerCase().includes("error db") || msg.toLowerCase().includes("pymysql");
        if (response.status === 401 && headers.Authorization && !endpoint.startsWith("/auth/login")) {
          window.dispatchEvent(new CustomEvent("iot:auth-expired", { detail: { endpoint, detail: msg } }));
        }
        throw err;
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeout_err = new Error("tiempo de espera agotado hacia aws ec2");
        timeout_err.status = 408;
        timeout_err.is_timeout = true;
        throw timeout_err;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async get(endpoint, timeout_ms = null) {
    return await this._request(endpoint, { method: "GET", cache: "no-store" }, timeout_ms);
  }

  async post(endpoint, body = null, timeout_ms = null) {
    return await this._request(
      endpoint,
      {
        method: "POST",
        ...(body !== null && body !== undefined ? { body: JSON.stringify(body) } : {})
      },
      timeout_ms
    );
  }

  async put(endpoint, body = null, timeout_ms = null) {
    return await this._request(
      endpoint,
      {
        method: "PUT",
        ...(body !== null && body !== undefined ? { body: JSON.stringify(body) } : {})
      },
      timeout_ms
    );
  }

  async patch(endpoint, body = null, timeout_ms = null) {
    return await this._request(
      endpoint,
      {
        method: "PATCH",
        ...(body !== null && body !== undefined ? { body: JSON.stringify(body) } : {})
      },
      timeout_ms
    );
  }

  async del(endpoint, timeout_ms = null) {
    return await this._request(endpoint, { method: "DELETE" }, timeout_ms);
  }

  async verificar_salud_api(timeout_ms = 5000) {
    return await this._request(config.endpoints.salud, { method: "GET", cache: "no-store" }, timeout_ms);
  }

  async obtener_vehiculo(id_vehiculo = config.id_vehiculo) {
    return await this._request(config.endpoints.vehiculo(id_vehiculo), { method: "GET", cache: "no-store" });
  }

  async obtener_comandos(id_vehiculo = config.id_vehiculo) {
    return await this._request(config.endpoints.comandos(id_vehiculo), { method: "GET", cache: "no-store" });
  }

  async obtener_estado(id_vehiculo = config.id_vehiculo) {
    return await this._request(config.endpoints.estado(id_vehiculo), { method: "GET", cache: "no-store" });
  }

  async obtener_historial(id_vehiculo = config.id_vehiculo) {
    return await this._request(config.endpoints.historial(id_vehiculo), { method: "GET", cache: "no-store" });
  }

  async obtener_demos(id_vehiculo = config.id_vehiculo) {
    return await this._request(config.endpoints.demos(id_vehiculo), { method: "GET", cache: "no-store" });
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
