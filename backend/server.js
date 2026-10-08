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

const PORT = process.env.PORT || 5000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PRECIO_CERTIFICADO = 25000;
const PESOS = [0.3, 0.3, 0.4];

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
const num = (v) => (v === null || v === undefined ? null : parseFloat(v));

function auth(req, res, next) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Sesión requerida' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ success: false, message: 'Sesión inválida o expirada' });
    }
}

const rol = (...roles) => (req, res, next) =>
    roles.includes(req.user.rol)
        ? next()
        : res.status(403).json({ success: false, message: 'No tienes permiso para esta acción' });

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function resumenNotas(c1, c2, c3) {
    const notas = [num(c1), num(c2), num(c3)];
    const acumulado = notas.reduce((s, n, i) => s + (n === null ? 0 : n * PESOS[i]), 0);
    const completa = notas.every((n) => n !== null);
    return { notas, acumulado: Math.round(acumulado * 100) / 100, completa };
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
        `SELECT u.id, u.username, u.nombre_completo, u.email, u.password_hash, r.nombre AS rol
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

    const perfil = { id: user.id, username: user.username, nombre: user.nombre_completo, email: user.email, rol: user.rol };
    const token = jwt.sign(perfil, JWT_SECRET, { expiresIn: '8h' });
    res.json({ success: true, token, user: perfil });
});

app.get('/api/auth/me', auth, (req, res) => res.json({ success: true, user: req.user }));

// ---------- Estudiante: notas ----------
app.get('/api/notas', auth, rol('Estudiante'), async (req, res) => {
    const r = await db.query(
        `SELECT a.id, a.nombre,
                MAX(CASE WHEN c.corte = 1 THEN c.nota END) AS c1,
                MAX(CASE WHEN c.corte = 2 THEN c.nota END) AS c2,
                MAX(CASE WHEN c.corte = 3 THEN c.nota END) AS c3
         FROM matriculas m
         JOIN asignaturas a ON a.id = m.asignatura_id
         LEFT JOIN calificaciones c ON c.matricula_id = m.id
         WHERE m.estudiante_id = $1
         GROUP BY a.id, a.nombre
         ORDER BY a.nombre`,
        [req.user.id]
    );
    res.json({
        success: true,
        asignaturas: r.rows.map((row) => ({ id: row.id, nombre: row.nombre, ...resumenNotas(row.c1, row.c2, row.c3) }))
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
        `SELECT u.id, u.username, u.nombre_completo, u.email, r.nombre AS rol
         FROM usuarios u JOIN roles r ON r.id = u.rol_id ORDER BY u.id`
    );
    const asignaturas = await db.query(
        `SELECT a.id, a.nombre, u.nombre_completo AS docente
         FROM asignaturas a LEFT JOIN usuarios u ON u.id = a.docente_id ORDER BY a.nombre`
    );
    res.json({ success: true, usuarios: usuarios.rows, asignaturas: asignaturas.rows });
});

app.post('/api/admin/usuarios', auth, rol('Administrador'), async (req, res) => {
    const { username, password, nombre_completo, email, rol: nombreRol } = req.body || {};
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
            `INSERT INTO usuarios (username, password_hash, nombre_completo, email, rol_id) VALUES ($1, $2, $3, $4, $5)`,
            [String(username).trim(), hash, String(nombre_completo).trim(), String(email).trim(), r.rows[0].id]
        );
        res.status(201).json({ success: true, message: 'Usuario creado' });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ success: false, message: 'El usuario o el correo ya existen' });
        throw e;
    }
});

app.post('/api/admin/asignaturas', auth, rol('Administrador'), async (req, res) => {
    const { nombre, docente_id } = req.body || {};
    if (!nombre) return res.status(400).json({ success: false, message: 'El nombre es obligatorio' });
    try {
        await db.query('INSERT INTO asignaturas (nombre, docente_id) VALUES ($1, $2)', [String(nombre).trim(), docente_id || null]);
        res.status(201).json({ success: true, message: 'Asignatura creada' });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ success: false, message: 'Esa asignatura ya existe' });
        if (e.code === '23503') return res.status(400).json({ success: false, message: 'Docente inexistente' });
        throw e;
    }
});

app.post('/api/admin/matriculas', auth, rol('Administrador'), async (req, res) => {
    const { estudiante_id, asignatura_id } = req.body || {};
    try {
        await db.query(
            'INSERT INTO matriculas (estudiante_id, asignatura_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [estudiante_id, asignatura_id]
        );
        res.status(201).json({ success: true, message: 'Estudiante matriculado' });
    } catch (e) {
        if (e.code === '23503' || e.code === '22P02') return res.status(400).json({ success: false, message: 'Estudiante o asignatura inválidos' });
        throw e;
    }
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
    const referencia = `CEP-${Date.now()}-${req.user.id}-${crypto.randomBytes(2).toString('hex')}`;
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
                u.nombre_completo, u.username
         FROM certificados c JOIN usuarios u ON u.id = c.usuario_id
         WHERE c.codigo_verificacion = $1 AND c.activo`,
        [req.params.codigo]
    );
    const cert = c.rows[0];
    if (!cert) return res.status(404).json({ success: false, message: 'Certificado no encontrado' });
    if (cert.usuario_id !== req.user.id && req.user.rol !== 'Administrador') {
        return res.status(403).json({ success: false, message: 'No tienes acceso a este certificado' });
    }
    const n = await db.query(
        `SELECT a.nombre,
                MAX(CASE WHEN c.corte = 1 THEN c.nota END) AS c1,
                MAX(CASE WHEN c.corte = 2 THEN c.nota END) AS c2,
                MAX(CASE WHEN c.corte = 3 THEN c.nota END) AS c3
         FROM matriculas m JOIN asignaturas a ON a.id = m.asignatura_id
         LEFT JOIN calificaciones c ON c.matricula_id = m.id
         WHERE m.estudiante_id = $1 GROUP BY a.nombre ORDER BY a.nombre`,
        [cert.usuario_id]
    );
    const urlVerificacion = `${PUBLIC_URL}/verificar/${cert.codigo_verificacion}`;
    const qr = await QRCode.toBuffer(urlVerificacion, { width: 220, margin: 1 });

    const doc = new PDFDocument({ size: 'LETTER', margin: 60 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${cert.codigo_verificacion}.pdf"`);
    doc.pipe(res);

    doc.fontSize(22).fillColor('#2b6cb0').text('CEPDECO', { align: 'center' });
    doc.fontSize(10).fillColor('#718096').text('Corporación Educativa para el Desarrollo de Colombia', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(16).fillColor('#2d3748').text(cert.tipo_certificado.toUpperCase(), { align: 'center' });
    doc.moveDown(1.5);
    doc.fontSize(11).fillColor('#2d3748').text(
        `La Corporación certifica que ${cert.nombre_completo} (usuario ${cert.username}) se encuentra registrado(a) ` +
        `en el sistema académico y a paz y salvo por concepto del trámite de expedición de este certificado, ` +
        `con el siguiente registro de calificaciones:`,
        { align: 'justify' }
    );
    doc.moveDown(1);

    const x0 = 60;
    const cols = [x0, 330, 385, 440, 495];
    let y = doc.y;
    doc.fontSize(9).fillColor('#4a5568');
    ['Asignatura', 'Corte 1', 'Corte 2', 'Corte 3', 'Acum.'].forEach((t, i) => doc.text(t, cols[i], y, { width: i ? 50 : 260 }));
    y += 16;
    doc.moveTo(x0, y - 3).lineTo(552, y - 3).strokeColor('#cbd5e0').stroke();
    doc.fillColor('#2d3748');
    n.rows.forEach((row) => {
        const r = resumenNotas(row.c1, row.c2, row.c3);
        const fila = [row.nombre, ...r.notas.map((v) => (v === null ? '-' : v.toFixed(1))), r.acumulado.toFixed(2)];
        fila.forEach((t, i) => doc.text(t, cols[i], y, { width: i ? 50 : 260 }));
        y += 18;
    });
    doc.y = y + 20;
    doc.fontSize(9).fillColor('#718096').text(
        `Fecha de emisión: ${new Date(cert.fecha_emision).toLocaleDateString('es-CO')}`, x0, doc.y
    );

    const qrY = Math.max(doc.y + 30, 520);
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
        ? `<h2 style="color:#22543d">✅ Certificado válido</h2>
           <p><strong>Titular:</strong> ${escapeHtml(c.nombre_completo)}</p>
           <p><strong>Documento:</strong> ${escapeHtml(c.tipo_certificado)}</p>
           <p><strong>Código:</strong> ${escapeHtml(c.codigo_verificacion)}</p>
           <p><strong>Emitido:</strong> ${new Date(c.fecha_emision).toLocaleDateString('es-CO')}</p>`
        : `<h2 style="color:#9b2c2c">❌ Certificado no encontrado</h2>
           <p>El código <strong>${escapeHtml(req.params.codigo)}</strong> no corresponde a ningún certificado emitido por CEPDECO.</p>`;
    res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verificación de certificado - CEPDECO</title></head>
<body style="font-family:Segoe UI,Arial,sans-serif;background:#f4f7f6;display:flex;justify-content:center;padding:40px 16px">
<div style="background:#fff;max-width:480px;width:100%;padding:28px;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,.08);line-height:1.6">
<h3 style="color:#2b6cb0">Portal Web CEPDECO</h3>${caja}</div></body></html>`);
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
