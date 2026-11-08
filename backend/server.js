const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
require('dotenv').config();
const db = require('./db');
const { NOTA_MINIMA, num, periodoActual, resumenNotas } = require('./academico');
const excel = require('./excel');

const PORT = process.env.PORT || 5000;
// URL pública (QR del certificado y confirmación de ePayco). Si PUBLIC_URL no es una URL válida se ignora
// sin imprimirla (podría ser una clave pegada por error) y se usa la que Render define sola.
let urlPublica = process.env.PUBLIC_URL || '';
if (urlPublica && !/^https?:\/\/[^\s/]+/.test(urlPublica)) {
    console.error('❌ PUBLIC_URL no es una URL (debe empezar con https://): se ignora. Corrígela en las variables de entorno.');
    urlPublica = '';
}
const PUBLIC_URL = (urlPublica || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PRECIO_CERTIFICADO = 25000;
const LICENCIA = 'Resolución 002844';
// Datos del RUT de CEPDECO
const RAZON_SOCIAL = 'Corporación Educativa para el Desarrollo de Colombia LTDA';
const NIT = '901.564.263-9';
// Firma del certificado. PENDIENTE: autorización de CEPDECO para usar el nombre.
// Para quitarla del PDF: const FIRMA_CERTIFICADO = null;
const FIRMA_CERTIFICADO = { nombre: 'Edenia Ayola Ortega', cargo: 'Directora General' };
// Admin puede marcar pagos como aprobados a mano (pruebas / pago en secretaría). Se apaga con PAGO_MANUAL=off
const PAGO_MANUAL = process.env.PAGO_MANUAL !== 'off';
// Aviso "Versión de demostración" en el portal. Se apaga con MODO_DEMO=off (cuando sea oficial)
const MODO_DEMO = process.env.MODO_DEMO !== 'off';

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    if (process.env.NODE_ENV === 'production') {
        console.error('❌ Falta JWT_SECRET en producción');
        process.exit(1);
    }
    JWT_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('⚠️  JWT_SECRET no definido: se generó uno temporal (las sesiones se pierden al reiniciar).');
}

const app = express();
// Cabeceras de seguridad (sin CORS: el portal y la API están en el mismo dominio, así otros sitios no pueden leer sus respuestas)
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});
// Render pone el servidor detrás de un proxy: así req.ip es la IP real del visitante
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Imágenes y fuentes casi nunca cambian: el navegador las guarda 7 días (si se cambia un logo, se ve al vencer o con Ctrl+F5)
for (const carpeta of ['img', 'fonts']) app.use(`/${carpeta}`, express.static(path.join(__dirname, 'public', carpeta), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Utilidades ----------
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nuevaReferencia = (usuarioId) => `CEP-${Date.now()}-${usuarioId}-${crypto.randomBytes(2).toString('hex')}`;

function auth(req, res, next) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Sesión requerida' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
    } catch {
        return res.status(401).json({ success: false, message: 'Sesión inválida o expirada' });
    }
    // Sin aceptar los documentos legales solo se permite consultar la sesión y aceptarlos
    if (req.user.aceptarLegal && !['/api/auth/me', '/api/legal/aceptar'].includes(req.path)) {
        return res.status(403).json({ success: false, message: 'Debes aceptar los Términos de uso y la Política de Tratamiento de Datos para continuar' });
    }
    // Con clave temporal solo se permite consultar la sesión y cambiar la clave
    if (req.user.cambiarClave && !['/api/auth/me', '/api/auth/cambiar-clave'].includes(req.path)) {
        return res.status(403).json({ success: false, message: 'Debes cambiar tu contraseña temporal antes de continuar' });
    }
    next();
}

// Versión vigente de los documentos legales. Al cambiarla, todos deben aceptarlos de nuevo al entrar.
const VERSION_LEGAL = '0.1';
const aceptoLegal = async (usuarioId) =>
    (await db.query('SELECT 1 FROM aceptaciones_legales WHERE usuario_id = $1 AND version = $2', [usuarioId, VERSION_LEGAL])).rowCount > 0;

const firmarSesion = (u) => {
    const perfil = { id: u.id, username: u.username, nombre: u.nombre_completo, email: u.email, rol: u.rol, cambiarClave: !!u.debe_cambiar_clave, aceptarLegal: !u.acepto_legal };
    return { token: jwt.sign(perfil, JWT_SECRET, { expiresIn: '8h' }), user: perfil };
};

const rol = (...roles) => (req, res, next) =>
    roles.includes(req.user.rol)
        ? next()
        : res.status(403).json({ success: false, message: 'No tienes permiso para esta acción' });

// Error con código HTTP (lo responde el manejador de errores del final)
const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------- Validación de datos personales (crear, editar y carga masiva) ----------
const RE_USUARIO = /^[A-Za-z0-9._-]{3,40}$/;
const RE_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RE_DOCUMENTO = /^[0-9A-Za-z-]{4,20}$/;
const RE_TELEFONO = /^[0-9 +()-]{7,20}$/;
const RE_PERIODO = /^\d{4}-[AB]$/;

// Devuelve { errores, datos } con los campos limpios; documento y teléfono son opcionales (vacío = null)
function validarPersona(d) {
    const errores = [];
    const datos = {
        nombre_completo: String(d.nombre_completo ?? '').trim().replace(/\s+/g, ' '),
        email: String(d.email ?? '').trim().toLowerCase(),
        tipo_documento: String(d.tipo_documento ?? '').trim().toUpperCase() || null,
        documento: String(d.documento ?? '').replace(/[.\s]/g, '').trim() || null,
        telefono: String(d.telefono ?? '').trim() || null
    };
    if (datos.nombre_completo.length < 3 || datos.nombre_completo.length > 120) errores.push('El nombre completo debe tener entre 3 y 120 caracteres');
    if (!RE_CORREO.test(datos.email) || datos.email.length > 120) errores.push('El correo no es válido');
    if (datos.documento && !RE_DOCUMENTO.test(datos.documento)) errores.push('El documento solo admite números, letras y guion (4 a 20)');
    if (datos.documento && !excel.TIPOS_DOCUMENTO.includes(datos.tipo_documento)) errores.push(`Elige el tipo de documento (${excel.TIPOS_DOCUMENTO.join(', ')})`);
    if (!datos.documento) datos.tipo_documento = null;
    if (datos.telefono && !RE_TELEFONO.test(datos.telefono)) errores.push('El teléfono solo admite números, espacios, +, guion y paréntesis (7 a 20)');
    return { errores, datos };
}

// Clave temporal aleatoria, sin caracteres que se confunden (0/O, 1/l/I)
const ALFABETO_CLAVE = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const claveTemporal = () => Array.from({ length: 10 }, () => ALFABETO_CLAVE[crypto.randomInt(ALFABETO_CLAVE.length)]).join('');

// Recibe un .xlsx como cuerpo binario (máx. 2 MB)
const subirExcel = express.raw({ type: () => true, limit: '2mb' });

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// ---------- Salud ----------
app.get('/api/health', async (req, res) => {
    try {
        const result = await db.query('SELECT NOW()');
        res.json({
            status: 'OK',
            message: 'Servidor Backend y Base de Datos Supabase conectados correctamente',
            time: result.rows[0].now
        });
    } catch (error) {
        console.error('❌ /api/health: no se pudo conectar a la BD:', error.message);
        res.status(500).json({ status: 'ERROR', message: 'Error conectando a la BD' });
    }
});

// ---------- Autenticación ----------
// Límite de intentos fallidos cada 15 minutos: 10 por usuario y 40 por conexión (IP).
// El de la IP es más alto porque en la sede muchos estudiantes comparten la misma conexión a internet.
const VENTANA_LOGIN = 15 * 60 * 1000;
const MAX_FALLOS = { u: 10, ip: 40 };
const fallosLogin = new Map(); // clave -> { n, desde }
const bloqueado = (k) => { const f = fallosLogin.get(k); return f && Date.now() - f.desde < VENTANA_LOGIN && f.n >= MAX_FALLOS[k.split(':')[0]]; };
function registrarFallo(k) {
    const f = fallosLogin.get(k);
    if (!f || Date.now() - f.desde >= VENTANA_LOGIN) fallosLogin.set(k, { n: 1, desde: Date.now() });
    else f.n++;
}
setInterval(() => { for (const [k, f] of fallosLogin) if (Date.now() - f.desde >= VENTANA_LOGIN) fallosLogin.delete(k); }, VENTANA_LOGIN).unref();
// Hash de relleno: si el usuario no existe se compara igual, para no revelar qué usuarios existen por el tiempo de respuesta
const HASH_RELLENO = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Usuario y contraseña son obligatorios' });
    }
    const claveIp = 'ip:' + req.ip;
    const claveUsuario = 'u:' + String(username).trim().toLowerCase();
    if (bloqueado(claveIp) || bloqueado(claveUsuario)) {
        return res.status(429).json({ success: false, message: 'Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.' });
    }

    const result = await db.query(
        `SELECT u.id, u.username, u.nombre_completo, u.email, u.password_hash, u.debe_cambiar_clave, r.nombre AS rol
         FROM usuarios u JOIN roles r ON u.rol_id = r.id
         WHERE LOWER(u.username) = LOWER($1)`,
        [String(username).trim()]
    );
    const user = result.rows[0];
    const fallo = () => {
        registrarFallo(claveIp);
        registrarFallo(claveUsuario);
        return res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
    };
    if (!user) { await bcrypt.compare(String(password), HASH_RELLENO); return fallo(); }

    let ok;
    if (user.password_hash.startsWith('$2')) {
        ok = await bcrypt.compare(String(password), user.password_hash);
    } else {
        // Usuario heredado con clave en texto plano: valida y la migra a bcrypt
        ok = safeEqual(user.password_hash, password);
        if (ok) {
            const nuevo = await bcrypt.hash(String(password), 10);
            await db.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [nuevo, user.id]);
        }
    }
    if (!ok) return fallo();

    fallosLogin.delete(claveUsuario);
    res.json({ success: true, ...firmarSesion({ ...user, acepto_legal: await aceptoLegal(user.id) }) });
});

