const express = require('express');
const cors = require('cors');
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

const PORT = process.env.PORT || 5000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PRECIO_CERTIFICADO = 25000;
const LICENCIA = 'Resolución 002844';
// Firma del certificado. PENDIENTE: autorización de CEPDECO para usar el nombre.
// Para quitarla del PDF: const FIRMA_CERTIFICADO = null;
const FIRMA_CERTIFICADO = { nombre: 'Edenia Ayola Ortega', cargo: 'Directora General' };
// Admin puede marcar pagos como aprobados a mano (pruebas / pago en secretaría). Se apaga con PAGO_MANUAL=off
const PAGO_MANUAL = process.env.PAGO_MANUAL !== 'off';

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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
    // Con clave temporal solo se permite consultar la sesión y cambiar la clave
    if (req.user.cambiarClave && !['/api/auth/me', '/api/auth/cambiar-clave'].includes(req.path)) {
        return res.status(403).json({ success: false, message: 'Debes cambiar tu contraseña temporal antes de continuar' });
    }
    next();
}

const firmarSesion = (u) => {
    const perfil = { id: u.id, username: u.username, nombre: u.nombre_completo, email: u.email, rol: u.rol, cambiarClave: !!u.debe_cambiar_clave };
    return { token: jwt.sign(perfil, JWT_SECRET, { expiresIn: '8h' }), user: perfil };
};

const rol = (...roles) => (req, res, next) =>
    roles.includes(req.user.rol)
        ? next()
        : res.status(403).json({ success: false, message: 'No tienes permiso para esta acción' });

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
        res.status(500).json({ status: 'ERROR', message: 'Error conectando a la BD', error: error.message });
    }
});

// ---------- Autenticación ----------
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Usuario y contraseña son obligatorios' });
    }

    const result = await db.query(
        `SELECT u.id, u.username, u.nombre_completo, u.email, u.password_hash, u.debe_cambiar_clave, r.nombre AS rol
         FROM usuarios u JOIN roles r ON u.rol_id = r.id
         WHERE LOWER(u.username) = LOWER($1)`,
        [String(username).trim()]
    );
    const user = result.rows[0];
    const fallo = () => res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
    if (!user) return fallo();

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

    res.json({ success: true, ...firmarSesion(user) });
});

app.get('/api/auth/me', auth, (req, res) => res.json({ success: true, user: req.user }));

// Información pública: cursos que ofrece CEPDECO (para el inicio y el login)
app.get('/api/programas', async (req, res) => {
    const r = await db.query('SELECT id, nombre, resolucion FROM programas ORDER BY nombre');
    res.json({ success: true, programas: r.rows });
});

// Datos del usuario en sesión (Mis datos personales / Mi programa)
app.get('/api/perfil', auth, async (req, res) => {
    const r = await db.query(
        `SELECT u.username, u.nombre_completo, u.email, u.created_at, r.nombre AS rol,
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
    res.json({ success: true, message: 'Contraseña actualizada', ...firmarSesion({ ...u, debe_cambiar_clave: false }) });
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
            `SELECT m.id AS matricula_id, m.asignatura_id, u.nombre_completo, u.username,
                    MAX(CASE WHEN c.corte = 1 THEN c.nota END) AS c1,
                    MAX(CASE WHEN c.corte = 2 THEN c.nota END) AS c2,
                    MAX(CASE WHEN c.corte = 3 THEN c.nota END) AS c3
             FROM matriculas m
             JOIN usuarios u ON u.id = m.estudiante_id
             LEFT JOIN calificaciones c ON c.matricula_id = m.id
             WHERE m.asignatura_id = ANY($1)
             GROUP BY m.id, m.asignatura_id, u.nombre_completo, u.username
             ORDER BY u.nombre_completo`,
            [ids]
        );
        alumnos = r.rows;
    }
    res.json({
        success: true,
        asignaturas: asig.rows.map((a) => ({
            ...a,
            estudiantes: alumnos
                .filter((s) => s.asignatura_id === a.id)
                .map((s) => ({
                    matricula_id: s.matricula_id,
                    nombre: s.nombre_completo,
                    username: s.username,
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

// ---------- Administrador ----------
app.get('/api/admin/resumen', auth, rol('Administrador'), async (req, res) => {
    const usuarios = await db.query(
        `SELECT u.id, u.username, u.nombre_completo, u.email, r.nombre AS rol, u.programa_id, p.nombre AS programa
         FROM usuarios u JOIN roles r ON r.id = u.rol_id
         LEFT JOIN programas p ON p.id = u.programa_id ORDER BY u.id`
    );
    const asignaturas = await db.query(
        `SELECT a.id, a.nombre, a.programa_id, u.nombre_completo AS docente
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
    const { username, password, nombre_completo, email, rol: nombreRol, programa_id } = req.body || {};
    if (!username || !password || !nombre_completo || !email || !nombreRol) {
        return res.status(400).json({ success: false, message: 'Todos los campos son obligatorios' });
    }
    if (String(password).length < 8) {
        return res.status(400).json({ success: false, message: 'La contraseña debe tener al menos 8 caracteres' });
    }
    const r = await db.query('SELECT id FROM roles WHERE nombre = $1', [nombreRol]);
    if (!r.rows.length) return res.status(400).json({ success: false, message: 'Rol inválido' });
    try {
        const hash = await bcrypt.hash(String(password), 10);
        await db.query(
            // La clave que pone el admin es temporal: el usuario la cambia al entrar
            `INSERT INTO usuarios (username, password_hash, nombre_completo, email, rol_id, programa_id, debe_cambiar_clave) VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
            [String(username).trim(), hash, String(nombre_completo).trim(), String(email).trim(), r.rows[0].id,
             nombreRol === 'Estudiante' && programa_id ? programa_id : null]
        );
        res.status(201).json({ success: true, message: 'Usuario creado: deberá cambiar la clave en su primer ingreso' });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ success: false, message: 'El usuario o el correo ya existen' });
        if (e.code === '23503' || e.code === '22P02') return res.status(400).json({ success: false, message: 'Programa inválido' });
        throw e;
    }
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
    doc.fontSize(10).fillColor('#718096').text('Corporación Educativa para el Desarrollo de Colombia', { align: 'center' });
    doc.fontSize(9).text(`Licencia de funcionamiento: ${LICENCIA}`, { align: 'center' });
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
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet">
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
<div class="barra"><strong>CEPDECO</strong><span>Verificación de certificados</span></div>
<div class="franja"></div>
<main><div class="tarjeta">
  <img class="logo" src="/img/logo-cepdeco.png" width="787" height="672" alt="CEPDECO">
  <h1>Verificación pública de certificados</h1>
  ${caja}
</div></main>
<footer>Licencia de funcionamiento: ${LICENCIA}</footer>
</body></html>`);
});

// ---------- Errores ----------
app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Ruta no encontrada' }));

app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'JSON inválido' });
    console.error('Error:', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 Servidor Backend corriendo exitosamente en el puerto ${PORT}`));
}

module.exports = app;
