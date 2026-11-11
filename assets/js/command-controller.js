import { formatear_nombre_comando } from "./format-utils.js";

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

  _normalizar_texto(texto) {
    return String(texto || "")
      .toLowerCase()
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  _es_giro_por_grados(nom_norm, cod_str) {
    return (
      cod_str === "13" ||
      cod_str === "14" ||
      cod_str === "15" ||
      nom_norm.includes("90") ||
      nom_norm.includes("360") ||
      nom_norm.includes("vuelta")
    );
  }

  _es_izquierda_continua(nom_norm, cod_str) {
    if (this._es_giro_por_grados(nom_norm, cod_str)) return false;
    if (nom_norm.includes("palanca")) return false;
    return (
      cod_str === "8" ||
      cod_str === "l" ||
      nom_norm === "girar izquierda" ||
      nom_norm === "izquierda" ||
      nom_norm.includes("izquierda") ||
      nom_norm.includes("izq")
    );
  }

  _es_derecha_continua(nom_norm, cod_str) {
    if (this._es_giro_por_grados(nom_norm, cod_str)) return false;
    if (nom_norm.includes("palanca")) return false;
    return (
      cod_str === "7" ||
      cod_str === "j" ||
      nom_norm === "girar derecha" ||
      nom_norm === "derecha" ||
      nom_norm.includes("derecha") ||
      nom_norm.includes("der")
    );
  }

  configurar_catalogo(lista_comandos) {
    this.catalogo = Array.isArray(lista_comandos) ? lista_comandos : [];
    this.mapa_direcciones = {};
    this.comando_detener = null;

    this.catalogo.forEach((cmd) => {
      if (!Boolean(cmd.activo ?? 1)) return;
      const nom = this._normalizar_texto(cmd.nombre);
      const cod_str = String(cmd.codigo || "").toLowerCase().trim();

      if (cod_str === "9" || cod_str === "0" || nom.includes("detener") || nom.includes("stop") || nom.includes("parar")) {
        this.comando_detener = cmd;
      } else if (cod_str === "1" || cod_str === "d" || nom.includes("avanzar") || nom.includes("adelante") || nom === "frente") {
        this.mapa_direcciones.up = cmd;
        this.mapa_direcciones.UP = cmd;
      } else if (cod_str === "2" || cod_str === "s" || nom.includes("retroceder") || nom.includes("atras") || nom.includes("reversa")) {
        this.mapa_direcciones.down = cmd;
        this.mapa_direcciones.DOWN = cmd;
      } else if (this._es_izquierda_continua(nom, cod_str)) {
        this.mapa_direcciones.left = cmd;
        this.mapa_direcciones.LEFT = cmd;
      } else if (this._es_derecha_continua(nom, cod_str)) {
        this.mapa_direcciones.right = cmd;
        this.mapa_direcciones.RIGHT = cmd;
      }
    });

    // filtramos el catalogo para la interfaz: excluimos palanca, detener y demo_software
    const comandos_exclusivos = this.catalogo.filter((cmd) => {
      if (!Boolean(cmd.activo ?? 1)) return false;
      const nom = this._normalizar_texto(cmd.nombre);
      const cod_str = String(cmd.codigo || "").toLowerCase().trim();

      const es_detener = cod_str === "9" || cod_str === "0" || nom.includes("detener") || nom.includes("stop") || nom.includes("parar");
      const es_demo_software = cod_str === "12" || cod_str === "r" || nom.includes("demo") || nom.includes("software");
      const es_palanca =
        cod_str === "1" ||
        cod_str === "d" ||
        cod_str === "2" ||
        cod_str === "s" ||
        nom.includes("avanzar") ||
        nom.includes("adelante") ||
        nom === "frente" ||
        nom.includes("retroceder") ||
        nom.includes("atras") ||
        nom.includes("reversa") ||
        this._es_izquierda_continua(nom, cod_str) ||
        this._es_derecha_continua(nom, cod_str);

      return !es_detener && !es_palanca && !es_demo_software;
    });

    // renderizamos en la ui solo los botones exclusivos (brazos, giros 90, vuelta 360, sonido, led, etc.)
    this.ui.renderizar_botones_comandos(comandos_exclusivos, (cmd) => {
      this.solicitar_comando(cmd, false);
    });
  }

  obtener_comando_por_direccion(direccion) {
    const dir_norm = String(direccion || "").toLowerCase().trim();
    if (dir_norm === "neutral") return this.comando_detener;
    return this.mapa_direcciones[dir_norm] || this.mapa_direcciones[direccion] || null;
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
      this.ui.mostrar_estado_accion("error", "Acción detener no disponible");
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
      this.ui.mostrar_estado_accion("error", "Espera a que termine la secuencia");
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

  async _enviar_a_api(cmd, seq_id, es_prioritario, _nota_extra = "") {
    this.solicitud_en_curso = true;
    const nombre_limpio = formatear_nombre_comando(cmd.nombre);
    this.ui.marcar_estado_boton_comando(cmd.id_comando, "sending");
    this.ui.mostrar_estado_accion("solicitado", `Enviando: ${nombre_limpio}`);
    this.ui.actualizar_puntito_actividad("sending", `Enviando ${nombre_limpio}`);

    try {
      const resp = await this.api.enviar_movimiento(cmd.id_comando);

      if (seq_id !== this.secuencia_peticion && !es_prioritario) {
        return;
      }

      const nom_confirmado = formatear_nombre_comando(resp.comando || cmd.nombre);
      this.ui.indicador_rds_confirmado?.();
      this.ui.marcar_estado_boton_comando(cmd.id_comando, "accepted");
      this.ui.mostrar_estado_accion("aceptado", `Orden enviada: ${nom_confirmado}`);
      // evita doble toggle si wss en linea confirmara el evento en vivo
      this.ui.reflejar_comando_visual(
        { codigo: cmd.codigo, nombre: resp.comando || cmd.nombre },
        { alternar_toggles: !this.ui.ws_en_linea }
      );
    } catch (_error) {
      if (seq_id !== this.secuencia_peticion && !es_prioritario) {
        return;
      }
      this.ui.marcar_estado_boton_comando(cmd.id_comando, "error");
      this.ui.mostrar_estado_accion("error", `No se pudo enviar ${nombre_limpio}`);
      this.ui.actualizar_puntito_actividad("error", "Error al enviar", 1800);
    } finally {
      this.solicitud_en_curso = false;
    }
  }
}
