import { config } from "./config.js";
import { ApiClient } from "./api-client.js";
import { WsClient } from "./ws-client.js";
import { UiManager } from "./ui-manager.js";
import { CommandController } from "./command-controller.js";
import { VirtualJoystick } from "./joystick.js";
import { DemoController } from "./demo-controller.js";
import { NavigationController } from "./navigation.js";
import { MonitoringSync } from "./monitoring-sync.js";
import { MonitoringView } from "./monitoring-view.js";
import { AuthSessionManager } from "./auth-session.js";
import { AdminViewController } from "./admin-view.js";
import { DemoEditorController } from "./demo-editor.js";
import { GuestViewController } from "./guest-view.js";
import { formatear_fecha_hora, formatear_nombre_comando, resolver_nombre_evento } from "./format-utils.js";
import { mostrar_notificacion } from "./toast.js";

function esc(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const api = new ApiClient();
const ui = new UiManager();
const auth_session = new AuthSessionManager(api);
const cmd_controller = new CommandController(api, ui);
const demo_controller = new DemoController(api, ui, cmd_controller);
const monitoring_view = new MonitoringView();

let api_en_linea = false;
let rds_confirmado = false;
let fallos_consecutivos_api = 0;
let catalogo_cargado = false;
let firma_sesion_anterior = "";

function obtener_firma_sesion() {
  const u = auth_session.obtener_usuario();
  const gt = auth_session.obtener_guest_token() || "";
  return `${u.id_usuario}:${u.rol}:${u.email}:${Boolean(u.autenticado)}:${Boolean(u.token)}:${gt}`;
}

function combinar_demos_con_locales(demos_remotas, id_vehiculo) {
  const base = Array.isArray(demos_remotas) ? [...demos_remotas] : [];
  if (auth_session.es_modo_backend_jwt()) {
    return base;
  }
  const locales = admin_view.obtener_demos_locales_unidad(id_vehiculo).filter((d) => !d.es_fabrica);
  const ids_existentes = new Set(base.map((d) => Number(d.id_demo)));
  for (const loc of locales) {
    if (!ids_existentes.has(Number(loc.id_demo))) {
      base.push({
        id_demo: loc.id_demo,
        id_vehiculo: loc.id_vehiculo,
        nombre: `[Privada] ${loc.nombre}`,
        descripcion: loc.descripcion,
        es_fabrica: 0,
        id_usuario: loc.id_usuario
      });
    }
  }
  return base;
}

function actualizar_rds_autentico(disponible, es_error_db = false) {
  if (es_error_db) {
    rds_confirmado = false;
    ui.actualizar_indicador_rds("offline", "No disponible (Error SP/RDS)");
    return;
  }
  if (disponible) {
    rds_confirmado = true;
    ui.actualizar_indicador_rds("online", "Disponible (SP Verificado)");
    return;
  }
  if (!api_en_linea) {
    rds_confirmado = false;
    ui.actualizar_indicador_rds("neutral", "Sin verificar (API Caída)");
  } else if (!rds_confirmado) {
    ui.actualizar_indicador_rds("neutral", "Sin verificar");
  }
}

ui.indicador_rds_confirmado = () => {
  actualizar_rds_autentico(true, false);
};

const monitoring_sync = new MonitoringSync(
  api,
  (snapshot) => {
    monitoring_view.renderizar(snapshot);
  },
  (ok, es_error_db) => {
    actualizar_rds_autentico(ok, es_error_db);
  }
);

const navigation = new NavigationController((vista, cambio) => {
  if (vista === "monitoreo" && cambio) {
    monitoring_sync.sincronizar_todo("cambio_pestana", { silencioso: false });
  } else if (vista === "administracion" && cambio) {
    admin_view.renderizar_todo();
  }
}, auth_session);

const joystick_zone = document.getElementById("joystick-zone");
const joystick_stick = document.getElementById("joystick-stick");
new VirtualJoystick(joystick_zone, joystick_stick, cmd_controller, ui);

const ws_client = new WsClient(
  (estado, texto) => {
    ui.actualizar_indicador_ws(estado, texto);
    monitoring_sync.actualizar_estado_ws(estado);
  },
  (payload) => {
    const ev = payload.evento || "mensaje";
    const f_ws = formatear_fecha_hora(payload.timestamp);
    const ts = f_ws.valido ? f_ws.hora : "";
    const datos = payload.datos || {};

    if (ev === "estado_inicial") {
      ui.mostrar_evento_ws(`Conectado en tiempo real (${ts || "listo"})`);
      if (payload.estado) {
        ui.reflejar_comando_visual(
          {
            codigo: payload.estado.codigo,
            nombre: payload.estado.comando
          },
          { alternar_toggles: false }
        );
      }
    } else if (ev === "movimiento_individual") {
      const nombre_crudo = resolver_nombre_evento(payload, cmd_controller.catalogo);
      if (nombre_crudo) {
        const nombre_limpio = formatear_nombre_comando(nombre_crudo);
        ui.mostrar_evento_ws(`Última acción: ${nombre_limpio}${ts ? " · " + ts : ""}`);
        ui.mostrar_estado_accion("evento", `Ejecutando: ${nombre_limpio}`);
        ui.reflejar_comando_visual(
          {
            codigo: datos.codigo ?? payload.codigo,
            nombre: nombre_crudo
          },
          { alternar_toggles: true }
        );
      } else {
        ui.mostrar_evento_ws(`Actividad recibida${ts ? " · " + ts : ""}`);
      }
    } else if (ev.startsWith("demo_")) {
      const datos_demo = { ...payload, ...datos };
      const nombre_paso = resolver_nombre_evento(payload, cmd_controller.catalogo);
      const paso_txt = nombre_paso ? formatear_nombre_comando(nombre_paso) : "";
      const etiquetas_demo = {
        demo_inicio: "Secuencia iniciada",
        demo_movimiento: paso_txt ? `Demo: ${paso_txt}` : "Demo en curso",
        demo_pausa: "Pausa en secuencia",
        demo_fin: "Secuencia finalizada",
        demo_cancelada: "Secuencia cancelada",
        demo_error: "Secuencia detenida"
      };
      ui.mostrar_evento_ws(`${etiquetas_demo[ev] || "Secuencia en curso"}${ts ? " · " + ts : ""}`);
      demo_controller.procesar_evento_ws_demo(ev, datos_demo, cmd_controller.catalogo);
    }

    monitoring_sync.procesar_evento_ws(payload);
  },
  () => {
    monitoring_sync.sincronizar_todo("reconexion_wss", { silencioso: true });
  }
);

api.establecer_proveedor_auth(
  () => auth_session.obtener_token_para_api(),
  () => auth_session.obtener_guest_token()
);

ws_client.establecer_proveedor_auth(() => ({
  token: auth_session.obtener_token_para_api(),
  guest_token: auth_session.obtener_guest_token()
}));

const demo_editor = new DemoEditorController(
  api,
  auth_session,
  async (id_vehiculo_actualizado, demo_local_guardada = null) => {
    if (demo_local_guardada && !auth_session.es_modo_backend_jwt()) {
      admin_view.guardar_demo_privada_local(demo_local_guardada);
    }
    const id_target = Number(id_vehiculo_actualizado || config.id_vehiculo);
    if (id_target === Number(config.id_vehiculo)) {
      try {
        const demos_remotas = await api.obtener_demos(id_target);
        const combinadas = combinar_demos_con_locales(demos_remotas, id_target);
        monitoring_sync.establecer_catalogo_demos(combinadas);
        ui.renderizar_selector_demos(combinadas);
      } catch (_err) {
        const solo_locales = combinar_demos_con_locales([], id_target);
        monitoring_sync.establecer_catalogo_demos(solo_locales);
        ui.renderizar_selector_demos(solo_locales);
      }
    }
    await admin_view.sincronizar_desde_backend();
  }
);

const admin_view = new AdminViewController(api, auth_session, {
  on_navegar_a_unidad: async (id_vehiculo) => {
    await cambiar_vehiculo_activo(Number(id_vehiculo), { forzar: true });
    navigation.cambiar_vista("control");
  },
  on_abrir_editor_demo: (demo_obj) => {
    const catalogo_base =
      cmd_controller.catalogo_completo && cmd_controller.catalogo_completo.length > 0
        ? cmd_controller.catalogo_completo
        : cmd_controller.catalogo;
    demo_editor.configurar_comandos_unidad(catalogo_base);
    demo_editor.abrir_modal(demo_obj);
  },
  on_ejecutar_demo: async (id_vehiculo, id_demo) => {
    const id_v = Number(id_vehiculo || config.id_vehiculo);
    if (id_v !== Number(config.id_vehiculo)) {
      await cambiar_vehiculo_activo(id_v, { forzar: true });
    }
    navigation.cambiar_vista("control");
    const select_demo = document.getElementById("select-demo");
    if (select_demo && id_demo) {
      select_demo.value = String(id_demo);
    }
    const nombre_demo = select_demo?.selectedOptions?.[0]?.textContent || `Demo #${id_demo}`;
    monitoring_sync.registrar_demo_local("ejecutando", nombre_demo);
    await demo_controller.iniciar_demo_seleccionada(id_demo);
  }
});

const CODIGOS_BASICOS_INVITADO = [1, 2, 3, 4, 7, 8, 9, 10, 11, 13, 14];

const guest_view = new GuestViewController(api, auth_session, cmd_controller, ui, {
  on_prueba_cambio: async (info) => {
    if (info.activa) {
      auth_session.registrar_evento_auditoria(
        "INICIAR_PRUEBA_INVITADO",
        "VEHICULO",
        Number(info.id_vehiculo || 1),
        { alias: guest_view.alias_invitado, duracion_min: guest_view.duracion_prueba_minutos }
      );
      cmd_controller.establecer_bloqueo_invitado(false);
      cmd_controller.establecer_filtro_codigos(info.codigos_permitidos || CODIGOS_BASICOS_INVITADO);
      await cambiar_vehiculo_activo(Number(info.id_vehiculo || 1), { forzar: true });
      navigation.cambiar_vista("control");
    } else {
      const es_invitado = auth_session.obtener_rol() === "invitado";
      cmd_controller.establecer_bloqueo_invitado(es_invitado);
      cmd_controller.establecer_filtro_codigos(es_invitado ? CODIGOS_BASICOS_INVITADO : null);
      await cambiar_vehiculo_activo(Number(config.id_vehiculo || 1), { forzar: true });
    }
  }
});

async function cambiar_vehiculo_activo(nuevo_id, { forzar = false } = {}) {
  const id_num = Number(nuevo_id);
  if (!id_num || (id_num === Number(config.id_vehiculo) && !forzar)) {
    return;
  }

  ws_client.desconectar();
  cmd_controller.reiniciar_estado_control();
  config.id_vehiculo = id_num;
  monitoring_sync.establecer_vehiculo(id_num);

  const select_mis = document.getElementById("select-mis-vehiculos");
  if (select_mis && Array.from(select_mis.options).some((o) => Number(o.value) === id_num)) {
    select_mis.value = String(id_num);
  }

  ws_client.conectar(id_num);
  await cargar_datos_iniciales();
}

function aplicar_rol_en_interfaz() {
  const usuario = auth_session.obtener_usuario();
  const rol = auth_session.obtener_rol();
  const autenticado = auth_session.esta_autenticado();

  document.body.dataset.role = rol;

  const icono_el = document.getElementById("session-role-icon");
  const texto_el = document.getElementById("session-role-text");
  const badge_rol = document.getElementById("session-user-role-badge");
  const badge_modo = document.getElementById("session-mode-badge");
  const name_el = document.getElementById("session-user-name");
  const email_el = document.getElementById("session-user-email");
  const btn_logout = document.getElementById("btn-cerrar-sesion");

  if (name_el) {
    name_el.textContent = usuario.nombre_completo || "Visitante (Acceso Público)";
  }
  if (email_el) {
    email_el.textContent = usuario.email || "invitado@demo.com";
  }

  if (badge_modo) {
    if (auth_session.es_modo_backend_jwt()) {
      badge_modo.textContent = "JWT AWS";
      badge_modo.className = "badge bg-success";
    } else if (autenticado) {
      badge_modo.textContent = "Autenticado";
      badge_modo.className = "badge bg-info text-dark";
    } else {
      badge_modo.textContent = "Público";
      badge_modo.className = "badge bg-secondary";
    }
  }

  if (btn_logout) {
    btn_logout.classList.toggle("d-none", !autenticado && rol === "invitado");
  }

  const nombre_corto = (usuario.username || usuario.nombre_completo || "").split(" ")[0];
  if (rol === "admin") {
    if (icono_el) {
      icono_el.textContent = "";
      icono_el.className = "bi bi-shield-check";
    }
    if (texto_el) texto_el.textContent = `Admin · ${nombre_corto || "Empresa"}`;
    if (badge_rol) {
      badge_rol.textContent = "ADMINISTRADOR";
      badge_rol.className = "badge retro-badge-gold";
    }
    ui.establecer_subtitulo_rol("Sesión Administrador · Gestión Total de Flota");
  } else if (rol === "usuario") {
    if (icono_el) {
      icono_el.textContent = "";
      icono_el.className = "bi bi-person-check";
    }
    if (texto_el) texto_el.textContent = `Comprador · ${nombre_corto || "Usuario"}`;
    if (badge_rol) {
      badge_rol.textContent = "COMPRADOR";
      badge_rol.className = "badge retro-badge-gold";
    }
    ui.establecer_subtitulo_rol("Sesión Comprador · Control Privado");
  } else {
    if (icono_el) {
      icono_el.textContent = "";
      icono_el.className = "bi bi-eye-fill";
    }
    if (texto_el) texto_el.textContent = autenticado ? `Invitado · ${nombre_corto}` : "Invitado · Iniciar Sesión";
    if (badge_rol) {
      badge_rol.textContent = "INVITADO";
      badge_rol.className = "badge bg-secondary";
    }
    ui.establecer_subtitulo_rol("Modo Invitado · Demostración de Exhibición");
  }

  const sec_mis_vehiculos = document.getElementById("seccion-mis-vehiculos");
  const sec_catalogo_invitado = document.getElementById("seccion-catalogo-invitado");
  const barra_modo_invitado = document.getElementById("barra-modo-invitado");
  const btn_editor = document.getElementById("btn-toggle-editor-demo");

  if (rol === "invitado") {
    sec_mis_vehiculos?.classList.add("d-none");
    barra_modo_invitado?.classList.toggle("d-none", Boolean(guest_view.sesion_activa));
    if (!guest_view.mostrando_catalogo) {
      sec_catalogo_invitado?.classList.add("d-none");
      document.body.classList.remove("guest-browsing");
    }
    btn_editor?.classList.add("d-none");
    cmd_controller.establecer_bloqueo_invitado(!guest_view.sesion_activa);
    cmd_controller.establecer_filtro_codigos(guest_view.codigos_permitidos || CODIGOS_BASICOS_INVITADO);
  } else {
    sec_mis_vehiculos?.classList.remove("d-none");
    barra_modo_invitado?.classList.add("d-none");
    sec_catalogo_invitado?.classList.add("d-none");
    document.body.classList.remove("guest-browsing", "has-guest-trial");
    btn_editor?.classList.remove("d-none");
    cmd_controller.establecer_bloqueo_invitado(false);
    cmd_controller.establecer_filtro_codigos(null);
  }

  admin_view.renderizar_todo();
}

async function comprobar_conectividad_aws(silencioso = true) {
  if (!silencioso || !api_en_linea) {
    ui.actualizar_indicador_api("connecting", "Comprobando");
  }

  try {
    const salud = await api.verificar_salud_api(5000);
    const estaba_caida = !api_en_linea;
    fallos_consecutivos_api = 0;

    if (!api_en_linea || !silencioso) {
      api_en_linea = true;
      ui.actualizar_indicador_api("online", "Disponible");
    }

    if (salud?.rds_conectada === true) {
      actualizar_rds_autentico(true, false);
    } else if (estaba_caida && !rds_confirmado && catalogo_cargado) {
      monitoring_sync.sincronizar_todo("api_recuperada", { silencioso: true });
    } else if (rds_confirmado) {
      ui.actualizar_indicador_rds("online", "Disponible (SP Verificado)");
    }
  } catch (_err) {
    fallos_consecutivos_api += 1;
    if (!silencioso || fallos_consecutivos_api >= 2) {
      api_en_linea = false;
      rds_confirmado = false;
      ui.actualizar_indicador_api("offline", "No disponible");
      ui.actualizar_indicador_rds("neutral", "Sin verificar (API Caída)");
    }
  }
}

async function cargar_datos_iniciales() {
  await comprobar_conectividad_aws(false);

  try {
    const [vehiculo, comandos, demos_remotas] = await Promise.all([
      api.obtener_vehiculo(config.id_vehiculo),
      api.obtener_comandos(config.id_vehiculo),
      api.obtener_demos(config.id_vehiculo)
    ]);

    const demos = combinar_demos_con_locales(demos_remotas, config.id_vehiculo);
    catalogo_cargado = true;
    actualizar_rds_autentico(true, false);
    ui.actualizar_datos_vehiculo(vehiculo);
    if (vehiculo?.nombre) {
      monitoring_sync.establecer_nombre_vehiculo(vehiculo.nombre);
    }

    cmd_controller.configurar_catalogo(comandos);
    demo_editor.configurar_comandos_unidad(comandos);
    monitoring_sync.establecer_catalogo_demos(demos);
    ui.renderizar_selector_demos(demos);
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      const rol = auth_session.obtener_rol();
      cmd_controller.configurar_catalogo([]);
      ui.renderizar_selector_demos([]);
      if (rol === "invitado") {
        ui.mostrar_estado_accion(
          "espera",
          "Inicia la prueba para activar los controles"
        );
      } else {
        ui.mostrar_estado_accion(
          "error",
          error.message || "Sin autorización de soporte o propiedad para controlar esta unidad."
        );
        mostrar_notificacion(
          error.message || "HTTP 403: No tienes permiso activo para controlar esta unidad.",
          "warning",
          5200
        );
      }
    } else if (error.is_db_error || error.status === 500) {
      actualizar_rds_autentico(false, true);
      ui.mostrar_estado_accion("error", "No se pudieron cargar los controles (Error RDS)");
    } else {
      actualizar_rds_autentico(false, false);
      ui.mostrar_estado_accion("error", "No se pudieron cargar los controles");
    }
  }

  await monitoring_sync.sincronizar_todo("carga_inicial", {
    silencioso: navigation.obtener_vista_actual() !== "monitoreo"
  });
}