app.get('/api/auth/me', auth, (req, res) => res.json({ success: true, user: req.user }));

// Configuración pública del portal (el frontend muestra el aviso de demostración si demo = true)
app.get('/api/config', (req, res) => res.json({ demo: MODO_DEMO }));

// Información pública: cursos que ofrece CEPDECO (para el inicio y el login)
app.get('/api/programas', async (req, res) => {
    const r = await db.query('SELECT id, nombre, resolucion FROM programas ORDER BY nombre');
    res.json({ success: true, programas: r.rows });
});

// Datos del usuario en sesión (Mis datos personales / Mi programa)
app.get('/api/perfil', auth, async (req, res) => {
    const r = await db.query(
        `SELECT u.username, u.nombre_completo, u.email, u.created_at, u.tipo_documento, u.documento, u.telefono, r.nombre AS rol,
                p.id AS programa_id, p.nombre AS programa, p.resolucion AS programa_resolucion
         FROM usuarios u JOIN roles r ON r.id = u.rol_id
         LEFT JOIN programas p ON p.id = u.programa_id
         WHERE u.id = $1`,
        [req.user.id]
    );
    const u = r.rows[0];
    if (!u) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    const asignaturas = u.programa_id
        ? (await db.query('SELECT nombre FROM asignaturas WHERE programa_id = $1 ORDER BY nombre', [u.programa_id])).rows.map((a) => a.nombre)
        : [];
    res.json({
        success: true,
        perfil: {
            username: u.username,
            nombre: u.nombre_completo,
            email: u.email,
            tipo_documento: u.tipo_documento,
            documento: u.documento,
            telefono: u.telefono,
            rol: u.rol,
            creado: u.created_at,
            programa: u.programa_id ? { nombre: u.programa, resolucion: u.programa_resolucion, asignaturas } : null
        },
        periodoActual: periodoActual()
    });
});

// Cambio de contraseña (obligatorio si la cuenta tiene clave temporal)
app.post('/api/auth/cambiar-clave', auth, async (req, res) => {
    const { actual, nueva } = req.body || {};
    if (!actual || !nueva) return res.status(400).json({ success: false, message: 'Escribe tu contraseña actual y la nueva' });
    if (String(nueva).length < 8) return res.status(400).json({ success: false, message: 'La nueva contraseña debe tener al menos 8 caracteres' });
    if (String(nueva) === String(actual)) return res.status(400).json({ success: false, message: 'La nueva contraseña debe ser distinta de la actual' });
    const r = await db.query(
        `SELECT u.id, u.username, u.nombre_completo, u.email, u.password_hash, r.nombre AS rol
         FROM usuarios u JOIN roles r ON u.rol_id = r.id WHERE u.id = $1`,
        [req.user.id]
    );
    const u = r.rows[0];
    if (!u || !u.password_hash.startsWith('$2') || !(await bcrypt.compare(String(actual), u.password_hash))) {
        return res.status(400).json({ success: false, message: 'La contraseña actual no es correcta' });
    }
    const hash = await bcrypt.hash(String(nueva), 10);
    await db.query('UPDATE usuarios SET password_hash = $1, debe_cambiar_clave = FALSE WHERE id = $2', [hash, u.id]);
    res.json({ success: true, message: 'Contraseña actualizada', ...firmarSesion({ ...u, debe_cambiar_clave: false, acepto_legal: !req.user.aceptarLegal }) });
});

// Aceptación de los Términos de uso y la Política de Tratamiento de Datos (queda registrada con fecha, IP y navegador)
app.post('/api/legal/aceptar', auth, async (req, res) => {
    if (req.body?.acepta !== true) return res.status(400).json({ success: false, message: 'Debes marcar la casilla de aceptación' });
    await db.query(
        `INSERT INTO aceptaciones_legales (usuario_id, version, ip, user_agent) VALUES ($1, $2, $3, $4)
         ON CONFLICT (usuario_id, version) DO NOTHING`,
        [req.user.id, VERSION_LEGAL, String(req.ip || '').slice(0, 64), String(req.get('user-agent') || '').slice(0, 300)]
    );
    const r = await db.query(
        `SELECT u.id, u.username, u.nombre_completo, u.email, u.debe_cambiar_clave, r.nombre AS rol
         FROM usuarios u JOIN roles r ON u.rol_id = r.id WHERE u.id = $1`,
        [req.user.id]
    );
    res.json({ success: true, message: 'Gracias. Tu aceptación quedó registrada', ...firmarSesion({ ...r.rows[0], acepto_legal: true }) });
});

// ---------- Estudiante: notas ----------
app.get('/api/notas', auth, rol('Estudiante'), async (req, res) => {
    const r = await db.query(
        `SELECT a.id, a.nombre, m.periodo,
                MAX(CASE WHEN c.corte = 1 THEN c.nota END) AS c1,
                MAX(CASE WHEN c.corte = 2 THEN c.nota END) AS c2,
                MAX(CASE WHEN c.corte = 3 THEN c.nota END) AS c3
         FROM matriculas m
         JOIN asignaturas a ON a.id = m.asignatura_id
         LEFT JOIN calificaciones c ON c.matricula_id = m.id
         WHERE m.estudiante_id = $1
         GROUP BY a.id, a.nombre, m.periodo
         ORDER BY m.periodo DESC, a.nombre`,
        [req.user.id]
    );
    res.json({
        success: true,
        notaMinima: NOTA_MINIMA,
        periodoActual: periodoActual(),
        asignaturas: r.rows.map((row) => ({ id: row.id, nombre: row.nombre, periodo: row.periodo, ...resumenNotas(row.c1, row.c2, row.c3) }))
    });
});

// ---------- Docente / Admin: gestión de notas ----------
app.get('/api/docente/asignaturas', auth, rol('Docente', 'Administrador'), async (req, res) => {
    const esAdmin = req.user.rol === 'Administrador';
    const asig = await db.query(
        `SELECT id, nombre FROM asignaturas ${esAdmin ? '' : 'WHERE docente_id = $1'} ORDER BY nombre`,
        esAdmin ? [] : [req.user.id]
    );
    const ids = asig.rows.map((a) => a.id);
    let alumnos = [];
    if (ids.length) {
        const r = await db.query(
            `SELECT m.id AS matricula_id, m.asignatura_id, u.nombre_completo, u.username, u.documento,
                    MAX(CASE WHEN c.corte = 1 THEN c.nota END) AS c1,
                    MAX(CASE WHEN c.corte = 2 THEN c.nota END) AS c2,
                    MAX(CASE WHEN c.corte = 3 THEN c.nota END) AS c3
             FROM matriculas m
             JOIN usuarios u ON u.id = m.estudiante_id
             LEFT JOIN calificaciones c ON c.matricula_id = m.id
             WHERE m.asignatura_id = ANY($1)
             GROUP BY m.id, m.asignatura_id, u.nombre_completo, u.username, u.documento
             ORDER BY u.nombre_completo`,
            [ids]
        );
        alumnos = r.rows;
    }
    res.json({
        success: true,
        notaMinima: NOTA_MINIMA,
        asignaturas: asig.rows.map((a) => ({
            ...a,
            estudiantes: alumnos
                .filter((s) => s.asignatura_id === a.id)
                .map((s) => ({
                    matricula_id: s.matricula_id,
                    nombre: s.nombre_completo,
                    username: s.username,
                    documento: s.documento,
                    ...resumenNotas(s.c1, s.c2, s.c3)
                }))
        }))
    });
});

app.post('/api/docente/notas', auth, rol('Docente', 'Administrador'), async (req, res) => {
    const matriculaId = parseInt(req.body.matricula_id, 10);
    const corte = parseInt(req.body.corte, 10);
    const nota = Number(req.body.nota);
    if (!Number.isInteger(matriculaId) || ![1, 2, 3].includes(corte) || !Number.isFinite(nota) || nota < 0 || nota > 5) {
        return res.status(400).json({ success: false, message: 'Datos inválidos: corte 1-3 y nota entre 0.0 y 5.0' });
    }
    const m = await db.query(
        `SELECT a.docente_id FROM matriculas m JOIN asignaturas a ON a.id = m.asignatura_id WHERE m.id = $1`,
        [matriculaId]
    );
    if (!m.rows.length) return res.status(404).json({ success: false, message: 'Matrícula no encontrada' });
    if (req.user.rol === 'Docente' && m.rows[0].docente_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Esta asignatura no está a tu cargo' });
    }
    await db.query(
        `INSERT INTO calificaciones (matricula_id, corte, nota) VALUES ($1, $2, $3)
         ON CONFLICT (matricula_id, corte) DO UPDATE SET nota = EXCLUDED.nota, updated_at = CURRENT_TIMESTAMP`,
        [matriculaId, corte, Math.round(nota * 100) / 100]
    );
    res.json({ success: true, message: 'Calificación guardada' });
});

// Asignatura a cargo de quien consulta (el administrador puede ver todas)
async function asignaturaPermitida(req, id) {
    const r = await db.query('SELECT id, nombre, docente_id FROM asignaturas WHERE id = $1', [parseInt(id, 10) || 0]);
    const a = r.rows[0];
    if (!a) throw httpError(404, 'Asignatura no encontrada');
    if (req.user.rol === 'Docente' && a.docente_id !== req.user.id) throw httpError(403, 'Esta asignatura no está a tu cargo');
    return a;
}

