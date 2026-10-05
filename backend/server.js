const express = require('express');
const cors = require('cors');
require('dotenv').config();
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 5000;

// Ruta de prueba de salud e integración con BD
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

// Endpoint 1: Autenticación / Login desde la Base de Datos
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const queryText = `
            SELECT u.id, u.username, u.nombre_completo, u.email, u.password_hash, r.nombre AS rol
            FROM usuarios u
            JOIN roles r ON u.rol_id = r.id
            WHERE u.username = $1
        `;
        const result = await db.query(queryText, [username]);

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Usuario no encontrado' });
        }

        const user = result.rows[0];

        // Verificación básica de contraseña (para desarrollo)
        if (user.password_hash !== password) {
            return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        }

        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                nombre: user.nombre_completo,
                email: user.email,
                rol: user.rol
            }
        });
    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
});

// Endpoint 2: Webhook de ePayco (Guarda transacciones reales en Supabase)
app.post('/api/pagos/webhook', async (req, res) => {
    const { 
        x_ref_payco, 
        x_transaction_state, 
        x_amount, 
        x_currency_code, 
        x_extra1 
    } = req.body;

    console.log(`[ePayco Webhook] Notificación recibida - Ref: ${x_ref_payco} | Estado: ${x_transaction_state}`);

    try {
        // Buscar el ID del usuario en la BD por su username
        const userRes = await db.query('SELECT id FROM usuarios WHERE username = $1', [x_extra1 || 'ceshernandez']);
        const usuarioId = userRes.rows[0]?.id || 1;

        // Registrar o actualizar la transacción en la tabla 'transacciones'
        const upsertQuery = `
            INSERT INTO transacciones (referencia_pago, usuario_id, monto, moneda, estado, ref_epayco)
            VALUES ($1, $2, $3, $4, $5, $1)
            ON CONFLICT (referencia_pago) 
            DO UPDATE SET estado = EXCLUDED.estado, updated_at = CURRENT_TIMESTAMP;
        `;

        let estadoTexto = 'PENDING';
        if (x_transaction_state == '1' || x_transaction_state == 'Aceptada') estadoTexto = 'ACCEPTED';
        if (x_transaction_state == '2' || x_transaction_state == 'Rechazada') estadoTexto = 'REJECTED';

        await db.query(upsertQuery, [x_ref_payco, usuarioId, x_amount || 25000, x_currency_code || 'COP', estadoTexto]);

        res.status(200).send('OK');
    } catch (error) {
        console.error('Error procesando webhook:', error);
        res.status(500).send('Error interno');
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor Backend corriendo exitosamente en el puerto ${PORT}`);
});