// -----------------------------------------------------------------------------
// Autenticación Profesional por Usuario, Contraseña y Rol (Modal Login)
// -----------------------------------------------------------------------------
function obtener_modal_login() {
  const el = document.getElementById("modal-login");
  if (!el || !window.bootstrap?.Modal) return null;
  return window.bootstrap.Modal.getOrCreateInstance(el);
}

function renderizar_directorio_cuentas_login() {
  const cont = document.getElementById("lista-cuentas-login");
  if (!cont) return;

  const cuentas = auth_session.obtener_usuarios_registrados().filter((u) => Boolean(u.activo ?? 1));
  const colores_rol = {
    admin: "bg-warning text-dark",
    usuario: "bg-info text-dark",
    invitado: "bg-secondary"
  };

  cont.innerHTML = cuentas
    .map(
      (c) => `
      <div class="d-flex align-items-center justify-content-between gap-2 p-2 rounded border border-secondary bg-black bg-opacity-50">
        <div class="min-w-0">
          <div class="d-flex align-items-center gap-1">
            <span class="badge ${colores_rol[c.rol] || "bg-secondary"}" style="font-size: 0.65rem;">${esc((c.rol || "usuario").toUpperCase())}</span>
            <strong class="text-light text-truncate">${esc(c.nombre_completo)}</strong>
          </div>
          <div class="text-secondary font-monospace" style="font-size: 0.72rem;">
            Usuario: <span class="text-warning">${esc(c.username || c.email)}</span> · Correo: ${esc(c.email)}
          </div>
        </div>
        <button
          type="button"
          class="btn btn-sm btn-outline-warning py-0 px-2 flex-shrink-0 btn-fill-demo-login"
          data-demo-email="${esc(c.email)}"
          data-demo-pass="${esc(c.clave_acceso || "")}"
        >
          Elegir
        </button>
      </div>
    `
    )
    .join("");

  cont.querySelectorAll(".btn-fill-demo-login").forEach((btn) => {
    btn.addEventListener("click", () => {
      const email_el = document.getElementById("login-email");
      const pass_el = document.getElementById("login-password");
      if (email_el) email_el.value = btn.dataset.demoEmail || "";
      if (pass_el) pass_el.value = btn.dataset.demoPass || "";
      document.getElementById("login-error-alert")?.classList.add("d-none");
    });
  });
}