async function estudiantesDeAsignatura(asignaturaId) {
    const r = await db.query(
        `SELECT m.id AS matricula_id, u.nombre_completo AS nombre, u.username, u.documento,
                MAX(CASE WHEN c.corte = 1 THEN c.nota END) AS c1,
                MAX(CASE WHEN c.corte = 2 THEN c.nota END) AS c2,
                MAX(CASE WHEN c.corte = 3 THEN c.nota END) AS c3
         FROM matriculas m JOIN usuarios u ON u.id = m.estudiante_id
         LEFT JOIN calificaciones c ON c.matricula_id = m.id
         WHERE m.asignatura_id = $1
         GROUP BY m.id, u.nombre_completo, u.username, u.documento ORDER BY u.nombre_completo`,
        [asignaturaId]
    );
    return r.rows.map((s) => ({ ...s, ...resumenNotas(s.c1, s.c2, s.c3) }));
}

const matriculasDe = async (asignaturaId) =>
    new Set((await db.query('SELECT id FROM matriculas WHERE asignatura_id = $1', [asignaturaId])).rows.map((r) => r.id));

// Guardar varias notas de una asignatura en una sola operación (tabla editable o Excel)
app.post('/api/docente/notas/lote', auth, rol('Docente', 'Administrador'), async (req, res) => {
    const a = await asignaturaPermitida(req, req.body?.asignatura_id);
    const lista = Array.isArray(req.body?.notas) ? req.body.notas : [];
    if (!lista.length) return res.status(400).json({ success: false, message: 'No hay notas para guardar' });
    if (lista.length > 3000) return res.status(400).json({ success: false, message: 'Demasiadas notas en una sola carga' });
    const notas = lista.map((n) => ({ m: parseInt(n.matricula_id, 10), c: parseInt(n.corte, 10), v: Number(n.nota) }));
    if (notas.some((n) => !Number.isInteger(n.m) || ![1, 2, 3].includes(n.c) || !Number.isFinite(n.v) || n.v < 0 || n.v > 5)) {
        return res.status(400).json({ success: false, message: 'Hay notas inválidas: deben estar entre 0.0 y 5.0' });
    }
    const validos = await matriculasDe(a.id);
    if (notas.some((n) => !validos.has(n.m))) {
        return res.status(400).json({ success: false, message: 'Alguna nota es de un estudiante que no está matriculado en esta asignatura' });
    }
    // Si una matrícula y corte vienen repetidos, gana el último
    const unicas = [...new Map(notas.map((n) => [`${n.m}-${n.c}`, n])).values()];
    await db.query(
        `INSERT INTO calificaciones (matricula_id, corte, nota)
         SELECT * FROM unnest($1::int[], $2::int[], $3::numeric[])
         ON CONFLICT (matricula_id, corte) DO UPDATE SET nota = EXCLUDED.nota, updated_at = CURRENT_TIMESTAMP`,
        [unicas.map((n) => n.m), unicas.map((n) => n.c), unicas.map((n) => Math.round(n.v * 100) / 100)]
    );
    res.json({ success: true, message: `${unicas.length} nota(s) guardada(s) en ${a.nombre}` });
});

// Planilla Excel de la asignatura con sus estudiantes (para llenar fuera del portal)
app.get('/api/docente/plantilla/:id', auth, rol('Docente', 'Administrador'), async (req, res) => {
    const a = await asignaturaPermitida(req, req.params.id);
    const est = await estudiantesDeAsignatura(a.id);
    const nombre = `notas-${a.nombre.normalize('NFD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}.xlsx`;
    await excel.enviar(res, excel.plantillaNotas(a, est), nombre);
});

// Lee una planilla llena y devuelve las notas para revisarlas en la tabla (no guarda nada)
app.post('/api/docente/plantilla/:id', auth, rol('Docente', 'Administrador'), subirExcel, async (req, res) => {
    const a = await asignaturaPermitida(req, req.params.id);
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ success: false, message: 'Selecciona un archivo de Excel' });
    const wb = await excel.leer(req.body);
    const { notas, errores } = excel.leerNotas(wb, a.id, await matriculasDe(a.id));
    res.json({ success: true, notas, errores });
});

// ---------- Administrador ----------
app.get('/api/admin/resumen', auth, rol('Administrador'), async (req, res) => {
    const usuarios = await db.query(
        `SELECT u.id, u.username, u.nombre_completo, u.email, u.tipo_documento, u.documento, u.telefono,
                r.nombre AS rol, u.programa_id, p.nombre AS programa
         FROM usuarios u JOIN roles r ON r.id = u.rol_id
         LEFT JOIN programas p ON p.id = u.programa_id ORDER BY u.id`
    );
    const asignaturas = await db.query(
        `SELECT a.id, a.nombre, a.programa_id, a.docente_id, u.nombre_completo AS docente,
                (SELECT COUNT(*) FROM matriculas m WHERE m.asignatura_id = a.id)::int AS estudiantes
         FROM asignaturas a LEFT JOIN usuarios u ON u.id = a.docente_id ORDER BY a.nombre`
    );
    const programas = await db.query(
        `SELECT p.id, p.nombre, p.resolucion,
                (SELECT COUNT(*) FROM usuarios u WHERE u.programa_id = p.id)::int AS estudiantes,
                (SELECT COUNT(*) FROM asignaturas a WHERE a.programa_id = p.id)::int AS asignaturas
         FROM programas p ORDER BY p.nombre`
    );
    res.json({
        success: true,
        usuarios: usuarios.rows,
        asignaturas: asignaturas.rows,
        programas: programas.rows,
        periodoActual: periodoActual(),
        pagoManual: PAGO_MANUAL
    });
});

app.post('/api/admin/usuarios', auth, rol('Administrador'), async (req, res) => {
    const b = req.body || {};
    const username = String(b.username ?? '').trim();
    const password = String(b.password ?? '');
    if (!username || !password || !b.rol) return res.status(400).json({ success: false, message: 'Usuario, clave temporal y rol son obligatorios' });
    if (!RE_USUARIO.test(username)) return res.status(400).json({ success: false, message: 'El usuario solo admite letras, números, punto, guion y guion bajo (3 a 40)' });
    if (password.length < 8) return res.status(400).json({ success: false, message: 'La contraseña debe tener al menos 8 caracteres' });
    const { errores, datos } = validarPersona(b);
    if (errores.length) return res.status(400).json({ success: false, message: errores.join('. ') });
    const r = await db.query('SELECT id FROM roles WHERE nombre = $1', [b.rol]);
    if (!r.rows.length) return res.status(400).json({ success: false, message: 'Rol inválido' });
    try {
        const hash = await bcrypt.hash(password, 10);
        await db.query(
            // La clave que pone el admin es temporal: el usuario la cambia al entrar
            `INSERT INTO usuarios (username, password_hash, nombre_completo, email, tipo_documento, documento, telefono, rol_id, programa_id, debe_cambiar_clave)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)`,
            [username, hash, datos.nombre_completo, datos.email, datos.tipo_documento, datos.documento, datos.telefono, r.rows[0].id,
             b.rol === 'Estudiante' && b.programa_id ? b.programa_id : null]
        );
        res.status(201).json({ success: true, message: 'Usuario creado: deberá cambiar la clave en su primer ingreso' });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ success: false, message: 'El usuario, el correo o el documento ya existen' });
        if (e.code === '23503' || e.code === '22P02') return res.status(400).json({ success: false, message: 'Programa inválido' });
        throw e;
    }
});

// Editar los datos de un usuario (y, si se pide, asignarle una nueva clave temporal)
app.put('/api/admin/usuarios/:id', auth, rol('Administrador'), async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    const b = req.body || {};
    const actual = (await db.query(
        'SELECT u.id, r.nombre AS rol FROM usuarios u JOIN roles r ON r.id = u.rol_id WHERE u.id = $1', [id])).rows[0];
    if (!actual) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    const { errores, datos } = validarPersona(b);
    const nuevaClave = String(b.nueva_clave ?? '');
    if (nuevaClave && nuevaClave.length < 8) errores.push('La nueva clave temporal debe tener al menos 8 caracteres');
    if (errores.length) return res.status(400).json({ success: false, message: errores.join('. ') });
    const programa = actual.rol === 'Estudiante' && b.programa_id ? parseInt(b.programa_id, 10) || null : null;
    try {
        await db.query(
            `UPDATE usuarios SET nombre_completo = $2, email = $3, tipo_documento = $4, documento = $5, telefono = $6, programa_id = $7
             WHERE id = $1`,
            [id, datos.nombre_completo, datos.email, datos.tipo_documento, datos.documento, datos.telefono, programa]
        );
        if (nuevaClave) {
            await db.query('UPDATE usuarios SET password_hash = $2, debe_cambiar_clave = TRUE WHERE id = $1', [id, await bcrypt.hash(nuevaClave, 10)]);
        }
        res.json({ success: true, message: nuevaClave ? 'Datos actualizados. Deberá cambiar la clave temporal al entrar' : 'Datos actualizados' });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ success: false, message: 'Ese correo o documento ya pertenece a otro usuario' });
        if (e.code === '23503') return res.status(400).json({ success: false, message: 'Programa inválido' });
        throw e;
    }
});

// Plantilla Excel para crear muchos usuarios a la vez
app.get('/api/admin/plantilla/usuarios', auth, rol('Administrador'), async (req, res) => {
    const roles = (await db.query('SELECT nombre FROM roles ORDER BY id')).rows.map((r) => r.nombre);
    const programas = (await db.query('SELECT nombre FROM programas ORDER BY nombre')).rows.map((p) => p.nombre);
    await excel.enviar(res, excel.plantillaUsuarios(roles, programas), 'plantilla-usuarios-cepdeco.xlsx');
});

