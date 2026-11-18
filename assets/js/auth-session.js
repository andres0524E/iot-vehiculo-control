import { config } from "./config.js";

const STORAGE_SESSION_KEY = "iot_vehiculo_session_v3";
const STORAGE_GUEST_TOKEN_KEY = "iot_guest_trial_token";
const STORAGE_USERS_KEY = "iot_usuarios_directorio_v4";
const STORAGE_AUDIT_KEY = "iot_auditoria_operaciones_v3";

const USUARIOS_SEMILLA = [
  {
    id_usuario: 1,
    username: "admin",
    rol: "admin",
    email: "admin@iot.empresa.com",
    nombre_completo: "Administrador General de Flota",
    clave_acceso: "Admin123!*",
    activo: 1
  },
  {
    id_usuario: 2,
    username: "carlos",
    rol: "usuario",
    email: "comprador@cliente.com",
    nombre_completo: "Ing. Carlos Mendoza (Comprador)",
    clave_acceso: "Comprador123!*",
    activo: 1
  },
  {
    id_usuario: 3,
    username: "invitado",
    rol: "invitado",
    email: "invitado@demo.com",
    nombre_completo: "Cliente Visitante (Invitado)",
    clave_acceso: "Invitado123!*",
    activo: 1
  },
  {
    id_usuario: 4,
    username: "sofia",
    rol: "usuario",
    email: "s.rivas@constructora.mx",
    nombre_completo: "Dra. Sofía Rivas (Constructora)",
    clave_acceso: "CompradorB123!*",
    activo: 1
  }
];

/**
 * Gestor profesional de autenticación y directorio de usuarios por rol (RBAC).
 * Soporta login vía FastAPI JWT (/auth/login, /auth/logout) y directorio persistente
 * con verificación estricta de usuario/correo + contraseña y bitácora de auditoría.
 */
export class AuthSessionManager {
  constructor(api_client) {
    this.api = api_client;
    this.storage_key = STORAGE_SESSION_KEY;
    this.guest_storage_key = STORAGE_GUEST_TOKEN_KEY;
    this.users_storage_key = STORAGE_USERS_KEY;
    this.audit_storage_key = STORAGE_AUDIT_KEY;

    this.usuarios_registrados = this._cargar_directorio_usuarios();
    this.sesion_actual = this._cargar_sesion_inicial();
    this.guest_token = this._cargar_guest_token();

    if (typeof this.api?.establecer_proveedor_auth === "function") {
      this.api.establecer_proveedor_auth(
        () => this.obtener_token_para_api(),
        () => this.obtener_guest_token()
      );
    }

    window.addEventListener("iot:auth-expired", () => {
      if (this.sesion_actual?.modo === "backend_jwt") {
        this._guardar_sesion(this._crear_sesion_invitado_publico("Sesión expirada"));
      }
    });
  }

  _crear_sesion_invitado_publico(motivo = "") {
    return {
      id_usuario: 3,
      username: "invitado",
      rol: "invitado",
      email: "invitado@demo.com",
      nombre_completo: motivo ? `Visitante (${motivo})` : "Visitante (Acceso Público)",
      token: "",
      autenticado: false,
      modo: "local"
    };
  }