document.getElementById("btn-abrir-login")?.addEventListener("click", () => {
  document.getElementById("login-error-alert")?.classList.add("d-none");
  renderizar_directorio_cuentas_login();
  obtener_modal_login()?.show();
  setTimeout(() => document.getElementById("login-email")?.focus(), 200);
});

document.getElementById("btn-toggle-login-pass")?.addEventListener("click", () => {
  const pass_el = document.getElementById("login-password");
  const icon_el = document.querySelector("#btn-toggle-login-pass i");
  if (!pass_el) return;
  const mostrar = pass_el.type === "password";
  pass_el.type = mostrar ? "text" : "password";
  if (icon_el) {
    icon_el.className = mostrar ? "bi bi-eye-slash" : "bi bi-eye";
  }
});

window.addEventListener("iot:users-updated", () => {
  renderizar_directorio_cuentas_login();
});

document.getElementById("form-login")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const identificador = document.getElementById("login-email")?.value.trim() || "";
  const password = document.getElementById("login-password")?.value || "";
  const err_box = document.getElementById("login-error-alert");
  const btn_sub = document.getElementById("btn-login-submit");

  if (!identificador || !password) {
    if (err_box) {
      err_box.textContent = "Ingresa tu usuario/correo electrónico y contraseña.";
      err_box.classList.remove("d-none");
    }
    return;
  }

  if (btn_sub) btn_sub.disabled = true;
  err_box?.classList.add("d-none");

  try {
    const res = await auth_session.login(identificador, password);
    if (!res.ok) {
      if (err_box) {
        err_box.textContent = res.error || "Credenciales inválidas.";
        err_box.classList.remove("d-none");
      }
      return;
    }

    obtener_modal_login()?.hide();
    const pass_el = document.getElementById("login-password");
    if (pass_el) {
      pass_el.value = "";
      pass_el.type = "password";
    }
    const rol_etiqueta =
      res.usuario?.rol === "admin"
        ? "Administrador"
        : res.usuario?.rol === "usuario"
          ? "Comprador"
          : "Invitado";
    mostrar_notificacion(
      `Sesión iniciada: ${res.usuario?.nombre_completo} · Rol: ${rol_etiqueta}.`,
      "success"
    );
  } finally {
    if (btn_sub) btn_sub.disabled = false;
  }
});