// Exportar los usuarios actuales en el mismo formato de la plantilla (para corregir datos y volver a subir)
app.get('/api/admin/usuarios/exportar', auth, rol('Administrador'), async (req, res) => {
    const roles = (await db.query('SELECT nombre FROM roles ORDER BY id')).rows.map((r) => r.nombre);
    const programas = (await db.query('SELECT nombre FROM programas ORDER BY nombre')).rows.map((p) => p.nombre);
    const usuarios = (await db.query(
        `SELECT u.username, u.nombre_completo, u.email, u.tipo_documento, u.documento, u.telefono, r.nombre AS rol, p.nombre AS programa
         FROM usuarios u JOIN roles r ON r.id = u.rol_id LEFT JOIN programas p ON p.id = u.programa_id
         ORDER BY r.id, u.nombre_completo`
    )).rows;
    const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
    await excel.enviar(res, excel.plantillaUsuarios(roles, programas, usuarios), `usuarios-cepdeco-${hoy}.xlsx`);
});

// Carga masiva: crea los usuarios nuevos y actualiza los que ya existen (por nombre de usuario).
// Sin ?confirmar=1 solo muestra la vista previa; con confirmar aplica todo o nada.
app.post('/api/admin/usuarios/lote', auth, rol('Administrador'), subirExcel, async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ success: false, message: 'Selecciona un archivo de Excel' });
    const { filas, error } = excel.leerUsuarios(await excel.leer(req.body));
    if (error) return res.status(400).json({ success: false, message: error });
    if (!filas.length) return res.status(400).json({ success: false, message: 'La hoja "Usuarios" está vacía' });

    const sinTilde = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const roles = new Map((await db.query('SELECT id, nombre FROM roles')).rows.map((r) => [r.nombre.toLowerCase(), r]));
    const programas = (await db.query('SELECT id, nombre FROM programas')).rows;
    const programaPorNombre = new Map(programas.map((p) => [sinTilde(p.nombre), p]));
    const programaPorId = new Map(programas.map((p) => [p.id, p]));
    const docs = filas.map((f) => f.documento.replace(/[.\s]/g, '')).filter(Boolean);
    const relacionados = (await db.query(
        `SELECT u.id, u.username, u.nombre_completo, u.email, u.tipo_documento, u.documento, u.telefono, u.programa_id, r.nombre AS rol
         FROM usuarios u JOIN roles r ON r.id = u.rol_id
         WHERE LOWER(u.username) = ANY($1) OR LOWER(u.email) = ANY($2) OR u.documento = ANY($3)`,
        [filas.map((f) => f.username.toLowerCase()), filas.map((f) => f.email.toLowerCase()), docs]
    )).rows;
    const porUsuario = new Map(relacionados.map((u) => [u.username.toLowerCase(), u]));
    const duenoCorreo = new Map(relacionados.map((u) => [u.email.toLowerCase(), u.id]));
    const duenoDoc = new Map(relacionados.filter((u) => u.documento).map((u) => [u.documento, u.id]));
    const enArchivo = { u: new Set(), e: new Set(), d: new Set() };

    const revisadas = filas.map((f) => {
        const u = f.username.toLowerCase();
        const actual = porUsuario.get(u) || null;
        const avisos = [];
        // En un usuario existente, documento/teléfono/programa vacíos = sin cambio
        const entrada = {
            nombre_completo: f.nombre, email: f.email,
            tipo_documento: f.documento ? f.tipo_documento : actual?.tipo_documento,
            documento: f.documento || actual?.documento,
            telefono: f.telefono || actual?.telefono
        };
        const { errores, datos } = validarPersona(entrada);
        if (!RE_USUARIO.test(f.username)) errores.unshift('Usuario inválido (letras, números, . - _; 3 a 40)');
        else if (enArchivo.u.has(u)) errores.unshift('Usuario repetido en el archivo');
        const id = actual?.id ?? null;
        if (duenoCorreo.has(datos.email) && duenoCorreo.get(datos.email) !== id) errores.push('El correo ya pertenece a otro usuario');
        else if (enArchivo.e.has(datos.email)) errores.push('Correo repetido en el archivo');
        if (datos.documento && duenoDoc.has(datos.documento) && duenoDoc.get(datos.documento) !== id) errores.push('El documento ya pertenece a otro usuario');
        else if (datos.documento && enArchivo.d.has(datos.documento)) errores.push('Documento repetido en el archivo');

        let rolNombre;
        let rolId = null;
        if (actual) {
            rolNombre = actual.rol;
            if (f.rol && f.rol.toLowerCase() !== actual.rol.toLowerCase()) avisos.push(`El rol no se cambia desde Excel (se mantiene ${actual.rol})`);
            if (f.clave) avisos.push('La clave no se cambia desde Excel (usa el botón Editar)');
        } else {
            const r = roles.get(f.rol.toLowerCase());
            if (!r) errores.push('Rol inválido (Estudiante, Docente o Administrador)');
            rolNombre = r?.nombre || f.rol;
            rolId = r?.id ?? null;
            if (f.clave && f.clave.length < 8) errores.push('La clave temporal debe tener al menos 8 caracteres');
        }

        // Programa: solo estudiantes. Vacío en un existente = se mantiene el actual
        let programa = actual?.programa_id ? programaPorId.get(actual.programa_id) : null;
        if (rolNombre === 'Estudiante' && f.programa) {
            programa = programaPorNombre.get(sinTilde(f.programa)) || null;
            if (!programa) errores.push('Programa no encontrado: elígelo de la lista');
        } else if (rolNombre !== 'Estudiante' && f.programa) {
            avisos.push('El programa solo aplica a estudiantes (se ignora)');
        }
        if (f.periodo && !RE_PERIODO.test(f.periodo)) errores.push('Periodo inválido (ej. 2026-B)');
        else if (f.periodo && rolNombre === 'Estudiante' && !programa) errores.push('Para matricular hay que indicar el programa del estudiante');
        else if (f.periodo && rolNombre !== 'Estudiante') avisos.push('El periodo solo aplica a estudiantes (se ignora)');
        const periodo = rolNombre === 'Estudiante' && programa && RE_PERIODO.test(f.periodo) ? f.periodo : null;

        // Qué cambia en un usuario existente
        const cambios = [];
        if (actual) {
            const comparar = (campo, antes, despues) => { if ((antes ?? '') !== (despues ?? '')) cambios.push({ campo, antes: antes ?? '', despues: despues ?? '' }); };
            comparar('Nombre', actual.nombre_completo, datos.nombre_completo);
            comparar('Correo', actual.email.toLowerCase(), datos.email);
            comparar('Tipo documento', actual.tipo_documento, datos.tipo_documento);
            comparar('Documento', actual.documento, datos.documento);
            comparar('Teléfono', actual.telefono, datos.telefono);
            if (rolNombre === 'Estudiante') comparar('Programa', programaPorId.get(actual.programa_id)?.nombre, programa?.nombre);
        }
        if (periodo) cambios.push({ campo: 'Matrícula', antes: '', despues: `${programa.nombre} · ${periodo}` });

        enArchivo.u.add(u);
        if (datos.email) enArchivo.e.add(datos.email);
        if (datos.documento) enArchivo.d.add(datos.documento);
        const accion = errores.length ? 'error' : !actual ? 'crear' : cambios.length ? 'actualizar' : 'sin cambios';
        return { fila: f.fila, username: f.username, actual, accion, rolNombre, rolId, programa, periodo, clave: f.clave, datos, cambios, avisos, errores };
    });

    const cuenta = (a) => revisadas.filter((r) => r.accion === a).length;
    const resumen = { crear: cuenta('crear'), actualizar: cuenta('actualizar'), sinCambios: cuenta('sin cambios'), errores: cuenta('error') };
    if (req.query.confirmar !== '1' || resumen.errores || !(resumen.crear + resumen.actualizar)) {
        return res.json({
            success: true, confirmado: false, resumen, conErrores: resumen.errores,
            filas: revisadas.map((r) => ({ fila: r.fila, username: r.username, nombre: r.datos.nombre_completo, rol: r.rolNombre, accion: r.accion,
                documento: r.datos.documento, programa: r.programa?.nombre || null, periodo: r.periodo, cambios: r.cambios, avisos: r.avisos, errores: r.errores }))
        });
    }

    // Todo o nada: si algo falla, no se guarda ningún cambio
    const cliente = await db.pool.connect();
    const creados = [];
    let actualizados = 0;
    try {
        await cliente.query('BEGIN');
        for (const r of revisadas) {
            if (r.accion === 'sin cambios') continue;
            let id = r.actual?.id;
            if (r.accion === 'crear') {
                const clave = r.clave || claveTemporal();
                id = (await cliente.query(
                    `INSERT INTO usuarios (username, password_hash, nombre_completo, email, tipo_documento, documento, telefono, rol_id, programa_id, debe_cambiar_clave)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE) RETURNING id`,
                    [r.username, await bcrypt.hash(clave, 10), r.datos.nombre_completo, r.datos.email, r.datos.tipo_documento,
                     r.datos.documento, r.datos.telefono, r.rolId, r.rolNombre === 'Estudiante' ? r.programa?.id || null : null]
                )).rows[0].id;
                creados.push({ username: r.username, nombre: r.datos.nombre_completo, rol: r.rolNombre, clave_generada: r.clave ? null : clave });
            } else {
                await cliente.query(
                    `UPDATE usuarios SET nombre_completo = $2, email = $3, tipo_documento = $4, documento = $5, telefono = $6, programa_id = $7 WHERE id = $1`,
                    [id, r.datos.nombre_completo, r.datos.email, r.datos.tipo_documento, r.datos.documento, r.datos.telefono,
                     r.rolNombre === 'Estudiante' ? r.programa?.id || null : null]
                );
                actualizados++;
            }
            if (r.periodo) {
                await cliente.query(
                    `INSERT INTO matriculas (estudiante_id, asignatura_id, periodo)
                     SELECT $1, a.id, $3 FROM asignaturas a WHERE a.programa_id = $2 ON CONFLICT DO NOTHING`,
                    [id, r.programa.id, r.periodo]
                );
            }
        }
        await cliente.query('COMMIT');
    } catch (e) {
        await cliente.query('ROLLBACK').catch(() => {});
        if (e.code === '23505') return res.status(409).json({ success: false, message: 'Algún usuario, correo o documento se repite con otro usuario. No se guardó ningún cambio.' });
        throw e;
    } finally {
        cliente.release();
    }
    const partes = [creados.length && `${creados.length} usuario(s) creado(s)`, actualizados && `${actualizados} actualizado(s)`].filter(Boolean);
    res.status(201).json({ success: true, confirmado: true, message: partes.join(' y '), creados, actualizados });
});