  _cargar_directorio_usuarios() {
    try {
      const guardado = localStorage.getItem(this.users_storage_key);
      if (guardado) {
        const parsed = JSON.parse(guardado);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (_e) {}

    const inicial = USUARIOS_SEMILLA.map((u) => ({ ...u }));
    this._guardar_directorio_usuarios(inicial);
    return inicial;
  }

  _guardar_directorio_usuarios(lista) {
    this.usuarios_registrados = Array.isArray(lista) ? lista : [];
    try {
      localStorage.setItem(this.users_storage_key, JSON.stringify(this.usuarios_registrados));
    } catch (_e) {}
    window.dispatchEvent(new CustomEvent("iot:users-updated"));
  }

  obtener_usuarios_registrados() {
    this.usuarios_registrados = this._cargar_directorio_usuarios();
    return [...this.usuarios_registrados]
      .sort((a, b) => Number(a.id_usuario) - Number(b.id_usuario))
      .map((u) => ({
        id_usuario: u.id_usuario,
        username: u.username || u.email.split("@")[0],
        email: u.email,
        nombre_completo: u.nombre_completo,
        rol: u.rol || "usuario",
        activo: Number(u.activo ?? 1),
        clave_acceso: u.clave_acceso || ""
      }));
  }

  registrar_usuario({ nombre_completo, email, username = "", password, rol = "usuario" }) {
    const nombre_limpio = String(nombre_completo || "").trim();
    const email_limpio = String(email || "").trim().toLowerCase();
    const user_limpio = String(username || email_limpio.split("@")[0] || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
    const pass_str = String(password || "");
    const rol_limpio = ["admin", "usuario", "invitado"].includes(rol) ? rol : "usuario";

    if (!nombre_limpio || !email_limpio || pass_str.length < 8) {
      throw new Error("Nombre, correo y contraseña de mínimo 8 caracteres son obligatorios.");
    }

    const lista = this._cargar_directorio_usuarios();
    const duplicado = lista.find(
      (u) =>
        u.email.toLowerCase() === email_limpio ||
        (u.username && u.username.toLowerCase() === user_limpio)
    );
    if (duplicado) {
      throw new Error("Ya existe un usuario registrado con ese correo o nombre de usuario.");
    }

    const nuevo_id = Math.max(4, ...lista.map((u) => Number(u.id_usuario) || 0)) + 1;
    const nuevo = {
      id_usuario: nuevo_id,
      username: user_limpio,
      email: email_limpio,
      nombre_completo: nombre_limpio,
      rol: rol_limpio,
      clave_acceso: pass_str,
      activo: 1
    };

    lista.push(nuevo);
    this._guardar_directorio_usuarios(lista);
    this.registrar_evento_auditoria("ALTA_USUARIO", "USUARIO", nuevo_id, {
      email: email_limpio,
      username: user_limpio,
      rol: rol_limpio
    });
    return nuevo;
  }

  actualizar_usuario(id_usuario, cambios = {}) {
    const lista = this._cargar_directorio_usuarios();
    const idx = lista.findIndex((u) => Number(u.id_usuario) === Number(id_usuario));
    if (idx === -1) {
      throw new Error("Usuario no encontrado.");
    }

    const actual = lista[idx];
    if (cambios.nombre_completo !== undefined) {
      actual.nombre_completo = String(cambios.nombre_completo).trim() || actual.nombre_completo;
    }
    if (cambios.email !== undefined) {
      const nuevo_email = String(cambios.email).trim().toLowerCase();
      if (
        nuevo_email &&
        lista.some((u, i) => i !== idx && u.email.toLowerCase() === nuevo_email)
      ) {
        throw new Error("Ese correo ya pertenece a otra cuenta.");
      }
      if (nuevo_email) actual.email = nuevo_email;
    }
    if (cambios.username !== undefined) {
      const nuevo_user = String(cambios.username).trim().toLowerCase();
      if (nuevo_user) actual.username = nuevo_user;
    }
    if (cambios.rol !== undefined && ["admin", "usuario", "invitado"].includes(cambios.rol)) {
      actual.rol = cambios.rol;
    }
    if (cambios.password !== undefined && String(cambios.password).length >= 8) {
      actual.clave_acceso = String(cambios.password);
    }
    if (cambios.activo !== undefined) {
      actual.activo = cambios.activo ? 1 : 0;
    }

    lista[idx] = actual;
    this._guardar_directorio_usuarios(lista);
    this.registrar_evento_auditoria("ACTUALIZAR_USUARIO", "USUARIO", id_usuario, {
      email: actual.email,
      rol: actual.rol,
      activo: actual.activo
    });

    if (
      Number(this.sesion_actual?.id_usuario) === Number(id_usuario) &&
      !Boolean(actual.activo)
    ) {
      this._guardar_sesion(this._crear_sesion_invitado_publico("Cuenta desactivada"));
    }

    return actual;
  }

  obtener_auditoria_local() {
    try {
      const raw = localStorage.getItem(this.audit_storage_key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_e) {}

    const semilla_audit = [
      {
        id_auditoria: 1,
        id_usuario: 1,
        email_usuario: "admin@iot.empresa.com",
        accion: "INICIALIZAR_SISTEMA_RBAC",
        entidad_afectada: "SISTEMA",
        id_entidad: 1,
        detalles_json: { roles: ["admin", "usuario", "invitado"], modo: "Control + Monitoreo + Administración" },
        fecha_hora: new Date().toISOString()
      }
    ];
    try {
      localStorage.setItem(this.audit_storage_key, JSON.stringify(semilla_audit));
    } catch (_e) {}
    return semilla_audit;
  }

  registrar_evento_auditoria(accion, entidad_afectada = "SISTEMA", id_entidad = 1, detalles = {}) {
    const bitacora = this.obtener_auditoria_local();
    const actor = this.sesion_actual || {};
    const nuevo_evento = {
      id_auditoria: Date.now() + Math.floor(Math.random() * 100),
      id_usuario: actor.id_usuario || 3,
      email_usuario: actor.email || "invitado@demo.com",
      nombre_usuario: actor.nombre_completo || "Visitante",
      accion,
      entidad_afectada,
      id_entidad,
      detalles_json: detalles,
      fecha_hora: new Date().toISOString()
    };
    bitacora.unshift(nuevo_evento);
    const recortada = bitacora.slice(0, 80);
    try {
      localStorage.setItem(this.audit_storage_key, JSON.stringify(recortada));
    } catch (_e) {}
    return nuevo_evento;
  }

  _cargar_sesion_inicial() {
    try {
      const guardada = sessionStorage.getItem(this.storage_key);
      if (guardada) {
        return JSON.parse(guardada);
      }
    } catch (_e) {}
    return this._crear_sesion_invitado_publico();
  }

  _cargar_guest_token() {
    try {
      return sessionStorage.getItem(this.guest_storage_key) || "";
    } catch (_e) {
      return "";
    }
  }

  _guardar_sesion(nueva_sesion) {
    this.sesion_actual = { ...nueva_sesion };
    try {
      sessionStorage.setItem(this.storage_key, JSON.stringify(this.sesion_actual));
    } catch (_e) {}
    window.dispatchEvent(
      new CustomEvent("iot:auth-change", { detail: { sesion: this.sesion_actual } })
    );
  }

  establecer_guest_token(token) {
    this.guest_token = token || "";
    try {
      if (this.guest_token) {
        sessionStorage.setItem(this.guest_storage_key, this.guest_token);
      } else {
        sessionStorage.removeItem(this.guest_storage_key);
      }
    } catch (_e) {}
  }

  obtener_guest_token() {
    return this.guest_token || "";
  }

  obtener_rol() {
    return this.sesion_actual?.rol || "invitado";
  }

  obtener_usuario() {
    return this.sesion_actual;
  }

  esta_autenticado() {
    return Boolean(this.sesion_actual?.autenticado);
  }

  obtener_token() {
    return this.sesion_actual?.token || "";
  }

  obtener_token_para_api() {
    if (this.sesion_actual?.modo === "backend_jwt" && this.sesion_actual?.token) {
      return this.sesion_actual.token;
    }
    return "";
  }

  es_modo_backend_jwt() {
    return this.sesion_actual?.modo === "backend_jwt";
  }

  async cambiar_rol_demo(rol) {
    const lista = this._cargar_directorio_usuarios();
    const cuenta = lista.find((u) => u.rol === rol && Boolean(u.activo ?? 1));
    if (!cuenta) return { ok: false, error: "No hay una cuenta activa para ese rol." };
    return await this.login(cuenta.email, cuenta.clave_acceso);
  }

  async login(identificador, password, _opciones = {}) {
    const id_norm = String(identificador || "").trim().toLowerCase();
    const pass_str = String(password || "");
    if (!id_norm || !pass_str) {
      return { ok: false, error: "Ingresa tu usuario/correo y contraseña." };
    }

    const lista = this._cargar_directorio_usuarios();
    const candidato_local = lista.find(
      (c) =>
        c.email.toLowerCase() === id_norm ||
        (c.username && c.username.toLowerCase() === id_norm)
    );
    const email_para_api = candidato_local ? candidato_local.email.toLowerCase() : id_norm;

    try {
      const resp = await this.api.post(config.endpoints.auth_login, {
        email: email_para_api,
        password: pass_str
      });
      if (resp && resp.access_token && resp.usuario) {
        this._guardar_sesion({
          id_usuario: resp.usuario.id_usuario,
          username: resp.usuario.email.split("@")[0],
          rol: resp.usuario.rol,
          email: resp.usuario.email,
          nombre_completo: resp.usuario.nombre_completo,
          token: resp.access_token,
          expira_en: resp.expira_en,
          autenticado: true,
          modo: "backend_jwt"
        });
        this.registrar_evento_auditoria("LOGIN_EXITOSO", "SESION", resp.usuario.id_usuario, {
          email: resp.usuario.email,
          rol: resp.usuario.rol,
          modo: "JWT_AWS"
        });
        return { ok: true, usuario: this.sesion_actual, modo: "backend_jwt" };
      }
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403 || err.status === 422)) {
        this.registrar_evento_auditoria("LOGIN_FALLIDO", "SESION", 0, {
          intento: email_para_api,
          codigo_http: err.status
        });
        return { ok: false, error: err.message || "Credenciales inválidas." };
      }
    }

    if (!candidato_local || candidato_local.clave_acceso !== pass_str) {
      this.registrar_evento_auditoria("LOGIN_FALLIDO", "SESION", 0, {
        intento: id_norm,
        motivo: "Credenciales incorrectas"
      });
      return {
        ok: false,
        error: "Usuario/correo o contraseña incorrectos. Verifica tus datos."
      };
    }

    if (!Boolean(candidato_local.activo ?? 1)) {
      this.registrar_evento_auditoria(
        "LOGIN_BLOQUEADO_INACTIVO",
        "USUARIO",
        candidato_local.id_usuario,
        { email: candidato_local.email }
      );
      return {
        ok: false,
        error: "HTTP 403 Prohibido: Esta cuenta fue desactivada por el Administrador."
      };
    }

    this._guardar_sesion({
      id_usuario: candidato_local.id_usuario,
      username: candidato_local.username || candidato_local.email.split("@")[0],
      rol: candidato_local.rol,
      email: candidato_local.email,
      nombre_completo: candidato_local.nombre_completo,
      token: `jwt_local_${candidato_local.id_usuario}_${candidato_local.rol}`,
      autenticado: true,
      modo: "local"
    });

    this.registrar_evento_auditoria("LOGIN_EXITOSO", "SESION", candidato_local.id_usuario, {
      email: candidato_local.email,
      rol: candidato_local.rol,
      modo: "Autenticación RBAC"
    });

    return { ok: true, usuario: this.sesion_actual, modo: "local" };
  }

  async logout() {
    const prev = this.sesion_actual;
    if (this.es_modo_backend_jwt()) {
      try {
        await this.api.post(config.endpoints.auth_logout);
      } catch (_e) {}
    }
    this.registrar_evento_auditoria("LOGOUT", "SESION", prev?.id_usuario || 3, {
      email: prev?.email || "invitado@demo.com",
      rol_previo: prev?.rol || "invitado"
    });
    this.establecer_guest_token("");
    this._guardar_sesion(this._crear_sesion_invitado_publico());
  }
}
