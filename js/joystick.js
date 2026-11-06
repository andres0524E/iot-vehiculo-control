export class VirtualJoystick {
  constructor(zone_el, stick_el, command_controller, ui_manager) {
    this.zone = zone_el;
    this.stick = stick_el;
    this.controller = command_controller;
    this.ui = ui_manager;

    this.active_pointer_id = null;
    this.current_direction = "NEUTRAL";
    this.max_radius = 65;
    this.dead_zone = 22;
    this._ajustar_geometria();
    window.addEventListener("resize", () => this._ajustar_geometria());

    this._bind_events();
  }

  // adapta radio y zona muerta al tamano visual del joystick (misma proporcion que 65/22 en 210px)
  _ajustar_geometria() {
    const r = (this.zone.clientWidth - this.stick.offsetWidth) / 2;
    if (r > 10) {
      this.max_radius = r;
      this.dead_zone = r * 0.34;
    }
  }

  _bind_events() {
    this.zone.addEventListener("pointerdown", (e) => this._on_pointer_down(e));
    this.zone.addEventListener("pointermove", (e) => this._on_pointer_move(e));
    this.zone.addEventListener("pointerup", (e) => this._on_pointer_end(e));
    this.zone.addEventListener("pointercancel", (e) => this._on_pointer_end(e));
    this.zone.addEventListener("lostpointercapture", (e) => this._on_pointer_end(e));

    this.zone.addEventListener("keydown", (e) => this._on_key_down(e));
    this.zone.addEventListener("keyup", (e) => this._on_key_up(e));
  }

  _on_pointer_down(e) {
    if (this.active_pointer_id !== null) return;
    e.preventDefault();
    this._ajustar_geometria();
    this.active_pointer_id = e.pointerId;
    this.zone.setPointerCapture(e.pointerId);
    this.stick.classList.add("dragging");
    this._procesar_posicion(e.clientX, e.clientY);
  }

  _on_pointer_move(e) {
    if (e.pointerId !== this.active_pointer_id) return;
    e.preventDefault();
    this._procesar_posicion(e.clientX, e.clientY);
  }

  _on_pointer_end(e) {
    if (this.active_pointer_id !== null && e.pointerId !== this.active_pointer_id) return;
    this.active_pointer_id = null;
    this.stick.classList.remove("dragging");
    this.stick.style.transform = "translate(0px, 0px)";

    if (this.current_direction !== "NEUTRAL") {
      this.current_direction = "NEUTRAL";
      this.ui.actualizar_etiqueta_joystick("neutral (detener)");
      this.controller.ejecutar_detener_prioritario("joystick liberado a neutral");
    }
  }

  _procesar_posicion(client_x, client_y) {
    const rect = this.zone.getBoundingClientRect();
    const center_x = rect.left + rect.width / 2;
    const center_y = rect.top + rect.height / 2;

    let dx = client_x - center_x;
    let dy = client_y - center_y;
    const distance = Math.hypot(dx, dy);

    if (distance > this.max_radius) {
      const angle = Math.atan2(dy, dx);
      dx = Math.cos(angle) * this.max_radius;
      dy = Math.sin(angle) * this.max_radius;
    }

    this.stick.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;

    const nueva_direccion = this._calcular_direccion(dx, dy, distance);
    if (nueva_direccion !== this.current_direction) {
      this.current_direction = nueva_direccion;
      this._notificar_transicion(nueva_direccion);
    }
  }

  _calcular_direccion(dx, dy, distance) {
    if (distance < this.dead_zone) {
      return "NEUTRAL";
    }
    if (Math.abs(dx) > Math.abs(dy)) {
      return dx > 0 ? "RIGHT" : "LEFT";
    } else {
      return dy > 0 ? "DOWN" : "UP";
    }
  }

  _notificar_transicion(direccion) {
    if (direccion === "NEUTRAL") {
      this.ui.actualizar_etiqueta_joystick("neutral (detener)");
      this.controller.ejecutar_detener_prioritario("retorno a zona neutral");
      return;
    }

    const cmd = this.controller.obtener_comando_por_direccion(direccion);
    if (cmd) {
      this.ui.actualizar_etiqueta_joystick(`${direccion} · ${cmd.nombre}`);
      this.controller.solicitar_comando(cmd, true);
    } else {
      this.ui.actualizar_etiqueta_joystick(`${direccion} (sin comando asignado)`);
    }
  }

  _on_key_down(e) {
    const mapa_teclas = {
      ArrowUp: { dir: "UP", x: 0, y: -50 },
      ArrowDown: { dir: "DOWN", x: 0, y: 50 },
      ArrowLeft: { dir: "LEFT", x: -50, y: 0 },
      ArrowRight: { dir: "RIGHT", x: 50, y: 0 }
    };
    const item = mapa_teclas[e.key];
    if (!item) return;
    const k = this.max_radius * 0.77;
    item.x = Math.sign(item.x) * k;
    item.y = Math.sign(item.y) * k;
    e.preventDefault();
    if (this.current_direction === item.dir) return;

    this.stick.style.transform = `translate(${item.x}px, ${item.y}px)`;
    this.current_direction = item.dir;
    this._notificar_transicion(item.dir);
  }

  _on_key_up(e) {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault();
      this.stick.style.transform = "translate(0px, 0px)";
      if (this.current_direction !== "NEUTRAL") {
        this.current_direction = "NEUTRAL";
        this.ui.actualizar_etiqueta_joystick("neutral (detener)");
        this.controller.ejecutar_detener_prioritario("tecla direccional liberada");
      }
    }
  }
}