// Quién ve qué: cada matrícula con su estudiante, asignatura, curso y docente
async function listaMatriculas() {
    return (await db.query(
        `SELECT m.id, m.periodo, e.id AS estudiante_id, e.username AS usuario, e.nombre_completo AS estudiante, e.tipo_documento, e.documento,
                a.id AS asignatura_id, a.nombre AS asignatura, p.nombre AS curso, d.nombre_completo AS docente
         FROM matriculas m
         JOIN usuarios e ON e.id = m.estudiante_id
         JOIN asignaturas a ON a.id = m.asignatura_id
         LEFT JOIN programas p ON p.id = a.programa_id
         LEFT JOIN usuarios d ON d.id = a.docente_id
         ORDER BY m.periodo DESC, a.nombre, e.nombre_completo`
    )).rows;
}

app.get('/api/admin/matriculas', auth, rol('Administrador'), async (req, res) => {
    res.json({ success: true, matriculas: await listaMatriculas() });
});

// Docente válido por id (o null = sin docente)
async function docenteValido(cliente, docenteId) {
    if (!docenteId) return null;
    const r = await cliente.query(`SELECT u.id FROM usuarios u JOIN roles r ON r.id = u.rol_id WHERE u.id = $1 AND r.nombre = 'Docente'`, [docenteId]);
    if (!r.rows.length) throw httpError(400, 'El docente elegido no existe o no tiene rol Docente');
    return r.rows[0].id;
}

// Editar una asignatura: nombre, curso y docente
app.put('/api/admin/asignaturas/:id', auth, rol('Administrador'), async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    const b = req.body || {};
    const nombre = String(b.nombre ?? '').trim().replace(/\s+/g, ' ');
    if (nombre.length < 2 || nombre.length > 150) return res.status(400).json({ success: false, message: 'El nombre debe tener entre 2 y 150 caracteres' });
    const programa = b.programa_id ? parseInt(b.programa_id, 10) || null : null;
    const docente = await docenteValido(db, b.docente_id ? parseInt(b.docente_id, 10) || 0 : null);
    try {
        const r = await db.query('UPDATE asignaturas SET nombre = $2, programa_id = $3, docente_id = $4 WHERE id = $1', [id, nombre, programa, docente]);
        if (!r.rowCount) return res.status(404).json({ success: false, message: 'Asignatura no encontrada' });
        res.json({ success: true, message: 'Asignatura actualizada' });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ success: false, message: 'Ya existe otra asignatura con ese nombre' });
        if (e.code === '23503') return res.status(400).json({ success: false, message: 'Curso inválido' });
        throw e;
    }
});

// Excel de cursos, asignaturas y matrículas (para consultar o corregir y volver a subir)
app.get('/api/admin/academico/exportar', auth, rol('Administrador'), async (req, res) => {
    const asignaturas = (await db.query(
        `SELECT a.id, a.nombre, p.nombre AS curso, d.username AS docente_usuario, d.nombre_completo AS docente,
                (SELECT COUNT(*) FROM matriculas m WHERE m.asignatura_id = a.id)::int AS estudiantes
         FROM asignaturas a LEFT JOIN programas p ON p.id = a.programa_id LEFT JOIN usuarios d ON d.id = a.docente_id
         ORDER BY p.nombre NULLS LAST, a.nombre`
    )).rows;
    const cursos = (await db.query('SELECT nombre FROM programas ORDER BY nombre')).rows.map((p) => p.nombre);
    const docentes = (await db.query(`SELECT u.username FROM usuarios u JOIN roles r ON r.id = u.rol_id WHERE r.nombre = 'Docente' ORDER BY u.username`)).rows.map((u) => u.username);
    const matriculas = (await listaMatriculas()).map((m) => ({ ...m, documento: m.documento ? `${m.tipo_documento || ''} ${m.documento}`.trim() : '' }));
    const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
    await excel.enviar(res, excel.plantillaAcademico({ asignaturas, matriculas, cursos, docentes }), `cursos-y-matriculas-cepdeco-${hoy}.xlsx`);
});

// Carga del Excel académico: sin ?confirmar=1 muestra la vista previa; con confirmar aplica todo o nada
app.post('/api/admin/academico/lote', auth, rol('Administrador'), subirExcel, async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ success: false, message: 'Selecciona un archivo de Excel' });
    const leido = excel.leerAcademico(await excel.leer(req.body));
    if (leido.error) return res.status(400).json({ success: false, message: leido.error });

    const sinTilde = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const cursos = (await db.query('SELECT id, nombre FROM programas')).rows;
    const cursoPorNombre = new Map(cursos.map((c) => [sinTilde(c.nombre), c]));
    const cursoPorId = new Map(cursos.map((c) => [c.id, c]));
    const docentes = (await db.query(`SELECT u.id, u.username, u.nombre_completo FROM usuarios u JOIN roles r ON r.id = u.rol_id WHERE r.nombre = 'Docente'`)).rows;
    const docentePorUsuario = new Map(docentes.map((d) => [d.username.toLowerCase(), d]));
    const docentePorId = new Map(docentes.map((d) => [d.id, d]));
    const asigBD = (await db.query('SELECT id, nombre, programa_id, docente_id FROM asignaturas')).rows;
    const asigPorId = new Map(asigBD.map((a) => [a.id, a]));
    const asigPorNombre = new Map(asigBD.map((a) => [sinTilde(a.nombre), a]));

    // 1) Asignaturas: con ID = actualizar; sin ID = crear
    const nombresArchivo = new Map();
    const asignaturas = leido.asignaturas.map((f) => {
        const errores = [];
        const id = f.id ? parseInt(f.id, 10) : null;
        const actual = id ? asigPorId.get(id) : null;
        if (f.id && !actual) errores.push(`No existe una asignatura con ID ${f.id}. Para crear una, deja el ID vacío`);
        if (f.nombre.length < 2 || f.nombre.length > 150) errores.push('El nombre debe tener entre 2 y 150 caracteres');
        const clave = sinTilde(f.nombre);
        const otra = asigPorNombre.get(clave);
        if (f.nombre && otra && otra.id !== actual?.id) errores.push('Ya existe otra asignatura con ese nombre');
        else if (nombresArchivo.has(clave)) errores.push('Nombre repetido en el archivo');
        nombresArchivo.set(clave, true);
        const curso = f.curso ? cursoPorNombre.get(sinTilde(f.curso)) : null;
        if (f.curso && !curso) errores.push('Curso no encontrado: elígelo de la lista');
        const docente = f.docente ? docentePorUsuario.get(f.docente.toLowerCase()) : null;
        if (f.docente && !docente) errores.push('Docente no encontrado: usa el usuario de un docente (de la lista)');
        const cambios = [];
        if (actual) {
            const c = (campo, antes, despues) => { if ((antes ?? '') !== (despues ?? '')) cambios.push({ campo, antes: antes ?? '', despues: despues ?? '' }); };
            c('Nombre', actual.nombre, f.nombre);
            c('Curso', cursoPorId.get(actual.programa_id)?.nombre, curso?.nombre);
            c('Docente', docentePorId.get(actual.docente_id)?.nombre_completo, docente?.nombre_completo);
        }
        const accion = errores.length ? 'error' : !actual ? 'crear' : cambios.length ? 'actualizar' : 'sin cambios';
        return { fila: f.fila, id: actual?.id ?? null, nombre: f.nombre, curso, docente, accion, cambios, errores, avisos: [] };
    });
    const nuevasAsig = new Map(asignaturas.filter((a) => a.accion === 'crear').map((a) => [sinTilde(a.nombre), a]));
    // Nombre vigente de cada asignatura después de los cambios del archivo
    const asigFinal = new Map(asigBD.map((a) => [sinTilde(a.nombre), a.id]));
    asignaturas.filter((a) => a.accion === 'actualizar').forEach((a) => { asigFinal.set(sinTilde(a.nombre), a.id); });

    // 2) Matrículas: solo se agregan (nunca se borran, para no perder notas)
    const usuarios = [...new Set(leido.matriculas.map((m) => m.usuario.toLowerCase()))];
    const estudiantes = new Map((await db.query(
        `SELECT u.id, u.username, u.nombre_completo FROM usuarios u JOIN roles r ON r.id = u.rol_id
         WHERE r.nombre = 'Estudiante' AND LOWER(u.username) = ANY($1)`, [usuarios]
    )).rows.map((u) => [u.username.toLowerCase(), u]));
    const existentes = new Map((await db.query('SELECT estudiante_id, asignatura_id, periodo FROM matriculas')).rows.map((m) => [`${m.estudiante_id}-${m.asignatura_id}`, m.periodo]));
    const enArchivo = new Set();
    const periodoPorDefecto = periodoActual();
    const matriculas = leido.matriculas.map((f) => {
        const errores = [];
        const avisos = [];
        const est = estudiantes.get(f.usuario.toLowerCase());
        if (!f.usuario) errores.push('Falta el usuario del estudiante');
        else if (!est) errores.push('No existe un estudiante con ese usuario');
        const clave = sinTilde(f.asignatura);
        const asigId = asigFinal.get(clave) ?? null;
        const nueva = nuevasAsig.get(clave);
        if (!f.asignatura) errores.push('Falta la asignatura');
        else if (!asigId && !nueva) errores.push('Asignatura no encontrada: elígela de la lista');
        const periodo = f.periodo || periodoPorDefecto;
        if (f.periodo && !RE_PERIODO.test(f.periodo)) errores.push('Periodo inválido (ej. 2026-B)');
        let accion = 'crear';
        if (est && asigId) {
            const k = `${est.id}-${asigId}`;
            if (existentes.has(k)) {
                accion = 'sin cambios';
                if (f.periodo && existentes.get(k) !== f.periodo) avisos.push(`Ya está matriculado en ${existentes.get(k)}; el periodo no se cambia desde Excel`);
            } else if (enArchivo.has(k)) { accion = 'sin cambios'; avisos.push('Fila repetida en el archivo'); }
            enArchivo.add(k);
        }
        if (errores.length) accion = 'error';
        return { fila: f.fila, usuario: f.usuario, estudiante: est?.nombre_completo || '', estudianteId: est?.id, asignatura: f.asignatura, asigId, nueva: nueva ? clave : null, periodo, accion, errores, avisos };
    });

    const cuenta = (lista, a) => lista.filter((x) => x.accion === a).length;
    const resumen = {
        asignaturas: { crear: cuenta(asignaturas, 'crear'), actualizar: cuenta(asignaturas, 'actualizar'), sinCambios: cuenta(asignaturas, 'sin cambios'), errores: cuenta(asignaturas, 'error') },
        matriculas: { crear: cuenta(matriculas, 'crear'), sinCambios: cuenta(matriculas, 'sin cambios'), errores: cuenta(matriculas, 'error') }
    };
    const errores = resumen.asignaturas.errores + resumen.matriculas.errores;
    const porHacer = resumen.asignaturas.crear + resumen.asignaturas.actualizar + resumen.matriculas.crear;
    const visible = (x) => x.accion !== 'sin cambios' || x.avisos.length;
    if (req.query.confirmar !== '1' || errores || !porHacer) {
        return res.json({
            success: true, confirmado: false, resumen,
            asignaturas: asignaturas.filter(visible).map((a) => ({ fila: a.fila, nombre: a.nombre, curso: a.curso?.nombre || null, docente: a.docente?.nombre_completo || null, accion: a.accion, cambios: a.cambios, errores: a.errores })),
            matriculas: matriculas.filter(visible).map((m) => ({ fila: m.fila, usuario: m.usuario, estudiante: m.estudiante, asignatura: m.asignatura, periodo: m.periodo, accion: m.accion, errores: m.errores, avisos: m.avisos }))
        });
    }

    const cliente = await db.pool.connect();
    try {
        await cliente.query('BEGIN');
        const idNueva = new Map();
        for (const a of asignaturas) {
            if (a.accion === 'crear') {
                const r = await cliente.query('INSERT INTO asignaturas (nombre, programa_id, docente_id) VALUES ($1, $2, $3) RETURNING id', [a.nombre, a.curso?.id || null, a.docente?.id || null]);
                idNueva.set(sinTilde(a.nombre), r.rows[0].id);
            } else if (a.accion === 'actualizar') {
                await cliente.query('UPDATE asignaturas SET nombre = $2, programa_id = $3, docente_id = $4 WHERE id = $1', [a.id, a.nombre, a.curso?.id || null, a.docente?.id || null]);
            }
        }
        const nuevas = matriculas.filter((m) => m.accion === 'crear');
        if (nuevas.length) {
            await cliente.query(
                `INSERT INTO matriculas (estudiante_id, asignatura_id, periodo)
                 SELECT * FROM unnest($1::int[], $2::int[], $3::varchar[]) ON CONFLICT DO NOTHING`,
                [nuevas.map((m) => m.estudianteId), nuevas.map((m) => m.asigId ?? idNueva.get(m.nueva)), nuevas.map((m) => m.periodo)]
            );
        }
        await cliente.query('COMMIT');
    } catch (e) {
        await cliente.query('ROLLBACK').catch(() => {});
        if (e.code === '23505') return res.status(409).json({ success: false, message: 'Algún nombre de asignatura se repite. No se guardó ningún cambio.' });
        throw e;
    } finally {
        cliente.release();
    }
    const partes = [
        resumen.asignaturas.crear && `${resumen.asignaturas.crear} asignatura(s) creada(s)`,
        resumen.asignaturas.actualizar && `${resumen.asignaturas.actualizar} asignatura(s) actualizada(s)`,
        resumen.matriculas.crear && `${resumen.matriculas.crear} matrícula(s) nueva(s)`
    ].filter(Boolean);
    res.status(201).json({ success: true, confirmado: true, message: partes.join(', ') });
});

