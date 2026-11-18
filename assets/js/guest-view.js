import { config } from "./config.js";
import { mostrar_notificacion } from "./toast.js";

function esc(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizar_url_imagen(url, nombre = "") {
  const txt = String(url ?? "").trim();
  if (
    txt.startsWith("./assets/img/") ||
    txt.startsWith("assets/img/") ||
    txt.startsWith("/") ||
    txt.startsWith("https://")
  ) {
    return txt;
  }
  return nombre.toLowerCase().includes("rover")
    ? "./assets/img/rover.svg"
    : "./assets/img/excavadora.svg";
}

const CATALOGO_RESPALDO_LOCAL = [
  {
    id_modelo: 1,
    nombre_comercial: "Excavator 3000",
    descripcion:
      "Oruga articulada todo terreno con brazo hidráulico IoT, iluminación LED dual y telemetría WSS.",
    tipo_microcontrolador: "ESP8266",
    imagen_url: "./assets/img/excavadora.svg",
    id_vehiculo_exhibicion: 1,
    nombre_unidad_exhibicion: "Excavator 3000",
    exhibicion_disponible: true,
    comandos_invitado: [
      { codigo: 1, nombre: "Avanzar" },
      { codigo: 2, nombre: "Retroceder" },
      { codigo: 3, nombre: "Izquierda" },
      { codigo: 4, nombre: "Derecha" },
      { codigo: 8, nombre: "Sonido" },
      { codigo: 9, nombre: "Detener" }
    ]
  },
  {
    id_modelo: 2,
    nombre_comercial: "Rover Explorador V2",
    descripcion:
      "Chasis modular de reconocimiento con dirección diferencial de precisión y sensores ambientales.",
    tipo_microcontrolador: "ESP32-S3",
    imagen_url: "./assets/img/rover.svg",
    id_vehiculo_exhibicion: null,
    nombre_unidad_exhibicion: null,
    exhibicion_disponible: false,
    comandos_invitado: [
      { codigo: 1, nombre: "Avanzar" },
      { codigo: 2, nombre: "Retroceder" },
      { codigo: 9, nombre: "Detener" }
    ]
  }
];

export class GuestViewController {
  constructor(api_client, auth_session, cmd_controller, ui_manager, callbacks = {}) {
    this.api = api_client;
    this.auth = auth_session;
    this.cmd_ctrl = cmd_controller;
    this.ui = ui_manager;
    this.on_prueba_cambio = callbacks.on_prueba_cambio || null;

    this.modelos = [];
    this.duracion_prueba_minutos = 10;
    this.sesion_activa = false;
    this.id_sesion_activa = null;
    this.id_vehiculo_prueba = null;
    this.codigos_permitidos = null;
    this.fecha_expiracion_ms = 0;
    this.segundos_restantes = 0;
    this.timer_interval = null;
    this.alias_invitado = "Cliente Visitante";
    this.modo_local_fallback = false;
    this.mostrando_catalogo = false;
    this._finalizando = false;
  }

  iniciar() {
    this._vincular_eventos();
    if (this.auth?.obtener_rol() === "invitado") {
      this.sincronizar_catalogo();
    } else {
      this.renderizar_catalogo();
    }
  }

  _vincular_eventos() {
    document.getElementById("btn-iniciar-prueba-invitado")?.addEventListener("click", () => {
      this.solicitar_prueba(null, null);
    });

    document.getElementById("btn-barra-iniciar-prueba")?.addEventListener("click", () => {
      this.solicitar_prueba(null, null);
    });

    document.getElementById("btn-toggle-catalogo-invitado")?.addEventListener("click", () => {
      this.alternar_catalogo();
    });

    document.getElementById("btn-cancelar-prueba-invitado")?.addEventListener("click", () => {
      this.finalizar_prueba(true);
    });

    window.addEventListener("iot:auth-change", () => {
      const rol = this.auth?.obtener_rol();
      if (rol === "invitado") {
        this.sincronizar_catalogo();
      } else {
        this.alternar_catalogo(false);
        if (this.sesion_activa) {
          this.limpiar_sesion_local();
        }
      }
    });
  }

  alternar_catalogo(forzar = null) {
    if (this.auth?.obtener_rol() !== "invitado") {
      this.mostrando_catalogo = false;
    } else {
      this.mostrando_catalogo = typeof forzar === "boolean" ? forzar : !this.mostrando_catalogo;
    }

    const sec_cat = document.getElementById("seccion-catalogo-invitado");
    const btn_toggle = document.getElementById("btn-toggle-catalogo-invitado");
    if (sec_cat) {
      sec_cat.classList.toggle("d-none", !this.mostrando_catalogo);
    }
    document.body.classList.toggle("guest-browsing", this.mostrando_catalogo);

    if (btn_toggle) {
      btn_toggle.innerHTML = this.mostrando_catalogo
        ? '<i class="bi bi-controller" aria-hidden="true"></i> <span>Volver al Control</span>'
        : '<i class="bi bi-grid-1x2" aria-hidden="true"></i> <span>Catálogo</span>';
    }
  }

  async sincronizar_catalogo() {
    try {
      const resp = await this.api.get(config.endpoints.invitado_catalogo);
      if (Array.isArray(resp?.modelos) && resp.modelos.length > 0) {
        this.modelos = resp.modelos;
      } else {
        this.modelos = CATALOGO_RESPALDO_LOCAL;
      }
    } catch (err) {
      if (this.modelos.length === 0 || !err.status || err.status === 404 || err.is_network_error) {
        this.modelos = CATALOGO_RESPALDO_LOCAL;
      }
    }
    this.duracion_prueba_minutos = 10;
    this.renderizar_catalogo();
  }

  renderizar_catalogo() {
    const grid = document.getElementById("guest-catalog-grid");
    const btn_fallback = document.getElementById("btn-iniciar-prueba-invitado");
    if (btn_fallback) {
      btn_fallback.disabled = this.sesion_activa;
    }
    if (!grid) return;

    const lista = this.modelos.length > 0 ? this.modelos : CATALOGO_RESPALDO_LOCAL;
    grid.innerHTML = lista
      .map((m) => {
        const img = sanitizar_url_imagen(m.imagen_url, m.nombre_comercial);
        const tiene_unidad = Boolean(m.id_vehiculo_exhibicion);
        const disponible = Boolean(m.exhibicion_disponible && tiene_unidad);
        const cmds = Array.isArray(m.comandos_invitado) ? m.comandos_invitado : [];
        const badges_cmd =
          cmds.length > 0
            ? cmds
                .map((c) => `<span class="badge bg-dark border border-secondary text-light me-1 mb-1">${esc(c.nombre)}</span>`)
                .join("")
            : `<span class="badge bg-dark border border-secondary text-secondary">Controles básicos</span>`;

        let estado_badge = `<span class="badge bg-secondary">Solo catálogo</span>`;
        if (tiene_unidad && disponible) {
          estado_badge = `<span class="badge bg-success">Exhibición disponible</span>`;
        } else if (tiene_unidad && !disponible) {
          estado_badge = `<span class="badge bg-warning text-dark">Ocupada en prueba</span>`;
        }

        const btn_disabled = this.sesion_activa || !disponible ? "disabled" : "";
        const btn_texto = this.sesion_activa
          ? "Prueba en curso"
          : disponible
          ? `Probar ${this.duracion_prueba_minutos} min`
          : tiene_unidad
          ? "Unidad ocupada"
          : "Próximamente";

        return `
          <div class="col-12 col-md-6">
            <div class="guest-catalog-card h-100 d-flex flex-column justify-content-between p-2 rounded border border-secondary bg-black bg-opacity-50">
              <div>
                <div class="d-flex align-items-center gap-2 mb-2">
                  <img
                    src="${esc(img)}"
                    alt="${esc(m.nombre_comercial)}"
                    class="guest-catalog-thumb rounded border border-secondary bg-dark p-1"
                    width="72"
                    height="52"
                  />
                  <div class="min-w-0 flex-grow-1">
                    <div class="fw-bold text-warning small text-truncate">${esc(m.nombre_comercial)}</div>
                    <div class="text-secondary" style="font-size: 0.72rem;">MCU: ${esc(m.tipo_microcontrolador || "ESP32")}</div>
                    <div class="mt-1">${estado_badge}</div>
                  </div>
                </div>
                <p class="small text-light opacity-75 mb-2" style="font-size: 0.78rem;">
                  ${esc(m.descripcion || "Vehículo IoT de demostración comercial.")}
                </p>
                <div class="mb-2">
                  <div class="text-secondary mb-1" style="font-size: 0.68rem;">Comandos habilitados para prueba:</div>
                  <div class="d-flex flex-wrap">${badges_cmd}</div>
                </div>
              </div>
              <div class="d-flex align-items-center justify-content-between gap-2 pt-2 border-top border-secondary border-opacity-50">
                <span class="text-info text-truncate" style="font-size: 0.72rem;">
                  ${tiene_unidad ? esc(m.nombre_unidad_exhibicion || `Unidad #${m.id_vehiculo_exhibicion}`) : "Sin exhibición asignada"}
                </span>
                <button
                  type="button"
                  class="btn btn-sm btn-warning fw-bold flex-shrink-0 btn-iniciar-prueba-modelo"
                  data-id-modelo="${esc(m.id_modelo)}"
                  data-id-vehiculo="${esc(m.id_vehiculo_exhibicion ?? "")}"
                  ${btn_disabled}
                >
                  <i class="bi bi-stopwatch"></i> ${esc(btn_texto)}
                </button>
              </div>
            </div>
          </div>`;
      })
      .join("");

    grid.querySelectorAll(".btn-iniciar-prueba-modelo").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id_m = Number(btn.dataset.idModelo) || null;
        const id_v = Number(btn.dataset.idVehiculo) || null;
        this.solicitar_prueba(id_m, id_v);
      });
    });
  }

  async solicitar_prueba(id_modelo = null, id_vehiculo = null) {
    if (this.sesion_activa) {
      mostrar_notificacion("Ya tienes una sesión de prueba activa en curso.", "warning");
      return;
    }

    const input_alias = document.getElementById("input-alias-invitado");
    const alias = input_alias?.value.trim() || "Cliente Visitante";
    this.alias_invitado = alias;

    const lista = this.modelos.length > 0 ? this.modelos : CATALOGO_RESPALDO_LOCAL;
    const seleccionado =
      lista.find((m) => id_modelo && Number(m.id_modelo) === Number(id_modelo)) ||
      lista.find((m) => m.exhibicion_disponible && m.id_vehiculo_exhibicion) ||
      lista[0];

    const payload = {
      alias_cliente: alias,
      id_modelo: id_modelo ? Number(id_modelo) : seleccionado?.id_modelo || 1,
      id_vehiculo: id_vehiculo
        ? Number(id_vehiculo)
        : seleccionado?.id_vehiculo_exhibicion || 1
    };

    let resp = null;
    try {
      resp = await this.api.post(config.endpoints.invitado_solicitar_prueba, payload);
      this.modo_local_fallback = false;
    } catch (err) {
      const es_endpoint_inexistente =
        !err.status ||
        err.status === 0 ||
        err.is_network_error ||
        (err.status === 404 && String(err.message || "").trim() === "Not Found");

      if (!es_endpoint_inexistente) {
        const tipo = err.status === 409 ? "warning" : "danger";
        mostrar_notificacion(
          err.message || "No se pudo reservar la unidad de exhibición.",
          tipo,
          5200
        );
        if (err.status === 409) {
          this.sincronizar_catalogo();
        }
        return;
      }

      // Respaldo local únicamente si el servidor actual aún es versión 4.2 sin rutas /invitado/*
      this.modo_local_fallback = true;
      const dur_seg = Number(this.duracion_prueba_minutos || 10) * 60;
      resp = {
        id_sesion: Date.now(),
        id_vehiculo: payload.id_vehiculo,
        nombre_vehiculo: seleccionado?.nombre_unidad_exhibicion || "Excavator 3000",
        nombre_comercial: seleccionado?.nombre_comercial || "Excavator 3000",
        token_sesion: null,
        duracion_segundos: dur_seg,
        fecha_expiracion: new Date(Date.now() + dur_seg * 1000).toISOString(),
        codigos_permitidos: [1, 2, 3, 4, 8, 9]
      };
    }

    if (resp.token_sesion && this.auth?.establecer_guest_token) {
      this.auth.establecer_guest_token(resp.token_sesion);
    }

    this.id_sesion_activa = resp.id_sesion || null;
    this.id_vehiculo_prueba = Number(resp.id_vehiculo || payload.id_vehiculo || 1);
    this.codigos_permitidos = Array.isArray(resp.codigos_permitidos)
      ? resp.codigos_permitidos
      : [1, 2, 3, 4, 8, 9];

    const dur_ms = Number(this.duracion_prueba_minutos * 60) * 1000;
    this.fecha_expiracion_ms = Date.now() + dur_ms;
    this.sesion_activa = true;

    this.alternar_catalogo(false);
    document.getElementById("barra-modo-invitado")?.classList.add("d-none");
    document.body.classList.add("has-guest-trial");

    const banner = document.getElementById("banner-prueba-invitado");
    const texto_alias = document.getElementById("texto-alias-invitado-activo");
    if (banner) banner.classList.remove("d-none");
    if (texto_alias) {
      const unidad_txt = resp.nombre_vehiculo ? ` (${resp.nombre_vehiculo})` : "";
      texto_alias.textContent = `${this.alias_invitado}${unidad_txt}`;
    }

    if (this.timer_interval) clearInterval(this.timer_interval);
    this._actualizar_reloj();
    this.timer_interval = setInterval(() => {
      this._actualizar_reloj();
      if (this.segundos_restantes <= 0) {
        this.finalizar_prueba(false);
      }
    }, 1000);

    this.renderizar_catalogo();

    await this.on_prueba_cambio?.({
      activa: true,
      id_vehiculo: this.id_vehiculo_prueba,
      codigos_permitidos: this.codigos_permitidos,
      sesion: resp
    });

    const sufijo = this.modo_local_fallback ? " (modo local)" : "";
    mostrar_notificacion(
      `Prueba iniciada para ${this.alias_invitado}${sufijo}: ${this.duracion_prueba_minutos} min de control exclusivo.`,
      "success",
      4800
    );
  }

  _actualizar_reloj() {
    const reloj = document.getElementById("reloj-prueba-invitado");
    const restantes = Math.max(0, Math.ceil((this.fecha_expiracion_ms - Date.now()) / 1000));
    this.segundos_restantes = restantes;
    if (!reloj) return;
    const min = Math.floor(restantes / 60);
    const seg = restantes % 60;
    reloj.textContent = `${String(min).padStart(2, "0")}:${String(seg).padStart(2, "0")}`;
    reloj.classList.toggle("text-danger", restantes <= 30);
    reloj.classList.toggle("text-warning", restantes > 30);
  }

  async finalizar_prueba(manual = false) {
    if (!this.sesion_activa || this._finalizando) return;
    this._finalizando = true;

    if (this.timer_interval) {
      clearInterval(this.timer_interval);
      this.timer_interval = null;
    }

    const sesion_id = this.id_sesion_activa;
    const fue_local = this.modo_local_fallback;

    try {
      if (!fue_local && sesion_id) {
        try {
          await this.api.post(config.endpoints.invitado_finalizar_prueba(sesion_id), {});
        } catch (_err) {
          // El backend pudo expirar la sesión segundos antes y ya emitió DETENER
        }
      } else {
        try {
          await this.cmd_ctrl.ejecutar_detener_prioritario("fin de prueba invitado");
        } catch (_err) {
          // Ignora fallo de parada en modo local offline
        }
      }
    } finally {
      this._resetear_estado_visual();
      if (this.auth?.establecer_guest_token) {
        this.auth.establecer_guest_token(null);
      }

      await this.on_prueba_cambio?.({
        activa: false,
        id_vehiculo: null,
        codigos_permitidos: null,
        sesion: null
      });

      this.sincronizar_catalogo();
      this._finalizando = false;

      mostrar_notificacion(
        manual
          ? "Prueba de exhibición finalizada. Unidad detenida y reserva liberada."
          : "Tiempo límite expirado: unidad detenida automáticamente por seguridad y reserva liberada.",
        manual ? "info" : "warning",
        5200
      );
    }
  }

  limpiar_sesion_local() {
    if (this.timer_interval) {
      clearInterval(this.timer_interval);
      this.timer_interval = null;
    }
    this._resetear_estado_visual();
    if (this.auth?.establecer_guest_token) {
      this.auth.establecer_guest_token(null);
    }
    this.renderizar_catalogo();
  }

  _resetear_estado_visual() {
    this.sesion_activa = false;
    this.id_sesion_activa = null;
    this.id_vehiculo_prueba = null;
    this.codigos_permitidos = null;
    this.fecha_expiracion_ms = 0;
    this.segundos_restantes = 0;
    this.modo_local_fallback = false;

    document.body.classList.remove("has-guest-trial");
    this.alternar_catalogo(false);

    const banner = document.getElementById("banner-prueba-invitado");
    if (banner) banner.classList.add("d-none");

    const barra_invitado = document.getElementById("barra-modo-invitado");
    if (barra_invitado) {
      barra_invitado.classList.toggle("d-none", this.auth?.obtener_rol() !== "invitado");
    }

    const reloj = document.getElementById("reloj-prueba-invitado");
    if (reloj) {
      reloj.textContent = "10:00";
      reloj.classList.remove("text-danger");
    }
  }
}

export { GuestViewController as GuestViewManager };
