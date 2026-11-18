import { config } from "./config.js";
import { formatear_fecha_hora } from "./format-utils.js";
import { mostrar_notificacion } from "./toast.js";

const STORAGE_FLOTA_KEY = "iot_flota_estado_v5";

function esc(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ESTADO_FLOTA_SEMILLA = {
  modelos: [
    {
      id_modelo: 1,
      nombre_comercial: "Excavator 3000",
      tipo_microcontrolador: "ESP8266",
      descripcion: "Orugas, brazo hidráulico articulado, bocina y LED.",
      imagen_url: "./assets/img/excavadora.svg",
      activo: 1
    },
    {
      id_modelo: 2,
      nombre_comercial: "Rover Explorador X1",
      tipo_microcontrolador: "ESP32",
      descripcion: "Tracción diferencial 4x4 y telemetría ultrasónica.",
      imagen_url: "./assets/img/rover.svg",
      activo: 1
    }
  ],
  unidades: [
    {
      id_vehiculo: 1,
      id_modelo: 1,
      nombre: "Excavator 3000",
      numero_serie: "SN-EXCAV-001",
      nombre_comercial: "Excavator 3000",
      microcontrolador: "ESP8266",
      estado_inventario: "exhibicion",
      id_propietario: null,
      nombre_propietario: null,
      soporte_activo: false
    },
    {
      id_vehiculo: 2,
      id_modelo: 1,
      nombre: "Excavator 3000 #02",
      numero_serie: "SN-EXCAV-002",
      nombre_comercial: "Excavator 3000",
      microcontrolador: "ESP8266",
      estado_inventario: "vendido",
      id_propietario: 2,
      nombre_propietario: "Ing. Carlos Mendoza (Comprador)",
      soporte_activo: false
    }
  ],
  demos_fabrica: [
    {
      id_demo: 1,
      id_vehiculo: 1,
      nombre: "Exhibición Oficial de Planta",
      descripcion: "Secuencia demostrativa estándar de fábrica",
      es_fabrica: 1,
      nombre_vehiculo: "Excavator 3000",
      pasos: [
        { orden: 1, id_comando: 1, duracion_ms: 1000 },
        { orden: 2, id_comando: 10, duracion_ms: 600 },
        { orden: 3, id_comando: 9, duracion_ms: 400 }
      ]
    }
  ],
  demos_privadas: []
};

export class AdminViewController {
  constructor(api_client, auth_session, callbacks = {}) {
    this.api = api_client;
    this.auth = auth_session;
    this.on_navegar_a_unidad = callbacks.on_navegar_a_unidad || null;
    this.on_abrir_editor_demo = callbacks.on_abrir_editor_demo || null;
    this.on_ejecutar_demo = callbacks.on_ejecutar_demo || null;

    this.subvista_actual = "inventario";
    this.en_linea_admin = false;
    this.filtro_unidades_q = "";
    this.filtro_unidades_estado = "";
    this.filtro_auditoria_q = "";

    const estado_guardado = this._cargar_estado_local();
    this.modelos = estado_guardado.modelos;
    this.unidades = estado_guardado.unidades;
    this.demos_fabrica = estado_guardado.demos_fabrica;
    this.demos_privadas = estado_guardado.demos_privadas;

    this.clientes = this.auth?.obtener_usuarios_registrados() || [];
    this.auditoria = this.auth?.obtener_auditoria_local() || [];
    this.mis_vehiculos = [];
    this.mis_demos = [];
    this.pasos_fabrica_tmp = [];
  }

  _cargar_estado_local() {
    try {
      const raw = localStorage.getItem(STORAGE_FLOTA_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.modelos) && Array.isArray(parsed.unidades)) {
          return {
            modelos: parsed.modelos,
            unidades: parsed.unidades,
            demos_fabrica: Array.isArray(parsed.demos_fabrica) ? parsed.demos_fabrica : [],
            demos_privadas: Array.isArray(parsed.demos_privadas) ? parsed.demos_privadas : []
          };
        }
      }
    } catch (_e) {}

    const copia = JSON.parse(JSON.stringify(ESTADO_FLOTA_SEMILLA));
    this._guardar_estado_local(copia);
    return copia;
  }

  _guardar_estado_local(custom = null) {
    const data = custom || {
      modelos: this.modelos,
      unidades: this.unidades,
      demos_fabrica: this.demos_fabrica,
      demos_privadas: this.demos_privadas
    };
    try {
      localStorage.setItem(STORAGE_FLOTA_KEY, JSON.stringify(data));
    } catch (_e) {}
  }

  guardar_demo_privada_local({ id_demo_editar = "", id_vehiculo, nombre, descripcion, pasos }) {
    const usuario = this.auth?.obtener_usuario() || {};
    const id_usuario = Number(usuario.id_usuario || 2);
    const estado = this._cargar_estado_local();
    this.demos_privadas = estado.demos_privadas;

    if (id_demo_editar) {
      const idx = this.demos_privadas.findIndex(
        (d) => Number(d.id_demo) === Number(id_demo_editar)
      );
      if (idx !== -1) {
        this.demos_privadas[idx] = {
          ...this.demos_privadas[idx],
          nombre,
          descripcion,
          pasos
        };
      }
      this.auth?.registrar_evento_auditoria("EDITAR_DEMO_PRIVADA", "DEMO", Number(id_demo_editar), {
        nombre,
        pasos: pasos.length
      });
    } else {
      const ids_actuales = [
        ...estado.demos_fabrica.map((d) => Number(d.id_demo) || 0),
        ...this.demos_privadas.map((d) => Number(d.id_demo) || 0)
      ];
      const nuevo_id = (ids_actuales.length > 0 ? Math.max(0, ...ids_actuales) : 0) + 1;
      this.demos_privadas.push({
        id_demo: nuevo_id,
        id_vehiculo: Number(id_vehiculo || 1),
        id_usuario,
        nombre,
        descripcion,
        es_fabrica: 0,
        pasos
      });
      this.demos_privadas.sort((a, b) => Number(a.id_demo) - Number(b.id_demo));
      this.auth?.registrar_evento_auditoria("CREAR_DEMO_PRIVADA", "DEMO", nuevo_id, {
        nombre,
        id_vehiculo,
        pasos: pasos.length
      });
    }

    this._guardar_estado_local();
  }

  obtener_demos_locales_unidad(id_vehiculo) {
    const estado = this._cargar_estado_local();
    const rol = this.auth?.obtener_rol() || "invitado";
    const uid = Number(this.auth?.obtener_usuario()?.id_usuario || 0);
    const fab = estado.demos_fabrica.filter(
      (d) => !d.id_vehiculo || Number(d.id_vehiculo) === Number(id_vehiculo)
    );
    if (rol === "invitado") {
      return [...fab].sort((a, b) => Number(a.id_demo) - Number(b.id_demo));
    }
    const priv = estado.demos_privadas.filter(
      (d) =>
        Number(d.id_vehiculo) === Number(id_vehiculo) &&
        (rol === "admin" || Number(d.id_usuario) === uid)
    );
    return [...fab, ...priv].sort((a, b) => Number(a.id_demo) - Number(b.id_demo));
  }

  iniciar() {
    document.querySelectorAll("[data-admin-tab]").forEach((btn) => {
      btn.addEventListener("click", () => this.cambiar_subvista(btn.dataset.adminTab));
    });

    document.getElementById("form-crear-modelo")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this._crear_modelo();
    });

    document.getElementById("form-crear-unidad")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this._crear_unidad();
    });

    document.getElementById("form-crear-cliente")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this._crear_cliente();
    });

    document.getElementById("form-asignar-unidad")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this._asignar_unidad();
    });

    document.getElementById("btn-revocar-asignacion")?.addEventListener("click", () => {
      this._revocar_asignacion_seleccionada();
    });

    document.getElementById("filter-unidades-q")?.addEventListener("input", (e) => {
      this.filtro_unidades_q = e.target.value.trim().toLowerCase();
      this._renderizar_tabla_unidades();
    });

    document.getElementById("filter-unidades-estado")?.addEventListener("change", (e) => {
      this.filtro_unidades_estado = e.target.value;
      this._renderizar_tabla_unidades();
    });

    document.getElementById("filter-auditoria-q")?.addEventListener("input", (e) => {
      this.filtro_auditoria_q = e.target.value.trim().toLowerCase();
      this._renderizar_tabla_auditoria();
    });

    document.getElementById("btn-fab-agregar-paso")?.addEventListener("click", () => {
      this.pasos_fabrica_tmp.push({ id_comando: 1, duracion_ms: 900 });
      this._renderizar_pasos_fabrica();
    });

    document.getElementById("form-crear-demo-fabrica")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this._crear_demo_fabrica();
    });

    document.getElementById("btn-comprador-abrir-editor")?.addEventListener("click", () => {
      this.on_abrir_editor_demo?.(null);
    });

    window.addEventListener("iot:auth-change", () => {
      this.sincronizar_desde_backend();
    });

    window.addEventListener("iot:users-updated", () => {
      if (!this.en_linea_admin) {
        this.clientes = this.auth?.obtener_usuarios_registrados() || [];
        this.auditoria = this.auth?.obtener_auditoria_local() || [];
        this.renderizar_todo();
      }
    });

    this.pasos_fabrica_tmp = [
      { id_comando: 1, duracion_ms: 800 },
      { id_comando: 2, duracion_ms: 800 },
      { id_comando: 3, duracion_ms: 800 }
    ];
    this._renderizar_pasos_fabrica();
    this.sincronizar_desde_backend();
  }

  cambiar_subvista(tab) {
    this.subvista_actual = tab;
    document.querySelectorAll("[data-admin-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.adminTab === tab);
    });
    document.querySelectorAll(".admin-subpanel").forEach((panel) => {
      panel.classList.toggle("d-none", panel.id !== `admin-panel-${tab}`);
    });
  }

  _actualizar_badge_sync(en_linea, texto = null) {
    this.en_linea_admin = en_linea;
    const badge = document.getElementById("admin-api-sync-badge");
    if (!badge) return;
    if (en_linea) {
      badge.className = "badge bg-success";
      badge.textContent = texto || "Sincronizado AWS RDS";
    } else {
      badge.className = "badge bg-info text-dark";
      badge.textContent = texto || "Persistencia Local Activa";
    }
  }

  async sincronizar_desde_backend() {
    const estado_local = this._cargar_estado_local();
    this.modelos = estado_local.modelos;
    this.unidades = estado_local.unidades;
    this.demos_fabrica = estado_local.demos_fabrica;
    this.demos_privadas = estado_local.demos_privadas;
    this.clientes = this.auth?.obtener_usuarios_registrados() || [];
    this.auditoria = this.auth?.obtener_auditoria_local() || [];

    const rol = this.auth?.obtener_rol() || "invitado";
    if (rol === "invitado") return;

    if (rol === "usuario") {
      await this._cargar_panel_comprador();
      return;
    }

    if (!this.auth?.es_modo_backend_jwt()) {
      this._actualizar_badge_sync(false, "Persistencia Local RBAC");
      this._actualizar_selector_vehiculos_admin();
      this.renderizar_todo();
      return;
    }

    try {
      const [dash, mods, unids, clis, demosFab, audit] = await Promise.all([
        this.api.get(config.endpoints.admin_dashboard),
        this.api.get(`${config.endpoints.admin_modelos}?limit=100`),
        this.api.get(`${config.endpoints.admin_unidades}?limit=100`),
        this.api.get(`${config.endpoints.admin_clientes}?limit=100`),
        this.api.get(config.endpoints.admin_demos_fabrica),
        this.api.get(`${config.endpoints.admin_auditoria}?limit=50`)
      ]);

      this.modelos = mods?.items || [];
      this.unidades = unids?.items || [];
      this.clientes = clis?.items || [];
      this.demos_fabrica = demosFab?.items || [];
      this.auditoria = audit?.items || [];

      this._actualizar_badge_sync(true);
      this._actualizar_selector_vehiculos_admin();
      this._renderizar_kpis_desde_dashboard(dash);
      this.renderizar_todo({ omitir_kpis: true });
    } catch (err) {
      this._actualizar_badge_sync(false, `Respaldo local (${err?.status || "red"})`);
      this._actualizar_selector_vehiculos_admin();
      this.renderizar_todo();
    }
  }

  _actualizar_selector_vehiculos_admin() {
    const sel = document.getElementById("select-mis-vehiculos");
    if (!sel) return;
    const operables = this.unidades.filter(
      (u) =>
        u.estado_inventario !== "inactivo" &&
        (u.estado_inventario !== "vendido" || Boolean(u.soporte_activo))
    );
    if (operables.length === 0) {
      sel.innerHTML = `<option value="1">Excavator 3000 (SN-EXCAV-001)</option>`;
      return;
    }
    sel.innerHTML = operables
      .map(
        (v) =>
          `<option value="${v.id_vehiculo}">${esc(v.nombre)} (${esc(v.numero_serie || `#${v.id_vehiculo}`)} · ${esc(v.estado_inventario.toUpperCase())})</option>`
      )
      .join("");
    if (operables.some((v) => Number(v.id_vehiculo) === Number(config.id_vehiculo))) {
      sel.value = String(config.id_vehiculo);
    }
  }

  _renderizar_kpis_desde_dashboard(dash) {
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(v ?? 0);
    };
    set("kpi-modelos", dash?.total_modelos);
    set("kpi-unidades", dash?.total_unidades);
    set("kpi-vendidas", dash?.unidades_vendidas);
    set("kpi-exhibicion", dash?.unidades_exhibicion);
    set("kpi-clientes", dash?.total_clientes);
    set("kpi-demos", dash?.demos_fabrica);
  }

  renderizar_todo(opciones = {}) {
    const rol = this.auth?.obtener_rol() || "invitado";
    const panel_empresa = document.getElementById("admin-mode-empresa");
    const panel_comprador = document.getElementById("admin-mode-comprador");

    if (panel_empresa && panel_comprador) {
      if (rol === "usuario") {
        panel_empresa.hidden = true;
        panel_comprador.hidden = false;
        this._renderizar_panel_comprador();
        return;
      }
      panel_empresa.hidden = false;
      panel_comprador.hidden = true;
    }

    if (!opciones.omitir_kpis) {
      this._renderizar_kpis_locales();
    }
    this._renderizar_tabla_modelos();
    this._renderizar_tabla_unidades();
    this._renderizar_tabla_clientes();
    this._renderizar_selectores_asignacion();
    this._renderizar_demos_fabrica();
    this._renderizar_tabla_auditoria();
  }

  _renderizar_kpis_locales() {
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(v);
    };
    set("kpi-modelos", this.modelos.filter((m) => Boolean(m.activo ?? 1)).length);
    set("kpi-unidades", this.unidades.length);
    set("kpi-vendidas", this.unidades.filter((u) => u.estado_inventario === "vendido").length);
    set("kpi-exhibicion", this.unidades.filter((u) => u.estado_inventario === "exhibicion").length);
    set("kpi-clientes", this.clientes.filter((c) => Boolean(c.activo ?? 1)).length);
    set("kpi-demos", this.demos_fabrica.length);
  }

  _renderizar_tabla_modelos() {
    const tbody = document.getElementById("tabla-modelos-body");
    const select_modelo = document.getElementById("select-unidad-modelo");
    if (select_modelo) {
      select_modelo.innerHTML = this.modelos
        .filter((m) => Boolean(m.activo ?? 1))
        .map(
          (m) =>
            `<option value="${m.id_modelo}">${esc(m.nombre_comercial)} (${esc(m.tipo_microcontrolador)})</option>`
        )
        .join("");
    }
    if (!tbody) return;

    if (this.modelos.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center text-secondary py-3">Sin modelos registrados</td></tr>`;
      return;
    }

    tbody.innerHTML = this.modelos
      .map((m) => {
        const activo = Boolean(m.activo ?? 1);
        return `
        <tr>
          <td class="text-warning font-monospace">#${m.id_modelo}</td>
          <td class="fw-bold">${esc(m.nombre_comercial)}</td>
          <td><span class="badge bg-secondary font-monospace">${esc(m.tipo_microcontrolador)}</span></td>
          <td class="d-none d-md-table-cell small text-light opacity-75">${esc(m.descripcion || "Sin descripción")}</td>
          <td><span class="badge ${activo ? "bg-success" : "bg-danger"}">${activo ? "Activo" : "Inactivo"}</span></td>
          <td class="text-end">
            <div class="admin-action-group">
              <button type="button" class="btn btn-sm btn-outline-warning py-0 px-2 btn-edit-modelo" data-id="${m.id_modelo}" title="Editar modelo">
                <i class="bi bi-pencil"></i>
              </button>
              <button type="button" class="btn btn-sm btn-outline-info py-0 px-2 btn-caps-modelo" data-id="${m.id_modelo}" title="Capacidades de comandos">
                <i class="bi bi-cpu"></i>
              </button>
              <button type="button" class="btn btn-sm btn-outline-${activo ? "danger" : "success"} py-0 px-2 btn-toggle-modelo" data-id="${m.id_modelo}" title="${activo ? "Desactivar" : "Activar"}">
                <i class="bi bi-${activo ? "pause-circle" : "play-circle"}"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
      })
      .join("");

    tbody.querySelectorAll(".btn-edit-modelo").forEach((b) =>
      b.addEventListener("click", () => this._abrir_modal_editar_modelo(Number(b.dataset.id)))
    );
    tbody.querySelectorAll(".btn-caps-modelo").forEach((b) =>
      b.addEventListener("click", () => this._abrir_modal_capacidades_modelo(Number(b.dataset.id)))
    );
    tbody.querySelectorAll(".btn-toggle-modelo").forEach((b) =>
      b.addEventListener("click", () => this._alternar_estado_modelo(Number(b.dataset.id)))
    );
  }

  _renderizar_tabla_unidades() {
    const tbody = document.getElementById("tabla-unidades-body");
    if (!tbody) return;

    const filtradas = this.unidades.filter((u) => {
      const ok_estado =
        !this.filtro_unidades_estado || u.estado_inventario === this.filtro_unidades_estado;
      const texto = `${u.nombre} ${u.numero_serie} ${u.nombre_comercial || ""}`.toLowerCase();
      const ok_q = !this.filtro_unidades_q || texto.includes(this.filtro_unidades_q);
      return ok_estado && ok_q;
    });

    if (filtradas.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-secondary py-3">No hay unidades que coincidan con el filtro</td></tr>`;
      return;
    }

    const colores = {
      exhibicion: "bg-warning text-dark",
      vendido: "bg-success",
      disponible: "bg-info text-dark",
      mantenimiento: "bg-secondary",
      inactivo: "bg-danger"
    };

    tbody.innerHTML = filtradas
      .map((u) => {
        const dueno = u.nombre_propietario
          ? `<span class="text-success small d-block">${esc(u.nombre_propietario)}</span>${
              u.soporte_activo
                ? `<span class="badge bg-warning text-dark">Soporte autorizado</span>`
                : `<span class="badge bg-dark border border-secondary text-secondary"><i class="bi bi-lock-fill"></i> Privada</span>`
            }`
          : `<span class="text-secondary small">Empresa (Sin dueño)</span>`;

        return `
        <tr>
          <td class="text-info font-monospace">#${u.id_vehiculo}</td>
          <td class="fw-bold">${esc(u.nombre)}</td>
          <td><code class="text-warning">${esc(u.numero_serie || "N/A")}</code></td>
          <td class="d-none d-sm-table-cell small">${esc(u.nombre_comercial || u.modelo || "-")}</td>
          <td><span class="badge ${colores[u.estado_inventario] || "bg-secondary"}">${esc(String(u.estado_inventario || "").toUpperCase())}</span></td>
          <td>${dueno}</td>
          <td class="text-end">
            <div class="admin-action-group">
              <button type="button" class="btn btn-sm btn-outline-info py-0 px-2 btn-edit-unidad" data-id="${u.id_vehiculo}" title="Editar unidad">
                <i class="bi bi-pencil"></i>
              </button>
              <button type="button" class="btn btn-sm btn-outline-light py-0 px-2 btn-ctrl-unidad" data-id="${u.id_vehiculo}" title="Abrir en Control">
                <i class="bi bi-joystick"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
      })
      .join("");

    tbody.querySelectorAll(".btn-edit-unidad").forEach((b) =>
      b.addEventListener("click", () => this._abrir_modal_editar_unidad(Number(b.dataset.id)))
    );
    tbody.querySelectorAll(".btn-ctrl-unidad").forEach((b) =>
      b.addEventListener("click", () => {
        const id_v = Number(b.dataset.id);
        const u = this.unidades.find((x) => Number(x.id_vehiculo) === id_v);
        if (u && u.estado_inventario === "vendido" && !u.soporte_activo) {
          this.auth?.registrar_evento_auditoria("ACCESO_DENEGADO_SOPORTE", "VEHICULO", id_v, {
            motivo: "Intento de control Admin sobre unidad vendida sin soporte activo",
            propietario: u.nombre_propietario
          });
          this.auditoria = this.auth?.obtener_auditoria_local() || this.auditoria;
          this._renderizar_tabla_auditoria();
          mostrar_notificacion(
            `HTTP 403 Prohibido: '${u.nombre}' pertenece a ${u.nombre_propietario}. El comprador debe autorizar Soporte Técnico desde su sesión.`,
            "danger",
            5200
          );
          return;
        }
        this.on_navegar_a_unidad?.(id_v);
      })
    );
  }

  _renderizar_tabla_clientes() {
    const tbody = document.getElementById("tabla-clientes-body");
    if (!tbody) return;
    if (this.clientes.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center text-secondary py-3">Sin usuarios registrados</td></tr>`;
      return;
    }

    const badges_rol = {
      admin: `<span class="badge bg-warning text-dark"><i class="bi bi-shield-fill"></i> ADMIN</span>`,
      usuario: `<span class="badge bg-info text-dark"><i class="bi bi-person-badge-fill"></i> COMPRADOR</span>`,
      invitado: `<span class="badge bg-secondary"><i class="bi bi-person"></i> INVITADO</span>`
    };

    tbody.innerHTML = this.clientes
      .map((c) => {
        const activo = Boolean(c.activo ?? 1);
        const rol_key = c.rol || "usuario";
        const username_txt = c.username ? `@${c.username} · ` : "";
        return `
        <tr>
          <td class="text-warning font-monospace">#${c.id_usuario}</td>
          <td class="fw-bold">${esc(c.nombre_completo)}</td>
          <td>
            <span class="small text-secondary font-monospace">${esc(username_txt)}</span>
            <code class="text-warning">${esc(c.email)}</code>
          </td>
          <td>${badges_rol[rol_key] || badges_rol.usuario}</td>
          <td><span class="badge ${activo ? "bg-success" : "bg-danger"}">${activo ? "Activo" : "Inactivo"}</span></td>
          <td class="text-end">
            <div class="admin-action-group">
              <button type="button" class="btn btn-sm btn-outline-warning py-0 px-2 btn-edit-cliente" data-id="${c.id_usuario}" title="Editar usuario y contraseña">
                <i class="bi bi-pencil"></i>
              </button>
              <button type="button" class="btn btn-sm btn-outline-${activo ? "danger" : "success"} py-0 px-2 btn-toggle-cliente" data-id="${c.id_usuario}">
                ${activo ? "Desactivar" : "Reactivar"}
              </button>
            </div>
          </td>
        </tr>
      `;
      })
      .join("");

    tbody.querySelectorAll(".btn-edit-cliente").forEach((b) =>
      b.addEventListener("click", () => this._abrir_modal_editar_cliente(Number(b.dataset.id)))
    );
    tbody.querySelectorAll(".btn-toggle-cliente").forEach((b) =>
      b.addEventListener("click", () => this._alternar_estado_cliente(Number(b.dataset.id)))
    );
  }

  _abrir_modal_editar_cliente(id_usuario) {
    const c = this.clientes.find((x) => Number(x.id_usuario) === id_usuario);
    const body = document.getElementById("modal-admin-editar-body");
    const footer = document.getElementById("modal-admin-editar-footer");
    const titulo = document.getElementById("modalAdminEditarLabel");
    if (!c || !body || !footer || !titulo) return;

    const rol_actual = c.rol || "usuario";
    titulo.innerHTML = `<i class="bi bi-person-gear me-1"></i> Editar Usuario #${c.id_usuario}`;
    body.innerHTML = `
      <div class="mb-2">
        <label class="form-label">Nombre Completo</label>
        <input id="edit-cli-nombre" type="text" class="form-control form-control-sm" value="${esc(c.nombre_completo)}">
      </div>
      <div class="mb-2">
        <label class="form-label">Correo Electrónico (Login)</label>
        <input id="edit-cli-email" type="email" class="form-control form-control-sm font-monospace" value="${esc(c.email)}">
      </div>
      <div class="mb-2">
        <label class="form-label">Rol en el Sistema (RBAC)</label>
        <select id="edit-cli-rol" class="form-select form-select-sm">
          <option value="usuario" ${rol_actual === "usuario" ? "selected" : ""}>Usuario (Comprador)</option>
          <option value="admin" ${rol_actual === "admin" ? "selected" : ""}>Administrador (Empresa)</option>
          <option value="invitado" ${rol_actual === "invitado" ? "selected" : ""}>Invitado (Demo)</option>
        </select>
      </div>
      <div class="mb-1">
        <label class="form-label">Nueva Contraseña <span class="text-secondary fw-normal">(opcional)</span></label>
        <input id="edit-cli-pass" type="password" minlength="8" class="form-control form-control-sm" placeholder="Dejar en blanco para conservar la actual">
      </div>
    `;
    footer.innerHTML = `
      <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">Cancelar</button>
      <button type="button" id="btn-save-edit-cliente" class="btn btn-sm btn-warning text-dark fw-bold"><i class="bi bi-check2"></i> Guardar Usuario</button>
    `;

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("modal-admin-editar"));
    modal.show();

    document.getElementById("btn-save-edit-cliente")?.addEventListener("click", async () => {
      const nombre_completo = document.getElementById("edit-cli-nombre")?.value.trim();
      const email = document.getElementById("edit-cli-email")?.value.trim();
      const rol = document.getElementById("edit-cli-rol")?.value || "usuario";
      const password = document.getElementById("edit-cli-pass")?.value || "";

      if (!nombre_completo || !email) {
        mostrar_notificacion("El nombre y correo no pueden estar vacíos.", "warning");
        return;
      }
      if (password && password.length < 8) {
        mostrar_notificacion("La nueva contraseña debe tener al menos 8 caracteres.", "warning");
        return;
      }

      try {
        if (this.en_linea_admin) {
          await this.api.put(config.endpoints.admin_cliente_editar(id_usuario), {
            nombre_completo,
            activo: Boolean(c.activo ?? 1)
          });
        }
        this.auth?.actualizar_usuario(id_usuario, {
          nombre_completo,
          email,
          rol,
          password: password || undefined
        });
        this.clientes = this.auth?.obtener_usuarios_registrados() || [];
        this.auditoria = this.auth?.obtener_auditoria_local() || [];
        modal.hide();
        this.renderizar_todo();
        mostrar_notificacion(`Usuario '${nombre_completo}' actualizado correctamente.`, "success");
      } catch (err) {
        mostrar_notificacion(err.message || "Error al actualizar usuario", "danger");
      }
    });
  }

  _renderizar_selectores_asignacion() {
    const sv = document.getElementById("select-asignar-vehiculo");
    const sc = document.getElementById("select-asignar-cliente");
    const sf = document.getElementById("select-demo-fab-vehiculo");

    const opts_u = this.unidades
      .map(
        (u) =>
          `<option value="${u.id_vehiculo}">${esc(u.nombre)} (${esc(u.numero_serie || u.id_vehiculo)} · ${esc(u.estado_inventario)})</option>`
      )
      .join("");
    if (sv) sv.innerHTML = opts_u;
    if (sf) sf.innerHTML = opts_u;

    if (sc) {
      const compradores = this.clientes.filter(
        (c) => Boolean(c.activo ?? 1) && (c.rol || "usuario") === "usuario"
      );
      sc.innerHTML = compradores
        .map(
          (c) =>
            `<option value="${c.id_usuario}">${esc(c.nombre_completo)} (${esc(c.email)})</option>`
        )
        .join("");
    }
  }

  _renderizar_pasos_fabrica() {
    const cont = document.getElementById("lista-pasos-fabrica");
    if (!cont) return;
    const cmds = [
      { id: 1, n: "1 · Avanzar" },
      { id: 2, n: "2 · Retroceder" },
      { id: 3, n: "3 · Girar Palanca Izquierda" },
      { id: 4, n: "4 · Girar Palanca Derecha" },
      { id: 5, n: "5 · Bajar Brazo" },
      { id: 6, n: "6 · Subir Brazo" },
      { id: 7, n: "7 · Girar Derecha" },
      { id: 8, n: "8 · Girar Izquierda" },
      { id: 9, n: "9 · Detener" },
      { id: 10, n: "10 · Sonido" },
      { id: 11, n: "11 · LED" },
      { id: 12, n: "12 · Demo Software" }
    ];
    cont.innerHTML = this.pasos_fabrica_tmp
      .map(
        (p, i) => `
      <div class="row g-2 align-items-center mb-2">
        <div class="col-1 text-warning font-monospace small">#${i + 1}</div>
        <div class="col-6">
          <select class="form-select form-select-sm bg-dark text-light border-secondary fab-paso-cmd" data-i="${i}">
            ${cmds.map((c) => `<option value="${c.id}" ${c.id === p.id_comando ? "selected" : ""}>${c.n}</option>`).join("")}
          </select>
        </div>
        <div class="col-3">
          <input type="number" min="200" max="10000" step="100" value="${p.duracion_ms}" class="form-control form-control-sm bg-dark text-light border-secondary font-monospace fab-paso-dur" data-i="${i}">
        </div>
        <div class="col-2 text-end">
          <button type="button" class="btn btn-sm btn-outline-danger fab-paso-del" data-i="${i}" ${this.pasos_fabrica_tmp.length <= 1 ? "disabled" : ""}><i class="bi bi-trash3"></i></button>
        </div>
      </div>
    `
      )
      .join("");

    cont.querySelectorAll(".fab-paso-cmd").forEach((s) =>
      s.addEventListener("change", (e) => {
        this.pasos_fabrica_tmp[Number(e.target.dataset.i)].id_comando = Number(e.target.value);
      })
    );
    cont.querySelectorAll(".fab-paso-dur").forEach((inp) =>
      inp.addEventListener("change", (e) => {
        this.pasos_fabrica_tmp[Number(e.target.dataset.i)].duracion_ms = Math.max(
          200,
          Math.min(10000, Number(e.target.value) || 800)
        );
      })
    );
    cont.querySelectorAll(".fab-paso-del").forEach((btn) =>
      btn.addEventListener("click", () => {
        this.pasos_fabrica_tmp.splice(Number(btn.dataset.i), 1);
        this._renderizar_pasos_fabrica();
      })
    );
  }

  _renderizar_demos_fabrica() {
    const tbody = document.getElementById("tabla-demos-fabrica-body");
    if (!tbody) return;
    if (this.demos_fabrica.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-secondary py-3">Sin demos oficiales consultadas todavía</td></tr>`;
      return;
    }
    tbody.innerHTML = this.demos_fabrica
      .map(
        (d) => `
      <tr>
        <td class="text-info font-monospace">#${d.id_demo}</td>
        <td class="fw-bold">${esc(d.nombre)} <div class="small text-secondary">${esc(d.descripcion || "")}</div></td>
        <td>${esc(d.nombre_vehiculo || `Vehículo #${d.id_vehiculo}`)}</td>
        <td><span class="badge bg-dark border border-info text-info">${(d.pasos || []).length} pasos</span></td>
      </tr>
    `
      )
      .join("");
  }

  _renderizar_tabla_auditoria() {
    const tbody = document.getElementById("tabla-auditoria-body");
    if (!tbody) return;

    const filtrados = this.auditoria.filter((a) => {
      if (!this.filtro_auditoria_q) return true;
      const txt = `${a.accion} ${a.email_usuario || a.nombre_usuario || ""} ${JSON.stringify(a.detalles_json || a.detalles || "")}`.toLowerCase();
      return txt.includes(this.filtro_auditoria_q);
    });

    if (filtrados.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-secondary py-3">Sin registros de auditoría para mostrar</td></tr>`;
      return;
    }

    tbody.innerHTML = filtrados
      .map((a) => {
        const f = a.fecha_hora ? formatear_fecha_hora(a.fecha_hora) : { valido: false };
        const hora_txt = f.valido ? `${f.fecha} ${f.hora}` : esc(a.fecha_hora || "");
        const actor =
          a.email_usuario || a.nombre_usuario || `Usuario #${a.id_usuario ?? "Sistema"}`;
        const det =
          typeof a.detalles_json === "string"
            ? a.detalles_json
            : a.detalles_json
            ? JSON.stringify(a.detalles_json)
            : a.detalles || "";
        return `
        <tr>
          <td class="small text-secondary font-monospace">${esc(hora_txt)}</td>
          <td class="small fw-bold">${esc(actor)}</td>
          <td><span class="badge bg-dark border border-warning text-warning">${esc(a.accion)}</span></td>
          <td class="small text-light opacity-75">${esc(det)}</td>
        </tr>
      `;
      })
      .join("");
  }

  // ---------------------------------------------------------------------------
  // Acciones Admin CRUD
  // ---------------------------------------------------------------------------
  async _crear_modelo() {
    const nombre = document.getElementById("input-modelo-nombre")?.value.trim();
    const desc = document.getElementById("input-modelo-desc")?.value.trim() || "";
    const mcu = document.getElementById("input-modelo-mcu")?.value || "ESP8266";
    if (!nombre) return;

    if (this.en_linea_admin) {
      try {
        await this.api.post(config.endpoints.admin_modelos, {
          nombre_comercial: nombre,
          descripcion: desc,
          tipo_microcontrolador: mcu
        });
        mostrar_notificacion(`Modelo '${nombre}' guardado en Amazon RDS.`, "success");
        document.getElementById("form-crear-modelo")?.reset();
        await this.sincronizar_desde_backend();
        return;
      } catch (err) {
        mostrar_notificacion(err.message || "No se pudo crear el modelo", "danger");
        return;
      }
    }

    const nuevo_id = Math.max(0, ...this.modelos.map((m) => m.id_modelo)) + 1;
    this.modelos.push({
      id_modelo: nuevo_id,
      nombre_comercial: nombre,
      descripcion: desc,
      tipo_microcontrolador: mcu,
      activo: 1
    });
    this._guardar_estado_local();
    this.auth?.registrar_evento_auditoria("ALTA_MODELO", "MODELO", nuevo_id, {
      nombre_comercial: nombre,
      mcu
    });
    this.auditoria = this.auth?.obtener_auditoria_local() || [];
    document.getElementById("form-crear-modelo")?.reset();
    this.renderizar_todo();
    mostrar_notificacion(`Modelo '${nombre}' registrado.`, "success");
  }

  async _alternar_estado_modelo(id_modelo) {
    const m = this.modelos.find((x) => Number(x.id_modelo) === id_modelo);
    if (!m) return;
    const nuevo_activo = !Boolean(m.activo ?? 1);
    if (this.en_linea_admin) {
      try {
        await this.api.patch(config.endpoints.admin_modelo_estado(id_modelo), {
          activo: nuevo_activo
        });
        mostrar_notificacion(`Estado de '${m.nombre_comercial}' actualizado.`, "success");
        await this.sincronizar_desde_backend();
      } catch (err) {
        mostrar_notificacion(err.message, "danger");
      }
      return;
    }
    m.activo = nuevo_activo ? 1 : 0;
    this._guardar_estado_local();
    this.auth?.registrar_evento_auditoria("ESTADO_MODELO", "MODELO", id_modelo, {
      nombre_comercial: m.nombre_comercial,
      activo: m.activo
    });
    this.auditoria = this.auth?.obtener_auditoria_local() || [];
    this.renderizar_todo();
  }

  _abrir_modal_editar_modelo(id_modelo) {
    const m = this.modelos.find((x) => Number(x.id_modelo) === id_modelo);
    if (!m) return;
    const body = document.getElementById("modal-admin-editar-body");
    const footer = document.getElementById("modal-admin-editar-footer");
    const titulo = document.getElementById("modalAdminEditarLabel");
    if (!body || !footer || !titulo) return;

    titulo.innerHTML = `<i class="bi bi-boxes me-1"></i> Editar Modelo #${m.id_modelo}`;
    body.innerHTML = `
      <div class="mb-2">
        <label class="form-label">Nombre Comercial</label>
        <input id="edit-mod-nombre" type="text" class="form-control form-control-sm" value="${esc(m.nombre_comercial)}">
      </div>
      <div class="mb-2">
        <label class="form-label">Microcontrolador</label>
        <select id="edit-mod-mcu" class="form-select form-select-sm">
          <option value="ESP8266" ${m.tipo_microcontrolador === "ESP8266" ? "selected" : ""}>ESP8266</option>
          <option value="ESP32" ${m.tipo_microcontrolador === "ESP32" ? "selected" : ""}>ESP32</option>
        </select>
      </div>
      <div class="mb-1">
        <label class="form-label">Descripción</label>
        <textarea id="edit-mod-desc" rows="2" class="form-control form-control-sm">${esc(m.descripcion || "")}</textarea>
      </div>
    `;
    footer.innerHTML = `
      <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">Cancelar</button>
      <button type="button" id="btn-save-edit-modelo" class="btn btn-sm btn-warning text-dark fw-bold"><i class="bi bi-check2"></i> Guardar Cambios</button>
    `;

    const modalEl = document.getElementById("modal-admin-editar");
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();

    document.getElementById("btn-save-edit-modelo")?.addEventListener("click", async () => {
      const nombre_comercial = document.getElementById("edit-mod-nombre").value.trim();
      const tipo_microcontrolador = document.getElementById("edit-mod-mcu").value;
      const descripcion = document.getElementById("edit-mod-desc").value.trim();
      if (!nombre_comercial) return;

      if (this.en_linea_admin) {
        try {
          await this.api.put(config.endpoints.admin_modelo_editar(id_modelo), {
            nombre_comercial,
            tipo_microcontrolador,
            descripcion,
            imagen_url: m.imagen_url || "./assets/img/excavadora.svg"
          });
          modal.hide();
          mostrar_notificacion("Modelo actualizado en RDS.", "success");
          await this.sincronizar_desde_backend();
        } catch (err) {
          mostrar_notificacion(err.message, "danger");
        }
      } else {
        m.nombre_comercial = nombre_comercial;
        m.tipo_microcontrolador = tipo_microcontrolador;
        m.descripcion = descripcion;
        this._guardar_estado_local();
        modal.hide();
        this.renderizar_todo();
        mostrar_notificacion("Modelo actualizado.", "success");
      }
    });
  }

  async _abrir_modal_capacidades_modelo(id_modelo) {
    const m = this.modelos.find((x) => Number(x.id_modelo) === id_modelo);
    const body = document.getElementById("modal-admin-editar-body");
    const footer = document.getElementById("modal-admin-editar-footer");
    const titulo = document.getElementById("modalAdminEditarLabel");
    if (!m || !body || !footer || !titulo) return;

    titulo.innerHTML = `<i class="bi bi-cpu me-1"></i> Capacidades de Comandos · ${esc(m.nombre_comercial)}`;
    let items = [
      { nombre: "avanzar", codigo: 1, permitido_invitado: 1, activo: 1 },
      { nombre: "retroceder", codigo: 2, permitido_invitado: 1, activo: 1 },
      { nombre: "girar_palanca_izquierda", codigo: 3, permitido_invitado: 1, activo: 1 },
      { nombre: "girar_palanca_derecha", codigo: 4, permitido_invitado: 1, activo: 1 },
      { nombre: "bajar_brazo", codigo: 5, permitido_invitado: 0, activo: 1 },
      { nombre: "subir_brazo", codigo: 6, permitido_invitado: 0, activo: 1 },
      { nombre: "girar_derecha", codigo: 7, permitido_invitado: 0, activo: 1 },
      { nombre: "girar_izquierda", codigo: 8, permitido_invitado: 0, activo: 1 },
      { nombre: "detener", codigo: 9, permitido_invitado: 1, activo: 1 },
      { nombre: "sonido", codigo: 10, permitido_invitado: 1, activo: 1 },
      { nombre: "led", codigo: 11, permitido_invitado: 1, activo: 1 },
      { nombre: "demo_software", codigo: 12, permitido_invitado: 0, activo: 1 }
    ];

    if (this.en_linea_admin) {
      try {
        const resp = await this.api.get(config.endpoints.admin_modelo_comandos(id_modelo));
        if (resp?.items?.length) items = resp.items;
      } catch (_e) {}
    }

    body.innerHTML = `
      <p class="small text-secondary mb-2">Define qué comandos soporta este modelo y cuáles puede operar un Invitado en exhibición.</p>
      <div class="table-responsive">
        <table class="table table-dark table-sm align-middle mb-0">
          <thead><tr><th>Cód</th><th>Comando</th><th>Invitado</th><th>Activo</th></tr></thead>
          <tbody>
            ${items
              .map(
                (it, idx) => `
              <tr>
                <td class="font-monospace text-warning">${it.codigo}</td>
                <td>${esc(it.nombre)}</td>
                <td><input type="checkbox" class="form-check-input cap-inv" data-i="${idx}" ${it.permitido_invitado ? "checked" : ""}></td>
                <td><input type="checkbox" class="form-check-input cap-act" data-i="${idx}" ${it.activo ? "checked" : ""}></td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
    footer.innerHTML = `
      <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">Cerrar</button>
      <button type="button" id="btn-save-caps-modelo" class="btn btn-sm btn-warning text-dark fw-bold"><i class="bi bi-check2"></i> Guardar Capacidades</button>
    `;

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("modal-admin-editar"));
    modal.show();

    document.getElementById("btn-save-caps-modelo")?.addEventListener("click", async () => {
      body.querySelectorAll(".cap-inv").forEach((ch) => {
        items[Number(ch.dataset.i)].permitido_invitado = ch.checked;
      });
      body.querySelectorAll(".cap-act").forEach((ch) => {
        items[Number(ch.dataset.i)].activo = ch.checked;
      });
      if (this.en_linea_admin) {
        try {
          await this.api.put(config.endpoints.admin_modelo_comandos(id_modelo), {
            comandos: items.map((x) => ({
              nombre: x.nombre,
              codigo: Number(x.codigo),
              descripcion: x.descripcion || x.nombre,
              permitido_invitado: Boolean(x.permitido_invitado),
              activo: Boolean(x.activo)
            }))
          });
          modal.hide();
          mostrar_notificacion("Capacidades del modelo guardadas en RDS.", "success");
          await this.sincronizar_desde_backend();
        } catch (err) {
          mostrar_notificacion(err.message, "danger");
        }
      } else {
        modal.hide();
        mostrar_notificacion("Capacidades del modelo actualizadas.", "success");
      }
    });
  }

  async _crear_unidad() {
    const nombre = document.getElementById("input-unidad-nombre")?.value.trim();
    const numero_serie = document.getElementById("input-unidad-serie")?.value.trim();
    const id_modelo = Number(document.getElementById("select-unidad-modelo")?.value || 1);
    const estado_inventario =
      document.getElementById("select-unidad-estado")?.value || "disponible";
    if (!nombre || !numero_serie) return;

    if (
      this.unidades.some(
        (u) => String(u.numero_serie || "").toLowerCase() === numero_serie.toLowerCase()
      )
    ) {
      mostrar_notificacion(`El número de serie '${numero_serie}' ya existe (UNIQUE).`, "warning");
      return;
    }

    if (this.en_linea_admin) {
      try {
        await this.api.post(config.endpoints.admin_unidades, {
          id_modelo,
          numero_serie,
          nombre,
          estado_inventario
        });
        mostrar_notificacion(`Unidad '${nombre}' (${numero_serie}) dada de alta.`, "success");
        await this.sincronizar_desde_backend();
      } catch (err) {
        mostrar_notificacion(err.message, "danger");
      }
      return;
    }

    const nuevo_id = Math.max(0, ...this.unidades.map((u) => Number(u.id_vehiculo) || 0)) + 1;
    const mod = this.modelos.find((m) => m.id_modelo === id_modelo);
    this.unidades.push({
      id_vehiculo: nuevo_id,
      id_modelo,
      nombre,
      numero_serie,
      nombre_comercial: mod?.nombre_comercial || "Modelo",
      microcontrolador: mod?.tipo_microcontrolador || "ESP8266",
      estado_inventario,
      id_propietario: null,
      nombre_propietario: null,
      soporte_activo: false
    });
    this.unidades.sort((a, b) => Number(a.id_vehiculo) - Number(b.id_vehiculo));
    this._guardar_estado_local();
    this.auth?.registrar_evento_auditoria("ALTA_UNIDAD", "VEHICULO", nuevo_id, {
      nombre,
      numero_serie,
      estado_inventario
    });
    this.auditoria = this.auth?.obtener_auditoria_local() || [];
    document.getElementById("form-crear-unidad")?.reset();
    this._actualizar_selector_vehiculos_admin();
    this.renderizar_todo();
    mostrar_notificacion(`Unidad '${nombre}' (${numero_serie}) registrada.`, "success");
  }

  _abrir_modal_editar_unidad(id_vehiculo) {
    const u = this.unidades.find((x) => Number(x.id_vehiculo) === id_vehiculo);
    const body = document.getElementById("modal-admin-editar-body");
    const footer = document.getElementById("modal-admin-editar-footer");
    const titulo = document.getElementById("modalAdminEditarLabel");
    if (!u || !body || !footer || !titulo) return;

    titulo.innerHTML = `<i class="bi bi-truck me-1"></i> Editar Unidad #${u.id_vehiculo}`;
    const estados = ["disponible", "vendido", "exhibicion", "mantenimiento", "inactivo"];
    body.innerHTML = `
      <div class="mb-2">
        <label class="form-label">Nombre de Unidad</label>
        <input id="edit-uni-nombre" type="text" class="form-control form-control-sm" value="${esc(u.nombre)}">
      </div>
      <div class="mb-2">
        <label class="form-label">Número de Serie</label>
        <input id="edit-uni-serie" type="text" class="form-control form-control-sm font-monospace" value="${esc(u.numero_serie || "")}">
      </div>
      <div class="mb-1">
        <label class="form-label">Estado de Inventario (Baja lógica = INACTIVO)</label>
        <select id="edit-uni-estado" class="form-select form-select-sm">
          ${estados.map((s) => `<option value="${s}" ${u.estado_inventario === s ? "selected" : ""}>${s.toUpperCase()}</option>`).join("")}
        </select>
      </div>
    `;
    footer.innerHTML = `
      <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">Cancelar</button>
      <button type="button" id="btn-save-edit-unidad" class="btn btn-sm btn-warning text-dark fw-bold"><i class="bi bi-check2"></i> Guardar Unidad</button>
    `;

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("modal-admin-editar"));
    modal.show();

    document.getElementById("btn-save-edit-unidad")?.addEventListener("click", async () => {
      const nombre = document.getElementById("edit-uni-nombre").value.trim();
      const numero_serie = document.getElementById("edit-uni-serie").value.trim();
      const estado_inventario = document.getElementById("edit-uni-estado").value;
      if (!nombre || !numero_serie) return;

      if (this.en_linea_admin) {
        try {
          await this.api.put(config.endpoints.admin_unidad_editar(id_vehiculo), {
            id_modelo: u.id_modelo,
            nombre,
            numero_serie,
            descripcion: u.descripcion || "",
            estado_inventario
          });
          modal.hide();
          mostrar_notificacion("Unidad actualizada correctamente.", "success");
          await this.sincronizar_desde_backend();
        } catch (err) {
          mostrar_notificacion(err.message, "danger");
        }
      } else {
        u.nombre = nombre;
        u.numero_serie = numero_serie;
        u.estado_inventario = estado_inventario;
        if (estado_inventario !== "vendido") {
          u.id_propietario = null;
          u.nombre_propietario = null;
          u.soporte_activo = false;
        }
        this._guardar_estado_local();
        this.auth?.registrar_evento_auditoria("EDITAR_UNIDAD", "VEHICULO", id_vehiculo, {
          nombre,
          numero_serie,
          estado_inventario
        });
        this.auditoria = this.auth?.obtener_auditoria_local() || [];
        modal.hide();
        this._actualizar_selector_vehiculos_admin();
        this.renderizar_todo();
        mostrar_notificacion("Unidad actualizada correctamente.", "success");
      }
    });
  }

  async _crear_cliente() {
    const nombre_completo = document.getElementById("input-cliente-nombre")?.value.trim();
    const email = document.getElementById("input-cliente-email")?.value.trim();
    const rol = document.getElementById("select-cliente-rol")?.value || "usuario";
    const password = document.getElementById("input-cliente-password")?.value || "";
    if (!nombre_completo || !email || password.length < 8) {
      mostrar_notificacion(
        "Completa nombre, correo y contraseña de mínimo 8 caracteres.",
        "warning"
      );
      return;
    }

    try {
      if (this.en_linea_admin && rol === "usuario") {
        await this.api.post(config.endpoints.admin_clientes, {
          nombre_completo,
          email,
          password
        });
      }
      const nuevo = this.auth?.registrar_usuario({
        nombre_completo,
        email,
        password,
        rol
      });
      this.clientes = this.auth?.obtener_usuarios_registrados() || [];
      this.auditoria = this.auth?.obtener_auditoria_local() || [];
      document.getElementById("form-crear-cliente")?.reset();
      this.renderizar_todo();
      mostrar_notificacion(
        `Usuario '${nuevo?.nombre_completo || nombre_completo}' (${rol.toUpperCase()}) registrado. Ya puede iniciar sesión con su correo y contraseña.`,
        "success",
        4800
      );
    } catch (err) {
      mostrar_notificacion(err.message || "No se pudo registrar el usuario.", "danger");
    }
  }

  async _alternar_estado_cliente(id_cliente) {
    const c = this.clientes.find((x) => Number(x.id_usuario) === id_cliente);
    if (!c) return;
    if (
      Number(id_cliente) === Number(this.auth?.obtener_usuario()?.id_usuario) &&
      Boolean(c.activo ?? 1)
    ) {
      mostrar_notificacion("No puedes desactivar tu propia cuenta con sesión activa.", "warning");
      return;
    }

    const activo = !Boolean(c.activo ?? 1);
    try {
      if (this.en_linea_admin) {
        await this.api.put(config.endpoints.admin_cliente_editar(id_cliente), {
          nombre_completo: c.nombre_completo,
          activo
        });
      }
      this.auth?.actualizar_usuario(id_cliente, { activo });
      this.clientes = this.auth?.obtener_usuarios_registrados() || [];
      this.auditoria = this.auth?.obtener_auditoria_local() || [];
      this.renderizar_todo();
      mostrar_notificacion(
        `Cuenta de '${c.nombre_completo}' ${activo ? "reactivada" : "desactivada"}.`,
        activo ? "success" : "warning"
      );
    } catch (err) {
      mostrar_notificacion(err.message, "danger");
    }
  }

  async _asignar_unidad() {
    const id_vehiculo = Number(document.getElementById("select-asignar-vehiculo")?.value);
    const id_usuario = Number(document.getElementById("select-asignar-cliente")?.value);
    if (!id_vehiculo || !id_usuario) return;

    if (this.en_linea_admin) {
      try {
        await this.api.post(config.endpoints.admin_asignaciones, { id_vehiculo, id_usuario });
        mostrar_notificacion("Unidad asignada al comprador con aislamiento exclusivo.", "success");
        await this.sincronizar_desde_backend();
        return;
      } catch (err) {
        mostrar_notificacion(err.message, "danger");
        return;
      }
    }

    const u = this.unidades.find((x) => x.id_vehiculo === id_vehiculo);
    const c = this.clientes.find((x) => x.id_usuario === id_usuario);
    if (u && c) {
      const dueno_previo = u.nombre_propietario;
      u.estado_inventario = "vendido";
      u.id_propietario = id_usuario;
      u.nombre_propietario = c.nombre_completo;
      u.soporte_activo = false;
      this._guardar_estado_local();
      this.auth?.registrar_evento_auditoria("ASIGNAR_VEHICULO", "VEHICULO", id_vehiculo, {
        unidad: u.nombre,
        serie: u.numero_serie,
        nuevo_propietario: c.email,
        propietario_anterior: dueno_previo || "Ninguno"
      });
      this.auditoria = this.auth?.obtener_auditoria_local() || [];
    }
    this._actualizar_selector_vehiculos_admin();
    this.renderizar_todo();
    mostrar_notificacion(
      `Unidad '${u?.nombre}' asignada a ${c?.nombre_completo}. Los permisos anteriores fueron revocados.`,
      "success"
    );
  }

  async _revocar_asignacion_seleccionada() {
    const id_vehiculo = Number(document.getElementById("select-asignar-vehiculo")?.value);
    if (!id_vehiculo) return;
    if (this.en_linea_admin) {
      try {
        await this.api.post(config.endpoints.admin_asignacion_revocar(id_vehiculo), {
          motivo: "Revocación desde panel Administrativo"
        });
        mostrar_notificacion(
          "Asignación revocada; la unidad volvió a inventario disponible.",
          "warning"
        );
        await this.sincronizar_desde_backend();
        return;
      } catch (err) {
        mostrar_notificacion(err.message, "danger");
        return;
      }
    }

    const u = this.unidades.find((x) => x.id_vehiculo === id_vehiculo);
    if (u) {
      const ex_dueno = u.nombre_propietario;
      u.estado_inventario = "disponible";
      u.id_propietario = null;
      u.nombre_propietario = null;
      u.soporte_activo = false;
      this._guardar_estado_local();
      this.auth?.registrar_evento_auditoria("REVOCAR_ASIGNACION", "VEHICULO", id_vehiculo, {
        unidad: u.nombre,
        propietario_revocado: ex_dueno || "N/A"
      });
      this.auditoria = this.auth?.obtener_auditoria_local() || [];
    }
    this._actualizar_selector_vehiculos_admin();
    this.renderizar_todo();
    mostrar_notificacion(
      "Asignación revocada; la unidad regresó a estado DISPONIBLE.",
      "warning"
    );
  }

  async _crear_demo_fabrica() {
    const id_vehiculo = Number(document.getElementById("select-demo-fab-vehiculo")?.value || 1);
    const nombre = document.getElementById("input-demo-fab-nombre")?.value.trim();
    const descripcion = document.getElementById("input-demo-fab-desc")?.value.trim() || "";
    if (!nombre || this.pasos_fabrica_tmp.length === 0) return;

    const payload = {
      id_vehiculo,
      nombre,
      descripcion,
      es_fabrica: 1,
      pasos: this.pasos_fabrica_tmp.map((p, i) => ({
        orden: i + 1,
        id_comando: p.id_comando,
        duracion_ms: p.duracion_ms
      }))
    };

    if (this.en_linea_admin) {
      try {
        await this.api.post(config.endpoints.admin_demos_fabrica, payload);
        mostrar_notificacion(`Demo de fábrica '${nombre}' publicada.`, "success");
        document.getElementById("form-crear-demo-fabrica")?.reset();
        await this.sincronizar_desde_backend();
        return;
      } catch (err) {
        mostrar_notificacion(err.message, "danger");
        return;
      }
    }

    const u = this.unidades.find((x) => Number(x.id_vehiculo) === id_vehiculo);
    const ids_demos = [
      ...this.demos_fabrica.map((d) => Number(d.id_demo) || 0),
      ...this.demos_privadas.map((d) => Number(d.id_demo) || 0)
    ];
    const nuevo_id = (ids_demos.length > 0 ? Math.max(0, ...ids_demos) : 0) + 1;
    this.demos_fabrica.push({
      id_demo: nuevo_id,
      ...payload,
      nombre_vehiculo: u?.nombre || `Unidad #${id_vehiculo}`
    });
    this.demos_fabrica.sort((a, b) => Number(a.id_demo) - Number(b.id_demo));
    this._guardar_estado_local();
    this.auth?.registrar_evento_auditoria("CREAR_DEMO_FABRICA", "DEMO", nuevo_id, {
      nombre,
      id_vehiculo,
      pasos: payload.pasos.length
    });
    this.auditoria = this.auth?.obtener_auditoria_local() || [];
    document.getElementById("form-crear-demo-fabrica")?.reset();
    this.renderizar_todo();
    mostrar_notificacion(`Demo de fábrica '${nombre}' publicada.`, "success");
  }

  // ---------------------------------------------------------------------------
  // Panel de Comprador (Mis Vehículos + Soporte Técnico + Demos Privadas)
  // ---------------------------------------------------------------------------
  async _cargar_panel_comprador() {
    if (this.auth?.es_modo_backend_jwt()) {
      try {
        const resp = await this.api.get(config.endpoints.usuario_vehiculos);
        this.mis_vehiculos = resp?.items || [];
        if (this.mis_vehiculos.length > 0) {
          const demosResp = await this.api.get(
            config.endpoints.usuario_demos(this.mis_vehiculos[0].id_vehiculo)
          );
          this.mis_demos = demosResp?.items || [];
        } else {
          this.mis_demos = [];
        }
        this._actualizar_badge_sync(true);
      } catch (err) {
        this.mis_vehiculos = [];
        this.mis_demos = [];
        mostrar_notificacion(err.message || "Error consultando tus vehículos", "danger");
      }
    } else {
      const estado = this._cargar_estado_local();
      this.unidades = estado.unidades;
      this.demos_fabrica = estado.demos_fabrica;
      this.demos_privadas = estado.demos_privadas;

      const uid = Number(this.auth?.obtener_usuario()?.id_usuario || 0);
      this.mis_vehiculos = this.unidades.filter(
        (u) => Number(u.id_propietario) === uid && u.estado_inventario !== "inactivo"
      );
      if (this.mis_vehiculos.length > 0) {
        const ids_propios = new Set(this.mis_vehiculos.map((v) => Number(v.id_vehiculo)));
        const demos_fab = this.demos_fabrica.filter(
          (d) => !d.id_vehiculo || ids_propios.has(Number(d.id_vehiculo))
        );
        const demos_priv = this.demos_privadas.filter(
          (d) => Number(d.id_usuario) === uid && ids_propios.has(Number(d.id_vehiculo))
        );
        this.mis_demos = [...demos_priv, ...demos_fab];
      } else {
        this.mis_demos = [];
      }
      this._actualizar_badge_sync(false, "Persistencia Local RBAC");
    }

    this._actualizar_selector_vehiculos_barra();
    this.renderizar_todo();
  }

  _actualizar_selector_vehiculos_barra() {
    const sel = document.getElementById("select-mis-vehiculos");
    if (!sel) return;
    if (this.mis_vehiculos.length === 0) {
      sel.innerHTML = `<option value="">Sin unidades asignadas</option>`;
      return;
    }
    sel.innerHTML = this.mis_vehiculos
      .map(
        (v) =>
          `<option value="${v.id_vehiculo}">${esc(v.nombre)} (${esc(v.numero_serie || `#${v.id_vehiculo}`)})</option>`
      )
      .join("");
    if (this.mis_vehiculos.some((v) => Number(v.id_vehiculo) === Number(config.id_vehiculo))) {
      sel.value = String(config.id_vehiculo);
    }
  }

  _renderizar_panel_comprador() {
    const cont_v = document.getElementById("comprador-lista-vehiculos");
    if (cont_v) {
      if (this.mis_vehiculos.length === 0) {
        cont_v.innerHTML = `
          <div class="col-12">
            <div class="admin-subcard text-center py-4">
              <i class="bi bi-shield-lock text-info fs-3 d-block mb-2"></i>
              <h3 class="h6 text-light fw-bold mb-1">Aún no tienes vehículos asignados</h3>
              <p class="small text-secondary mb-0">
                Inicia sesión como <strong class="text-warning">Administrador</strong> y asigna una unidad física a tu cuenta (<code class="text-warning">${esc(this.auth?.obtener_usuario()?.email)}</code>). Por aislamiento BOLA/IDOR no se muestran vehículos de otros compradores ni de exhibición.
              </p>
            </div>
          </div>
        `;
      } else {
        cont_v.innerHTML = this.mis_vehiculos
          .map((v) => {
            const sop = Boolean(v.soporte_activo);
            return `
            <div class="col-12 col-md-6">
              <div class="admin-subcard h-100 d-flex flex-column justify-content-between">
                <div>
                  <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
                    <div>
                      <h3 class="h6 text-warning fw-bold mb-0">${esc(v.nombre)}</h3>
                      <small class="text-secondary font-monospace">Serie: ${esc(v.numero_serie || "N/A")} · ${esc(v.microcontrolador || "ESP8266")}</small>
                    </div>
                    <span class="badge bg-success">Propiedad Activa</span>
                  </div>
                  <div class="small mb-2">
                    ${
                      sop
                        ? `<span class="badge bg-warning text-dark"><i class="bi bi-wrench"></i> Soporte Admin Autorizado (30 min)</span>`
                        : `<span class="badge bg-dark border border-secondary text-secondary"><i class="bi bi-lock"></i> Privacidad Protegida (Admin bloqueado)</span>`
                    }
                  </div>
                </div>
                <div class="d-flex flex-wrap gap-2 mt-2">
                  <button type="button" class="btn btn-sm btn-warning text-dark fw-bold flex-fill btn-buyer-ctrl" data-id="${v.id_vehiculo}">
                    <i class="bi bi-joystick"></i> Controlar
                  </button>
                  ${
                    sop
                      ? `<button type="button" class="btn btn-sm btn-outline-danger btn-buyer-revocar-soporte" data-id="${v.id_vehiculo}">Revocar Soporte</button>`
                      : `<button type="button" class="btn btn-sm btn-outline-info btn-buyer-autorizar-soporte" data-id="${v.id_vehiculo}">Autorizar Soporte (30m)</button>`
                  }
                </div>
              </div>
            </div>
          `;
          })
          .join("");

        cont_v.querySelectorAll(".btn-buyer-ctrl").forEach((b) =>
          b.addEventListener("click", () => this.on_navegar_a_unidad?.(Number(b.dataset.id)))
        );
        cont_v.querySelectorAll(".btn-buyer-autorizar-soporte").forEach((b) =>
          b.addEventListener("click", () => this._autorizar_soporte_unidad(Number(b.dataset.id)))
        );
        cont_v.querySelectorAll(".btn-buyer-revocar-soporte").forEach((b) =>
          b.addEventListener("click", () => this._revocar_soporte_unidad(Number(b.dataset.id)))
        );
      }
    }

    const cont_d = document.getElementById("comprador-lista-demos");
    if (cont_d) {
      if (this.mis_vehiculos.length === 0) {
        cont_d.innerHTML = `<div class="col-12 small text-secondary">Asigna primero una unidad para administrar tus demos privadas.</div>`;
        return;
      }
      if (this.mis_demos.length === 0) {
        cont_d.innerHTML = `<div class="col-12 small text-secondary">No hay rutinas cargadas todavía para esta unidad.</div>`;
        return;
      }
      cont_d.innerHTML = this.mis_demos
        .map((d) => {
          const es_fabrica = Boolean(d.es_fabrica);
          return `
          <div class="col-12 col-md-6">
            <div class="admin-subcard">
              <div class="d-flex justify-content-between align-items-start gap-2 mb-1">
                <strong class="text-light">${es_fabrica ? "" : '<i class="bi bi-bookmark-fill text-warning me-1"></i>'}${esc(d.nombre)}</strong>
                <span class="badge ${es_fabrica ? "bg-secondary" : "retro-badge-gold"}">${es_fabrica ? "Fábrica" : "Privada"}</span>
              </div>
              <p class="small text-secondary mb-2">${esc(d.descripcion || "Sin descripción")} · ${(d.pasos || []).length} pasos</p>
              <div class="d-flex gap-2 flex-wrap">
                <button type="button" class="btn btn-sm btn-success flex-fill btn-buyer-run-demo" data-id="${d.id_demo}" data-veh="${d.id_vehiculo}">
                  <i class="bi bi-play-fill"></i> Ejecutar
                </button>
                ${
                  !es_fabrica
                    ? `
                  <button type="button" class="btn btn-sm btn-outline-warning btn-buyer-edit-demo" data-id="${d.id_demo}">Editar</button>
                  <button type="button" class="btn btn-sm btn-outline-danger btn-buyer-del-demo" data-id="${d.id_demo}">Eliminar</button>
                `
                    : ""
                }
              </div>
            </div>
          </div>
        `;
        })
        .join("");

      cont_d.querySelectorAll(".btn-buyer-run-demo").forEach((b) =>
        b.addEventListener("click", () =>
          this.on_ejecutar_demo?.(Number(b.dataset.veh), Number(b.dataset.id))
        )
      );
      cont_d.querySelectorAll(".btn-buyer-edit-demo").forEach((b) =>
        b.addEventListener("click", () => {
          const obj = this.mis_demos.find((x) => Number(x.id_demo) === Number(b.dataset.id));
          if (obj) this.on_abrir_editor_demo?.(obj);
        })
      );
      cont_d.querySelectorAll(".btn-buyer-del-demo").forEach((b) =>
        b.addEventListener("click", () => this._eliminar_demo_privada(Number(b.dataset.id)))
      );
    }
  }

  async _autorizar_soporte_unidad(id_vehiculo) {
    if (this.auth?.es_modo_backend_jwt()) {
      try {
        await this.api.post(config.endpoints.usuario_soporte_autorizar(id_vehiculo), {
          duracion_minutos: 30,
          motivo: "Soporte técnico autorizado temporalmente por el propietario"
        });
        mostrar_notificacion("Soporte autorizado por 30 minutos para esta unidad.", "success");
        await this._cargar_panel_comprador();
        return;
      } catch (err) {
        mostrar_notificacion(err.message, "danger");
        return;
      }
    }

    const estado = this._cargar_estado_local();
    const u = estado.unidades.find((x) => Number(x.id_vehiculo) === Number(id_vehiculo));
    if (u) {
      u.soporte_activo = true;
      this._guardar_estado_local(estado);
      this.auth?.registrar_evento_auditoria("AUTORIZAR_SOPORTE", "VEHICULO", id_vehiculo, {
        unidad: u.nombre,
        duracion_minutos: 30
      });
    }
    mostrar_notificacion(
      "Soporte técnico autorizado por 30 minutos: el Administrador ya puede diagnosticar esta unidad.",
      "success"
    );
    await this._cargar_panel_comprador();
  }

  async _revocar_soporte_unidad(id_vehiculo) {
    if (this.auth?.es_modo_backend_jwt()) {
      try {
        await this.api.post(config.endpoints.usuario_soporte_revocar(id_vehiculo));
        mostrar_notificacion(
          "Soporte técnico revocado; acceso remoto del Admin cerrado.",
          "warning"
        );
        await this._cargar_panel_comprador();
        return;
      } catch (err) {
        mostrar_notificacion(err.message, "danger");
        return;
      }
    }

    const estado = this._cargar_estado_local();
    const u = estado.unidades.find((x) => Number(x.id_vehiculo) === Number(id_vehiculo));
    if (u) {
      u.soporte_activo = false;
      this._guardar_estado_local(estado);
      this.auth?.registrar_evento_auditoria("REVOCAR_SOPORTE", "VEHICULO", id_vehiculo, {
        unidad: u.nombre
      });
    }
    mostrar_notificacion("Soporte técnico revocado; acceso operativo del Admin bloqueado.", "warning");
    await this._cargar_panel_comprador();
  }

  async _eliminar_demo_privada(id_demo) {
    if (this.auth?.es_modo_backend_jwt()) {
      try {
        await this.api.del(config.endpoints.usuario_eliminar_demo(id_demo));
        mostrar_notificacion("Rutina privada eliminada correctamente.", "success");
        await this._cargar_panel_comprador();
        return;
      } catch (err) {
        mostrar_notificacion(err.message, "danger");
        return;
      }
    }

    const estado = this._cargar_estado_local();
    estado.demos_privadas = estado.demos_privadas.filter(
      (d) => Number(d.id_demo) !== Number(id_demo)
    );
    this._guardar_estado_local(estado);
    this.auth?.registrar_evento_auditoria("ELIMINAR_DEMO_PRIVADA", "DEMO", id_demo, {});
    mostrar_notificacion("Rutina privada eliminada correctamente.", "success");
    await this._cargar_panel_comprador();
  }
}