app.post('/api/admin/asignaturas', auth, rol('Administrador'), async (req, res) => {
    const { nombre, docente_id, programa_id } = req.body || {};
    if (!nombre) return res.status(400).json({ success: false, message: 'El nombre es obligatorio' });
    try {
        await db.query('INSERT INTO asignaturas (nombre, docente_id, programa_id) VALUES ($1, $2, $3)',
            [String(nombre).trim(), docente_id || null, programa_id || null]);
        res.status(201).json({ success: true, message: 'Asignatura creada' });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ success: false, message: 'Esa asignatura ya existe' });
        if (e.code === '23503' || e.code === '22P02') return res.status(400).json({ success: false, message: 'Docente o curso inexistente' });
        throw e;
    }
});

// Matrícula: con curso (programa) liga al estudiante y lo inscribe en una o en todas las asignaturas del curso
app.post('/api/admin/matriculas', auth, rol('Administrador'), async (req, res) => {
    const b = req.body || {};
    const estudianteId = parseInt(b.estudiante_id, 10) || 0;
    const programaId = b.programa_id ? parseInt(b.programa_id, 10) || 0 : null;
    const asignaturaId = b.asignatura_id ? parseInt(b.asignatura_id, 10) || 0 : null;
    const periodo = String(b.periodo || '').trim().toUpperCase() || periodoActual();
    if (!/^\d{4}-[AB]$/.test(periodo)) {
        return res.status(400).json({ success: false, message: 'Periodo inválido: usa el formato 2026-A o 2026-B' });
    }
    if (!programaId && !asignaturaId) {
        return res.status(400).json({ success: false, message: 'Elige un curso o una asignatura' });
    }
    const est = await db.query(
        `SELECT u.id FROM usuarios u JOIN roles r ON r.id = u.rol_id WHERE u.id = $1 AND r.nombre = 'Estudiante'`,
        [estudianteId]
    );
    if (!est.rows.length) return res.status(400).json({ success: false, message: 'Estudiante inválido' });

    let curso = null;
    if (programaId) {
        const p = await db.query('SELECT nombre FROM programas WHERE id = $1', [programaId]);
        if (!p.rows.length) return res.status(400).json({ success: false, message: 'Curso inválido' });
        curso = p.rows[0].nombre;
        await db.query('UPDATE usuarios SET programa_id = $2 WHERE id = $1', [estudianteId, programaId]);
    }
    const ids = asignaturaId
        ? [asignaturaId]
        : (await db.query('SELECT id FROM asignaturas WHERE programa_id = $1', [programaId])).rows.map((a) => a.id);
    let nuevas = 0;
    if (ids.length) {
        try {
            const r = await db.query(
                `INSERT INTO matriculas (estudiante_id, asignatura_id, periodo)
                 SELECT $1, unnest($2::int[]), $3 ON CONFLICT DO NOTHING RETURNING id`,
                [estudianteId, ids, periodo]
            );
            nuevas = r.rowCount;
        } catch (e) {
            if (e.code === '23503') return res.status(400).json({ success: false, message: 'Asignatura inválida' });
            throw e;
        }
    }
    let message = curso ? `Inscrito en ${curso} (${periodo}). ` : '';
    if (!ids.length) message += 'Ese curso aún no tiene asignaturas cargadas.';
    else if (!nuevas) message += 'Ya estaba matriculado en esa(s) asignatura(s).';
    else message += `${nuevas} asignatura(s) matriculada(s) en ${periodo}.`;
    res.status(201).json({ success: true, message: message.trim() });
});

// Pago manual: crea un pago ACCEPTED para el estudiante, marcado como MANUAL-<admin>
app.post('/api/admin/pagos/manual', auth, rol('Administrador'), async (req, res) => {
    if (!PAGO_MANUAL) return res.status(403).json({ success: false, message: 'El pago manual está desactivado' });
    const estudianteId = parseInt((req.body || {}).estudiante_id, 10);
    const est = await db.query(
        `SELECT u.id FROM usuarios u JOIN roles r ON r.id = u.rol_id WHERE u.id = $1 AND r.nombre = 'Estudiante'`,
        [Number.isInteger(estudianteId) ? estudianteId : 0]
    );
    if (!est.rows.length) return res.status(400).json({ success: false, message: 'Estudiante inválido' });
    await db.query(
        `INSERT INTO transacciones (referencia_pago, usuario_id, monto, moneda, estado, ref_epayco)
         VALUES ($1, $2, $3, 'COP', 'ACCEPTED', $4)`,
        [nuevaReferencia(estudianteId), estudianteId, PRECIO_CERTIFICADO, `MANUAL-${req.user.username}`]
    );
    res.status(201).json({ success: true, message: 'Pago marcado como aprobado: el estudiante ya puede generar un certificado' });
});

// ---------- Pagos (ePayco Sandbox) ----------
function estadoEpayco(codigo) {
    const c = String(codigo);
    if (c === '1') return 'ACCEPTED';
    if (c === '3') return 'PENDING';
    return 'REJECTED';
}

