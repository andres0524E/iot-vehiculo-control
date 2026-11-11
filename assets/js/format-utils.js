const siglas = new Set(["LED", "LEDS", "USB", "GPS", "RGB", "IA"]);

/**
 * da formato legible para presentacion en pantalla sin alterar datos crudos
 * ej: "GIRAR_DERECHA" -> "Girar Derecha", "giro 90 der" -> "Giro 90 Der"
 */
export function formatear_nombre_comando(nombre) {
  const texto = String(nombre ?? "").trim();
  if (!texto) return "—";
  return texto
    .replace(/_/g, " ")
    .split(/\s+/)
    .map((p) => (siglas.has(p.toUpperCase()) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
    .join(" ");
}

/**
 * extrae de forma segura el nombre legible de un payload wss aunque varie el campo o solo venga codigo/id.
 */
export function resolver_nombre_evento(payload, catalogo = []) {
  const datos = payload?.datos && typeof payload.datos === "object" ? payload.datos : {};
  const directo =
    datos.comando ||
    datos.nombre ||
    datos.movimiento ||
    datos.accion ||
    payload?.comando ||
    payload?.nombre ||
    payload?.movimiento ||
    payload?.accion ||
    "";

  if (String(directo).trim()) {
    return String(directo).trim();
  }

  const cod = datos.codigo ?? payload?.codigo;
  const id_cmd = datos.id_comando ?? payload?.id_comando;
  if (Array.isArray(catalogo) && catalogo.length > 0) {
    const encontrado = catalogo.find(
      (c) =>
        (cod !== undefined && cod !== null && Number(c.codigo) === Number(cod)) ||
        (id_cmd !== undefined && id_cmd !== null && Number(c.id_comando) === Number(id_cmd))
    );
    if (encontrado?.nombre) return String(encontrado.nombre).trim();
  }

  if (cod !== undefined && cod !== null && String(cod).trim() !== "") {
    return `Movimiento ${cod}`;
  }
  return "";
}

/**
 * normaliza timestamps provenientes de fastapi / mysql rds (utc sin sufijo z)
 * o iso-8601 con zona horaria explicita; nunca fabrica marcas temporales.
 */
export function parsear_fecha_utc(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  if (!texto || texto === "null" || texto === "undefined") return null;

  let iso = texto.replace(" ", "T");
  const tiene_zona = /([zZ]|[+-]\d{2}:?\d{2})$/.test(iso);
  if (!tiene_zona && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(iso)) {
    iso = `${iso}Z`;
  }

  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return null;
  return fecha;
}

/**
 * convierte una marca temporal valida a fecha y hora en zona horaria local del navegador.
 */
export function formatear_fecha_hora(valor) {
  const fecha_obj = parsear_fecha_utc(valor);
  if (!fecha_obj) {
    return {
      valido: false,
      ms: 0,
      fecha: "—",
      hora: "—",
      completa: "Sin fecha/hora reportada",
      iso_origen: ""
    };
  }

  const dd = String(fecha_obj.getDate()).padStart(2, "0");
  const mm = String(fecha_obj.getMonth() + 1).padStart(2, "0");
  const yyyy = String(fecha_obj.getFullYear());
  const hh = String(fecha_obj.getHours()).padStart(2, "0");
  const min = String(fecha_obj.getMinutes()).padStart(2, "0");
  const ss = String(fecha_obj.getSeconds()).padStart(2, "0");

  const fecha = `${dd}/${mm}/${yyyy}`;
  const hora = `${hh}:${min}:${ss}`;

  return {
    valido: true,
    ms: fecha_obj.getTime(),
    fecha,
    hora,
    completa: `${fecha} ${hora}`,
    iso_origen: String(valor)
  };
}

/**
 * describe la zona horaria local usada al convertir timestamps utc de aws/rds.
 */
export function obtener_info_zona_horaria() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
    const offset_min = -new Date().getTimezoneOffset();
    const signo = offset_min >= 0 ? "+" : "-";
    const horas = Math.floor(Math.abs(offset_min) / 60);
    const mins = Math.abs(offset_min) % 60;
    const utc_tag = mins > 0 ? `UTC${signo}${horas}:${String(mins).padStart(2, "0")}` : `UTC${signo}${horas}`;
    return `${tz} (${utc_tag})`;
  } catch (_err) {
    return "Hora local del navegador";
  }
}

