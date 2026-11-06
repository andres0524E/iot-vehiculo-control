export class CommandController {
  constructor(api_client, ui_manager) {
    this.api = api_client;
    this.ui = ui_manager;
    this.catalogo = [];
    this.comando_detener = null;
    this.mapa_direcciones = {};
    this.ultimo_comando_enviado_id = null;
    this.solicitud_en_curso = false;
    this.secuencia_peticion = 0;
    this.demo_activa = false;
  }

  configurar_catalogo(lista_comandos) {
    this.catalogo = Array.isArray(lista_comandos) ? lista_comandos : [];
    this.mapa_direcciones = {};
    this.comando_detener = null;

    this.catalogo.forEach((cmd) => {
      if (!Boolean(cmd.activo ?? 1)) return;
      const nom = String(cmd.nombre || "").toUpperCase().trim();

      if (nom.includes("DETENER") || nom.includes("STOP") || nom.includes("PARAR")) {
        this.comando_detener = cmd;
      } else if (nom.includes("AVANZAR") || nom.includes("ADELANTE") || nom === "FRENTE") {
        this.mapa_direcciones.UP = cmd;
      } else if (nom.includes("RETROCEDER") || nom.includes("ATRAS") || nom.includes("REVERSA")) {
        this.mapa_direcciones.DOWN = cmd;
      } else if (nom.includes("IZQUIERDA") && !nom.includes("90") && !nom.includes("360")) {
        this.mapa_direcciones.LEFT = cmd;
      } else if (nom.includes("DERECHA") && !nom.includes("90") && !nom.includes("360")) {
        this.mapa_direcciones.RIGHT = cmd;
      }
    });

    // filtramos el catalogo para la interfaz: excluimos los de la palanca y detener
    // filtramos el catalogo para la interfaz: excluimos palanca, detener y DEMO_SOFTWARE
    const comandos_exclusivos = this.catalogo.filter((cmd) => {
      if (!Boolean(cmd.activo ?? 1)) return false;
      const nom = String(cmd.nombre || "").toUpperCase().trim();
      const es_detener = nom.includes("DETENER") || nom.includes("STOP") || nom.includes("PARAR");
      const es_demo_software = nom.includes("DEMO") || nom.includes("SOFTWARE");
      const es_palanca = 
        nom.includes("AVANZAR") || nom.includes("ADELANTE") || nom === "FRENTE" ||
        nom.includes("RETROCEDER") || nom.includes("ATRAS") || nom.includes("REVERSA") ||
        (nom.includes("IZQUIERDA") && !nom.includes("90") && !nom.includes("360")) ||
        (nom.includes("DERECHA") && !nom.includes("90") && !nom.includes("360"));

      return !es_detener && !es_palanca && !es_demo_software;
    });

    // renderizamos en la ui solo los botones exclusivos (giros 90, 360, sonidos, leds, etc.)
    this.ui.renderizar_botones_comandos(comandos_exclusivos, (cmd) => {
      this.solicitar_comando(cmd, false);
    });
  }

  obtener_comando_por_direccion(direccion) {
    if (direccion === "NEUTRAL") return this.comando_detener;
    return this.mapa_direcciones[direccion] || null;
  }

  async ejecutar_detener_prioritario(razon = "detencion prioritaria solicitada") {
    this.secuencia_peticion += 1;
    const seq_actual = this.secuencia_peticion;
    this.ultimo_comando_enviado_id = this.comando_detener ? this.comando_detener.id_comando : null;

    if (this.demo_activa) {
      try {
        await this.api.cancelar_demo();
      } catch (_e) {
        // continúa
      }
    }

    if (!this.comando_detener) {
      this.ui.mostrar_estado_accion("error", "no existe un comando DETENER activo en el catalogo");
      return;
    }

    await this._enviar_a_api(this.comando_detener, seq_actual, true, razon);
  }

  async solicitar_comando(cmd, desde_joystick = false) {
    if (!cmd) return;

    const es_detener = this.comando_detener && cmd.id_comando === this.comando_detener.id_comando;
    if (es_detener) {
      await this.ejecutar_detener_prioritario("detener solicitado por el usuario");
      return;
    }

    if (this.demo_activa) {
      this.ui.mostrar_estado_accion("error", "bloqueado: hay una demo en ejecucion.");
      return;
    }

    if (desde_joystick && this.ultimo_comando_enviado_id === cmd.id_comando) {
      return;
    }

    this.secuencia_peticion += 1;
    const seq_actual = this.secuencia_peticion;
    this.ultimo_comando_enviado_id = cmd.id_comando;

    await this._enviar_a_api(cmd, seq_actual, false);
  }

  async _enviar_a_api(cmd, seq_id, es_prioritario, nota_extra = "") {
    this.solicitud_en_curso = true;
    this.ui.marcar_estado_boton_comando(cmd.id_comando, "sending");
    this.ui.mostrar_estado_accion(
      "solicitado",
      `solicitado: ${cmd.nombre} (cód ${cmd.codigo}) ${nota_extra ? "· " + nota_extra : ""}`
    );

    try {
      const resp = await this.api.enviar_movimiento(cmd.id_comando);

      if (seq_id !== this.secuencia_peticion && !es_prioritario) {
        return;
      }

      this.ui.indicador_rds_confirmado?.();
      this.ui.marcar_estado_boton_comando(cmd.id_comando, "accepted");
      this.ui.mostrar_estado_accion(
        "aceptado",
        `aceptado por api (http 201): ${resp.comando || cmd.nombre} · esperando wss`
      );
    } catch (error) {
      if (seq_id !== this.secuencia_peticion && !es_prioritario) {
        return;
      }
      this.ui.marcar_estado_boton_comando(cmd.id_comando, "error");
      this.ui.mostrar_estado_accion("error", `fallo al enviar ${cmd.nombre}: ${error.message}`);
    } finally {
      this.solicitud_en_curso = false;
    }
  }
}