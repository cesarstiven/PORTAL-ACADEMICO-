const pg = require('pg');
require('dotenv').config();

// Forzar IPv4 (soluciona el ETIMEDOUT con direcciones 2600:...)
pg.defaults.family = 4;

// SSL solo para bases remotas (Supabase); en local no se usa
const url = process.env.DATABASE_URL || '';
const esLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);

const pool = new pg.Pool({
    connectionString: url,
    ssl: esLocal ? false : { rejectUnauthorized: false }
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool
};