// Actualiza una transacción sin permitir "degradar" una ya aceptada
async function aplicarPago({ referencia, estado, refEpayco, monto, usuarioId }) {
    const params = [referencia, estado, refEpayco, monto];
    let extra = '';
    if (usuarioId) { params.push(usuarioId); extra = 'AND usuario_id = $5'; }
    const r = await db.query(
        `UPDATE transacciones
         SET estado = $2, ref_epayco = $3, updated_at = CURRENT_TIMESTAMP
         WHERE referencia_pago = $1 AND monto = $4 AND estado <> 'ACCEPTED' ${extra}
         RETURNING estado`,
        params
    );
    if (r.rows.length) return r.rows[0].estado;
    const actual = await db.query(
        `SELECT estado FROM transacciones WHERE referencia_pago = $1 AND monto = $2 ${usuarioId ? 'AND usuario_id = $3' : ''}`,
        usuarioId ? [referencia, monto, usuarioId] : [referencia, monto]
    );
    return actual.rows[0] ? actual.rows[0].estado : null;
}

app.get('/api/pagos/estado', auth, async (req, res) => {
    const t = await db.query(
        `SELECT t.id, t.referencia_pago, t.monto, t.estado, t.created_at,
                EXISTS (SELECT 1 FROM certificados c WHERE c.transaccion_id = t.id) AS usado
         FROM transacciones t WHERE t.usuario_id = $1 ORDER BY t.id DESC LIMIT 20`,
        [req.user.id]
    );
    const transacciones = t.rows.map((r) => ({ ...r, monto: num(r.monto) }));
    res.json({
        success: true,
        precio: PRECIO_CERTIFICADO,
        pagoDisponible: transacciones.some((x) => x.estado === 'ACCEPTED' && !x.usado),
        transacciones
    });
});

app.post('/api/pagos/iniciar', auth, rol('Estudiante'), async (req, res) => {
    const referencia = nuevaReferencia(req.user.id);
    await db.query(
        `INSERT INTO transacciones (referencia_pago, usuario_id, monto, moneda, estado) VALUES ($1, $2, $3, 'COP', 'PENDING')`,
        [referencia, req.user.id, PRECIO_CERTIFICADO]
    );
    res.json({
        success: true,
        referencia,
        monto: PRECIO_CERTIFICADO,
        publicKey: process.env.EPAYCO_PUBLIC_KEY,
        confirmationUrl: `${PUBLIC_URL}/api/pagos/webhook`
    });
});

// El frontend llama aquí al volver de ePayco (?ref_payco=...). Se valida directo con ePayco.
app.post('/api/pagos/confirmar', auth, async (req, res) => {
    const refPayco = String((req.body || {}).ref_payco || '');
    if (!/^[A-Za-z0-9_-]{3,60}$/.test(refPayco)) {
        return res.status(400).json({ success: false, message: 'Referencia de pago inválida' });
    }
    let data;
    try {
        const r = await axios.get(`https://secure.epayco.co/validation/v1/reference/${refPayco}`, { timeout: 10000 });
        data = r.data && r.data.data;
        if (!r.data || !r.data.success || !data) throw new Error('Respuesta sin datos');
    } catch (e) {
        return res.status(502).json({ success: false, message: 'No se pudo validar el pago con ePayco, intenta de nuevo' });
    }
    const estado = await aplicarPago({
        referencia: data.x_id_invoice,
        estado: estadoEpayco(data.x_cod_response),
        refEpayco: refPayco,
        monto: data.x_amount,
        usuarioId: req.user.id
    });
    if (!estado) return res.status(404).json({ success: false, message: 'No se encontró una transacción tuya con esa referencia' });
    res.json({ success: true, estado });
});

// Webhook de ePayco (solo funciona con URL pública, ej. Render). Se valida la firma.
app.post('/api/pagos/webhook', async (req, res) => {
    const b = req.body || {};
    if (!process.env.EPAYCO_P_KEY || !process.env.EPAYCO_CUSTOMER_ID) {
        console.warn('[ePayco Webhook] Falta EPAYCO_P_KEY o EPAYCO_CUSTOMER_ID: no se puede validar la firma, se ignora');
        return res.status(503).send('Webhook no configurado');
    }
    console.log(`[ePayco Webhook] Ref: ${b.x_ref_payco} | Factura: ${b.x_id_invoice} | Código: ${b.x_cod_response}`);
    const firma = crypto
        .createHash('sha256')
        .update([process.env.EPAYCO_CUSTOMER_ID, process.env.EPAYCO_P_KEY, b.x_ref_payco, b.x_transaction_id, b.x_amount, b.x_currency_code].join('^'))
        .digest('hex');
    if (!b.x_signature || !safeEqual(firma, b.x_signature)) {
        console.warn('[ePayco Webhook] Firma inválida, se ignora');
        return res.status(400).send('Firma inválida');
    }
    await aplicarPago({
        referencia: b.x_id_invoice,
        estado: estadoEpayco(b.x_cod_response),
        refEpayco: b.x_ref_payco,
        monto: b.x_amount
    });
    res.status(200).send('OK');
});

// ---------- Certificados ----------
app.get('/api/certificados/mios', auth, async (req, res) => {
    const r = await db.query(
        `SELECT codigo_verificacion, tipo_certificado, fecha_emision FROM certificados
         WHERE usuario_id = $1 AND activo ORDER BY id DESC`,
        [req.user.id]
    );
    res.json({ success: true, certificados: r.rows });
});

