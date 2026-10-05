const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 5000;

// Ruta de prueba de estado
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Servidor Backend CEPDECO funcionando correctamente' });
});

// Endpoint Webhook para recibir confirmaciones de pago desde ePayco Sandbox
app.post('/api/pagos/webhook', (req, res) => {
    const { x_ref_payco, x_transaction_state, x_extra1 } = req.body;
    
    console.log(`[ePayco Webhook] Pago recibido - Ref: ${x_ref_payco} | Estado: ${x_transaction_state} | Usuario: ${x_extra1}`);

    // Estado en ePayco: 1 = Aceptada, 2 = Rechazada, 3 = Pendiente
    if (x_transaction_state == "1" || x_transaction_state == "Aceptada") {
        console.log(`✅ Pago Aprobado para el usuario: ${x_extra1}. Actualizando estado a Paz y Salvo en la base de datos.`);
    }

    res.status(200).send('OK');
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor Backend corriendo exitosamente en el puerto ${PORT}`);
});