document.getElementById("btn-cerrar-sesion")?.addEventListener("click", async () => {
  guest_view.limpiar_sesion_local();
  await auth_session.logout();
  mostrar_notificacion("Sesión cerrada correctamente. Modo público de Invitado activo.", "info");
});

window.addEventListener("iot:auth-change", async () => {
  aplicar_rol_en_interfaz();
  const nueva_firma = obtener_firma_sesion();
  if (nueva_firma === firma_sesion_anterior) return;
  firma_sesion_anterior = nueva_firma;

  const rol = auth_session.obtener_rol();
  if (rol === "admin" || rol === "usuario") {
    await admin_view.sincronizar_desde_backend();
    const unidades_visibles = Array.from(
      document.getElementById("select-mis-vehiculos")?.options || []
    )
      .map((o) => Number(o.value))
      .filter((n) => n > 0);
    const destino_id =
      unidades_visibles.length > 0 && !unidades_visibles.includes(Number(config.id_vehiculo))
        ? unidades_visibles[0]
        : Number(config.id_vehiculo || 1);
    await cambiar_vehiculo_activo(destino_id, { forzar: true });
  } else {
    await cambiar_vehiculo_activo(1, { forzar: true });
  }
});

document.getElementById("select-mis-vehiculos")?.addEventListener("change", (e) => {
  const id_nuevo = parseInt(e.target.value, 10);
  if (id_nuevo) {
    cambiar_vehiculo_activo(id_nuevo);
  }
});