app.post('/api/certificados', auth, rol('Estudiante'), async (req, res) => {
    const mat = await db.query('SELECT 1 FROM matriculas WHERE estudiante_id = $1 LIMIT 1', [req.user.id]);
    if (!mat.rows.length) {
        return res.status(400).json({ success: false, message: 'No tienes asignaturas matriculadas' });
    }
    const pago = await db.query(
        `SELECT t.id FROM transacciones t
         WHERE t.usuario_id = $1 AND t.estado = 'ACCEPTED'
           AND NOT EXISTS (SELECT 1 FROM certificados c WHERE c.transaccion_id = t.id)
         ORDER BY t.id LIMIT 1`,
        [req.user.id]
    );
    if (!pago.rows.length) {
        return res.status(402).json({ success: false, message: 'Debes completar el pago antes de generar el certificado' });
    }
    const codigo = `CEP-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    try {
        await db.query(
            `INSERT INTO certificados (codigo_verificacion, usuario_id, tipo_certificado, transaccion_id)
             VALUES ($1, $2, 'Certificado de Estudios y Paz y Salvo', $3)`,
            [codigo, req.user.id, pago.rows[0].id]
        );
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ success: false, message: 'Ese pago ya fue usado, intenta de nuevo' });
        throw e;
    }
    res.status(201).json({ success: true, codigo });
});

app.get('/api/certificados/:codigo/pdf', auth, async (req, res) => {
    const c = await db.query(
        `SELECT c.codigo_verificacion, c.tipo_certificado, c.fecha_emision, c.usuario_id,
                u.nombre_completo, u.username, p.nombre AS programa, p.resolucion AS programa_resolucion
         FROM certificados c JOIN usuarios u ON u.id = c.usuario_id
         LEFT JOIN programas p ON p.id = u.programa_id
         WHERE c.codigo_verificacion = $1 AND c.activo`,
        [req.params.codigo]
    );
    const cert = c.rows[0];
    if (!cert) return res.status(404).json({ success: false, message: 'Certificado no encontrado' });
    if (cert.usuario_id !== req.user.id && req.user.rol !== 'Administrador') {
        return res.status(403).json({ success: false, message: 'No tienes acceso a este certificado' });
    }
    const n = await db.query(
        `SELECT a.nombre, m.periodo,
                MAX(CASE WHEN c.corte = 1 THEN c.nota END) AS c1,
                MAX(CASE WHEN c.corte = 2 THEN c.nota END) AS c2,
                MAX(CASE WHEN c.corte = 3 THEN c.nota END) AS c3
         FROM matriculas m JOIN asignaturas a ON a.id = m.asignatura_id
         LEFT JOIN calificaciones c ON c.matricula_id = m.id
         WHERE m.estudiante_id = $1 GROUP BY a.nombre, m.periodo ORDER BY m.periodo DESC, a.nombre`,
        [cert.usuario_id]
    );
    const periodos = [...new Set(n.rows.map((row) => row.periodo))].join(', ') || periodoActual();
    const urlVerificacion = `${PUBLIC_URL}/verificar/${cert.codigo_verificacion}`;
    const qr = await QRCode.toBuffer(urlVerificacion, { width: 220, margin: 1 });

    const doc = new PDFDocument({ size: 'LETTER', margin: 60 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${cert.codigo_verificacion}.pdf"`);
    doc.pipe(res);

    doc.fontSize(22).fillColor('#2b6cb0').text('CEPDECO', { align: 'center' });
    doc.fontSize(10).fillColor('#718096').text(RAZON_SOCIAL, { align: 'center' });
    doc.fontSize(9).text(`NIT ${NIT} · Licencia de funcionamiento: ${LICENCIA}`, { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(16).fillColor('#2d3748').text(cert.tipo_certificado.toUpperCase(), { align: 'center' });
    doc.moveDown(1.5);
    doc.fontSize(11).fillColor('#2d3748').text(
        `La Corporación certifica que ${cert.nombre_completo} (usuario ${cert.username}) tiene registro ` +
        `en el sistema académico y se encuentra a paz y salvo por concepto del trámite de expedición de este certificado, ` +
        `con el siguiente registro de calificaciones:`,
        { align: 'justify' }
    );
    doc.moveDown(0.8);
    const x0 = 60;
    doc.fontSize(10).fillColor('#2d3748')
        .text(`Programa técnico laboral: ${cert.programa ? `${cert.programa} (Resolución ${cert.programa_resolucion})` : 'Sin asignar'}`, x0)
        .text(`Periodo: ${periodos}`, x0);
    doc.moveDown(1);

    const cols = [x0, 280, 330, 380, 430, 485];
    const ancho = (i) => (i === 0 ? 210 : i === 5 ? 70 : 45);
    let y = doc.y;
    doc.fontSize(9).fillColor('#4a5568');
    ['Asignatura', 'Corte 1', 'Corte 2', 'Corte 3', 'Acum.', 'Estado'].forEach((t, i) => doc.text(t, cols[i], y, { width: ancho(i) }));
    y += 16;
    doc.moveTo(x0, y - 3).lineTo(552, y - 3).strokeColor('#cbd5e0').stroke();
    doc.fillColor('#2d3748');
    n.rows.forEach((row) => {
        const r = resumenNotas(row.c1, row.c2, row.c3);
        const fila = [row.nombre, ...r.notas.map((v) => (v === null ? '-' : v.toFixed(1))), r.acumulado.toFixed(2), r.estado];
        fila.forEach((t, i) => doc.text(t, cols[i], y, { width: ancho(i) }));
        y += 18;
    });
    doc.y = y + 20;
    doc.fontSize(9).fillColor('#718096')
        .text(`Nota mínima aprobatoria: ${NOTA_MINIMA.toFixed(1)}. El estado se define al tener los 3 cortes.`, x0, doc.y)
        .text(`Fecha de emisión: ${new Date(cert.fecha_emision).toLocaleDateString('es-CO')}`, x0);

    if (FIRMA_CERTIFICADO) {
        const fy = doc.y + 55;
        doc.moveTo(206, fy).lineTo(406, fy).strokeColor('#4a5568').stroke();
        doc.fontSize(10).fillColor('#2d3748').text(FIRMA_CERTIFICADO.nombre, x0, fy + 6, { width: 492, align: 'center' });
        doc.fontSize(9).fillColor('#4a5568').text(FIRMA_CERTIFICADO.cargo, x0, doc.y, { width: 492, align: 'center' });
    }

    const qrY = Math.max(doc.y + 30, 540);
    doc.image(qr, x0, qrY, { width: 110 });
    doc.fontSize(10).fillColor('#2d3748').text('Verificación pública', 190, qrY + 10);
    doc.fontSize(9).fillColor('#4a5568')
        .text(`Código: ${cert.codigo_verificacion}`, 190, qrY + 28)
        .text('Escanee el código QR para validar la autenticidad', 190, qrY + 44)
        .text(urlVerificacion, 190, qrY + 60, { width: 360 });
    // En la demo, marca de agua: los certificados de prueba no tienen validez (lo dicen los Términos de uso)
    if (MODO_DEMO) {
        doc.save().rotate(-35, { origin: [306, 396] }).fontSize(46).fillColor('#c53030').fillOpacity(0.18)
            .text('DOCUMENTO DE PRUEBA', 0, 340, { width: 612, align: 'center', lineBreak: false })
            .fontSize(24).text('Sin validez · Versión de demostración', 0, 410, { width: 612, align: 'center', lineBreak: false }).restore();
    }
    doc.end();
});

// Verificación pública (la que abre el QR)
async function buscarCertificado(codigo) {
    const r = await db.query(
        `SELECT c.codigo_verificacion, c.tipo_certificado, c.fecha_emision, u.nombre_completo
         FROM certificados c JOIN usuarios u ON u.id = c.usuario_id
         WHERE c.codigo_verificacion = $1 AND c.activo`,
        [codigo]
    );
    return r.rows[0] || null;
}

app.get('/api/verificar/:codigo', async (req, res) => {
    const c = await buscarCertificado(req.params.codigo);
    if (!c) return res.status(404).json({ valido: false });
    res.json({ valido: true, codigo: c.codigo_verificacion, titular: c.nombre_completo, tipo: c.tipo_certificado, fecha_emision: c.fecha_emision });
});

app.get('/verificar/:codigo', async (req, res) => {
    const c = await buscarCertificado(req.params.codigo);
    const caja = c
        ? `<p class="estado ok"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>Certificado válido</p>
           <p class="nota">Este documento fue emitido por CEPDECO y está activo.</p>
           ${MODO_DEMO ? '<p class="nota"><strong>Versión de demostración:</strong> este es un certificado de prueba y no tiene validez académica.</p>' : ''}
           <dl>
             <dt>Titular</dt><dd>${escapeHtml(c.nombre_completo)}</dd>
             <dt>Documento</dt><dd>${escapeHtml(c.tipo_certificado)}</dd>
             <dt>Código</dt><dd class="codigo">${escapeHtml(c.codigo_verificacion)}</dd>
             <dt>Emitido</dt><dd>${new Date(c.fecha_emision).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' })}</dd>
           </dl>`
        : `<p class="estado error"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>Certificado no encontrado</p>
           <p class="nota">El código <strong class="codigo">${escapeHtml(req.params.codigo)}</strong> no corresponde a ningún certificado activo emitido por CEPDECO.
           Revisa que lo hayas escrito completo o escanea de nuevo el QR.</p>`;
    res.status(c ? 200 : 404).send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verificación de certificado - CEPDECO</title>
<link rel="stylesheet" href="/fonts/fonts.css">
<style>
  :root { --azul:#1d3a8a; --azul-oscuro:#14295f; --amarillo:#f2c200; --rojo:#d52b1e; --tinta:#1b2330; --tinta-2:#46505f; --tinta-3:#5f6a79;
          --linea:#e1e5eb; --fondo:#f3f5f8; --ok-fondo:#e6f4ea; --ok-tinta:#1b5e31; --error-fondo:#fdeceb; --error-tinta:#9f2318; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'Source Sans 3','Segoe UI',system-ui,sans-serif; font-size:1rem; line-height:1.5; background:var(--fondo); color:var(--tinta); min-height:100vh; display:flex; flex-direction:column; }
  ::selection { background:#eaeffa; color:var(--azul-oscuro); }
  .barra { background:var(--azul-oscuro); color:#fff; padding:12px 32px; display:flex; align-items:baseline; gap:12px; }
  .barra strong { font-size:1.25rem; font-weight:700; letter-spacing:.02em; }
  .barra span { font-size:.9375rem; color:#c9d3ea; padding-left:12px; border-left:1px solid rgba(255,255,255,.3); }
  .franja { height:4px; background:linear-gradient(90deg,var(--amarillo) 0 50%,var(--azul) 50% 75%,var(--rojo) 75% 100%); }
  main { flex:1; display:flex; justify-content:center; align-items:flex-start; padding:48px 16px; }
  .tarjeta { background:#fff; border:1px solid var(--linea); border-radius:12px; padding:32px; width:100%; max-width:480px; }
  .logo { display:block; width:120px; height:auto; margin:0 auto 16px; }
  h1 { font-size:1.125rem; font-weight:600; color:var(--tinta-2); text-align:center; margin-bottom:24px; }
  .estado { display:flex; align-items:center; gap:10px; font-size:1.375rem; font-weight:700; padding:12px 16px; border-radius:10px; }
  .estado svg { width:26px; height:26px; flex:none; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .estado.ok { background:var(--ok-fondo); color:var(--ok-tinta); }
  .estado.error { background:var(--error-fondo); color:var(--error-tinta); }
  .nota { color:var(--tinta-3); font-size:.9375rem; margin:12px 0 0; text-wrap:pretty; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:10px 20px; margin-top:20px; padding-top:20px; border-top:1px solid var(--linea); }
  dt { color:var(--tinta-3); font-size:.875rem; font-weight:600; }
  dd { font-weight:600; overflow-wrap:anywhere; }
  .codigo { font-variant-numeric:tabular-nums; letter-spacing:.02em; overflow-wrap:anywhere; }
  footer { text-align:center; color:var(--tinta-3); font-size:.8125rem; padding:0 16px 32px; }
  @media (max-width:520px) { .barra { padding:10px 16px; } .barra span { display:none; } .tarjeta { padding:24px 20px; } main { padding:24px 16px; } }
</style></head>
<body>
<header class="barra"><strong>CEPDECO</strong><span>Verificación de certificados</span></header>
<div class="franja"></div>
<main><div class="tarjeta">
  <img class="logo" src="/img/logo-cepdeco.png" width="360" height="307" alt="CEPDECO">
  <h1>Verificación pública de certificados</h1>
  ${caja}
</div></main>
<footer>${RAZON_SOCIAL} · NIT ${NIT}<br>Licencia de funcionamiento: ${LICENCIA}<br>
<a href="/legal/privacidad.html">Tratamiento de datos</a> · <a href="/legal/terminos.html">Términos de uso</a></footer>
</body></html>`);
});

// ---------- Errores ----------
app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Ruta no encontrada' }));

// Errores de conexión con la BD: clave incorrecta (28P01), servidor caído o sin respuesta
const esErrorDeBD = (err) =>
    ['28P01', '28000', '57P01', '53300', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'].includes(err.code) ||
    /timeout|Connection terminated|credentials/i.test(err.message || '');

app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'JSON inválido' });
    if (err.type === 'entity.too.large') return res.status(413).json({ success: false, message: 'El archivo es muy grande (máximo 2 MB)' });
    if (err.status && err.status < 500) return res.status(err.status).json({ success: false, message: err.message });
    if (res.headersSent) return next(err);
    if (esErrorDeBD(err)) {
        console.error(`❌ Sin conexión con la BD (${err.code || 'sin código'}): ${err.message}`);
        return res.status(503).json({ success: false, message: 'El portal no pudo conectarse a la base de datos. Intenta de nuevo en un momento.' });
    }
    console.error('Error:', err);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 Servidor Backend corriendo exitosamente en el puerto ${PORT}`));
}

module.exports = app;
