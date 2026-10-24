const pg = require('pg');
require('dotenv').config();

// Forzar IPv4 (soluciona el ETIMEDOUT con direcciones 2600:...)
pg.defaults.family = 4;

// SSL solo para bases remotas (Supabase); en local no se usa
const url = process.env.DATABASE_URL || '';
const esLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
if (!url) console.error('❌ Falta DATABASE_URL: el portal no podrá conectarse a la base de datos');

const pool = new pg.Pool({
    connectionString: url,
    ssl: esLocal ? false : { rejectUnauthorized: false },
    // Sin esto, si Supabase no responde (pausado, URL mala) la consulta se queda colgada para siempre
    connectionTimeoutMillis: 10000
});
pool.on('error', (e) => console.error('❌ Error en la conexión a la BD:', e.message));

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool
};