// Botones principales de Control y Monitoreo
document.getElementById("btn-emergency-stop")?.addEventListener("click", () => {
  cmd_controller.ejecutar_detener_prioritario("boton de emergencia presionado");
});

document.getElementById("btn-refresh-health")?.addEventListener("click", () => {
  cargar_datos_iniciales();
  if (auth_session.obtener_rol() === "invitado") {
    guest_view.sincronizar_catalogo();
  } else {
    admin_view.sincronizar_desde_backend();
  }
});

document.getElementById("btn-mon-sync")?.addEventListener("click", () => {
  monitoring_sync.sincronizar_todo("boton_actualizar", { silencioso: false });
});

document.getElementById("btn-start-demo")?.addEventListener("click", () => {
  const select_demo = document.getElementById("select-demo");
  const id_demo = select_demo?.value;
  const nombre_demo = select_demo?.selectedOptions?.[0]?.textContent || "";
  if (id_demo) {
    monitoring_sync.registrar_demo_local("ejecutando", nombre_demo);
  }
  demo_controller.iniciar_demo_seleccionada(id_demo);
});

document.getElementById("btn-cancel-demo")?.addEventListener("click", () => {
  demo_controller.cancelar_demo_activa();
});

window.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  const modal_abierto = Boolean(document.querySelector(".modal.show"));
  if (
    !modal_abierto &&
    navigation.obtener_vista_actual() === "control" &&
    e.code === "Space" &&
    tag !== "BUTTON" &&
    tag !== "SELECT" &&
    tag !== "INPUT" &&
    tag !== "TEXTAREA"
  ) {
    e.preventDefault();
    cmd_controller.ejecutar_detener_prioritario("barra espaciadora presionada");
  }
});

// Inicialización general de la aplicación
firma_sesion_anterior = obtener_firma_sesion();
navigation.iniciar();
admin_view.iniciar();
demo_editor.iniciar();
guest_view.iniciar();
renderizar_directorio_cuentas_login();
aplicar_rol_en_interfaz();

ws_client.conectar(config.id_vehiculo);
cargar_datos_iniciales();
if (auth_session.obtener_rol() !== "invitado") {
  admin_view.sincronizar_desde_backend();
}
setInterval(() => comprobar_conectividad_aws(true), config.health_poll_interval_ms);
