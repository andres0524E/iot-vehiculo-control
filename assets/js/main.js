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
import { formatear_fecha_hora, formatear_nombre_comando, resolver_nombre_evento } from "./format-utils.js";

const api = new ApiClient();
const ui = new UiManager();
const cmd_controller = new CommandController(api, ui);
const demo_controller = new DemoController(api, ui, cmd_controller);
const monitoring_view = new MonitoringView();

let api_en_linea = false;
let rds_confirmado = false;
let fallos_consecutivos_api = 0;
let catalogo_cargado = false;

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
  }
});

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
    // al reconectar wss, resincroniza rest para recuperar movimientos perdidos
    monitoring_sync.sincronizar_todo("reconexion_wss", { silencioso: true });
  }
);

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
      if (salud && salud.estado === "operativo") {
        ui.actualizar_indicador_api("online", "Disponible");
      } else {
        ui.actualizar_indicador_api("online", "Disponible");
      }
    }

    if (estaba_caida && !rds_confirmado && catalogo_cargado) {
      monitoring_sync.sincronizar_todo("api_recuperada", { silencioso: true });
    } else if (rds_confirmado) {
      ui.actualizar_indicador_rds("online", "Disponible (SP Verificado)");
    }
  } catch (_err) {
    fallos_consecutivos_api += 1;

    // protege contra microcortes de red: solo marca caida tras 2 fallos seguidos o en chequeo manual
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
    const [vehiculo, comandos, demos] = await Promise.all([
      api.obtener_vehiculo(config.id_vehiculo),
      api.obtener_comandos(config.id_vehiculo),
      api.obtener_demos(config.id_vehiculo)
    ]);

    // rds verificado correctamente mediante stored procedures
    catalogo_cargado = true;
    actualizar_rds_autentico(true, false);
    ui.actualizar_datos_vehiculo(vehiculo);
    if (vehiculo?.nombre) {
      monitoring_sync.establecer_nombre_vehiculo(vehiculo.nombre);
    }

    // configura el catalogo y renderiza unicamente los botones exclusivos (excluyendo joystick y detener)
    cmd_controller.configurar_catalogo(comandos);

    monitoring_sync.establecer_catalogo_demos(demos);
    ui.renderizar_selector_demos(demos);
  } catch (error) {
    if (error.is_db_error || error.status === 500) {
      actualizar_rds_autentico(false, true);
    } else {
      actualizar_rds_autentico(false, false);
    }
    ui.mostrar_estado_accion("error", "No se pudieron cargar los controles");
  }

  // carga inicial de estado e historial para monitoreo
  await monitoring_sync.sincronizar_todo("carga_inicial", {
    silencioso: navigation.obtener_vista_actual() !== "monitoreo"
  });
}

// eventos de botones principales
document.getElementById("btn-emergency-stop").addEventListener("click", () => {
  cmd_controller.ejecutar_detener_prioritario("boton de emergencia presionado");
});

document.getElementById("btn-refresh-health").addEventListener("click", () => {
  cargar_datos_iniciales();
});

document.getElementById("btn-mon-sync").addEventListener("click", () => {
  monitoring_sync.sincronizar_todo("boton_actualizar", { silencioso: false });
});

document.getElementById("btn-start-demo").addEventListener("click", () => {
  const select_demo = document.getElementById("select-demo");
  const id_demo = select_demo.value;
  const nombre_demo = select_demo.selectedOptions?.[0]?.textContent || "";
  if (id_demo) {
    monitoring_sync.registrar_demo_local("ejecutando", nombre_demo);
  }
  demo_controller.iniciar_demo_seleccionada(id_demo);
});

document.getElementById("btn-cancel-demo").addEventListener("click", () => {
  demo_controller.cancelar_demo_activa();
});

// barra espaciadora como atajo global de detencion prioritaria en vista control
window.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (
    navigation.obtener_vista_actual() === "control" &&
    e.code === "Space" &&
    tag !== "BUTTON" &&
    tag !== "SELECT" &&
    tag !== "INPUT"
  ) {
    e.preventDefault();
    cmd_controller.ejecutar_detener_prioritario("barra espaciadora presionada");
  }
});

// inicio de aplicacion
navigation.iniciar();
ws_client.conectar(config.id_vehiculo);
cargar_datos_iniciales();
setInterval(() => comprobar_conectividad_aws(true), config.health_poll_interval_ms);
