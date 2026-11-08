import { config } from "./config.js";
import { ApiClient } from "./api-client.js";
import { WsClient } from "./ws-client.js";
import { UiManager } from "./ui-manager.js";
import { CommandController } from "./command-controller.js";
import { VirtualJoystick } from "./joystick.js";
import { DemoController } from "./demo-controller.js";

const api = new ApiClient();
const ui = new UiManager();
const cmd_controller = new CommandController(api, ui);
const demo_controller = new DemoController(api, ui, cmd_controller);

let api_en_linea = false;
let rds_confirmado = false;
let fallos_consecutivos_api = 0;

ui.indicador_rds_confirmado = () => {
  rds_confirmado = true;
  ui.actualizar_indicador_rds("online", "Disponible (SP Verificado)");
};

const joystick_zone = document.getElementById("joystick-zone");
const joystick_stick = document.getElementById("joystick-stick");
new VirtualJoystick(joystick_zone, joystick_stick, cmd_controller, ui);

const ws_client = new WsClient(
  (estado, texto) => {
    ui.actualizar_indicador_ws(estado, texto);
  },
  (payload) => {
    const ev = payload.evento || "mensaje";
    const ts = payload.timestamp ? payload.timestamp.split("T")[1]?.slice(0, 8) : "";
    const datos = payload.datos || {};

    if (ev === "estado_inicial") {
      ui.mostrar_evento_ws(`wss [${ts}] estado_inicial recibido (vehiculo ${payload.id_vehiculo})`);
    } else if (ev === "movimiento_individual") {
      ui.mostrar_evento_ws(
        `wss [${ts}] mov_individual: ${datos.comando} (cód ${datos.codigo}) · vehiculo ${payload.id_vehiculo}`
      );
      ui.mostrar_estado_accion(
        "evento",
        `evento wss recibido: ${datos.comando} (cód ${datos.codigo}) publicado por el backend`
      );
    } else if (ev.startsWith("demo_")) {
      ui.mostrar_evento_ws(`wss [${ts}] ${ev} recibido`);
      demo_controller.procesar_evento_ws_demo(ev, datos);
    }
  }
);

async function comprobar_conectividad_aws(silencioso = true) {
  if (!silencioso || !api_en_linea) {
    ui.actualizar_indicador_api("connecting", "Comprobando");
  }

  try {
    const salud = await api.verificar_salud_api(5000);
    fallos_consecutivos_api = 0;

    if (!api_en_linea || !silencioso) {
      api_en_linea = true;
      if (salud && salud.estado === "operativo") {
        ui.actualizar_indicador_api("online", "Disponible");
      } else {
        ui.actualizar_indicador_api("online", "Disponible");
      }
    }

    if (rds_confirmado) {
      ui.actualizar_indicador_rds("online", "Disponible (SP Verificado)");
    }
  } catch (_err) {
    fallos_consecutivos_api += 1;

    // protege contra microcortes de red: solo marca caida tras 2 fallos seguidos o en chequeo manual
    if (!silencioso || fallos_consecutivos_api >= 2) {
      api_en_linea = false;
      ui.actualizar_indicador_api("offline", "No disponible");
      if (!rds_confirmado) {
        ui.actualizar_indicador_rds("neutral", "Sin verificar (API Caída)");
      }
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
    rds_confirmado = true;
    ui.actualizar_indicador_rds("online", "Disponible (SP Verificado)");
    ui.actualizar_datos_vehiculo(vehiculo);

    // configura el catalogo y renderiza unicamente los botones exclusivos (excluyendo joystick y detener)
    cmd_controller.configurar_catalogo(comandos);

    ui.renderizar_selector_demos(demos);
  } catch (error) {
    if (error.is_db_error || error.status === 500) {
      rds_confirmado = false;
      ui.actualizar_indicador_rds("offline", "No disponible (Error SP/RDS)");
    } else if (!rds_confirmado) {
      ui.actualizar_indicador_rds("neutral", "Sin verificar");
    }
    ui.mostrar_estado_accion("error", `no se pudo cargar el catalogo inicial: ${error.message}`);
  }
}

// eventos de botones principales
document.getElementById("btn-emergency-stop").addEventListener("click", () => {
  cmd_controller.ejecutar_detener_prioritario("boton de emergencia presionado");
});

document.getElementById("btn-refresh-health").addEventListener("click", () => {
  cargar_datos_iniciales();
});

document.getElementById("btn-start-demo").addEventListener("click", () => {
  const id_demo = document.getElementById("select-demo").value;
  demo_controller.iniciar_demo_seleccionada(id_demo);
});

document.getElementById("btn-cancel-demo").addEventListener("click", () => {
  demo_controller.cancelar_demo_activa();
});

// barra espaciadora como atajo global de detencion prioritaria
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement.tagName !== "BUTTON") {
    e.preventDefault();
    cmd_controller.ejecutar_detener_prioritario("barra espaciadora presionada");
  }
});

// inicio de aplicacion
ws_client.conectar(config.id_vehiculo);
cargar_datos_iniciales();
setInterval(() => comprobar_conectividad_aws(true), config.health_poll_interval_ms);
