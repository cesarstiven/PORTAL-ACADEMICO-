// Borra SOLO los datos creados por seed-gerente.js: demo.gerente, demo.estNNN, demo.docNN, demo.admNN (no toca demo.admin)
// y las asignaturas "(demo)" de esos docentes. Matrículas, notas, cartera y abonos se borran en cascada. Uso: node limpiar-demo-gerente.js
const db = require('./db');

const DEMO = `username = 'demo.gerente' OR username ~ '^demo\\.(est[0-9]{3}|doc[0-9]{2}|adm[0-9]{2})$'`;

(async () => {
    const cli = await db.pool.connect();
    try {
        await cli.query('BEGIN');
        const a = await cli.query(`DELETE FROM asignaturas WHERE nombre LIKE '% (demo)' AND docente_id IN (SELECT id FROM usuarios WHERE ${DEMO})`);
        await cli.query(`UPDATE abonos_matricula SET registrado_por = NULL WHERE registrado_por IN (SELECT id FROM usuarios WHERE ${DEMO})`);
        const u = await cli.query(`DELETE FROM usuarios WHERE ${DEMO}`);
        await cli.query('COMMIT');
        console.log(`✅ Borrados ${u.rowCount} usuarios demo y ${a.rowCount} asignaturas demo (con sus matrículas, notas, cartera y abonos)`);
        process.exit(0);
    } catch (e) {
        await cli.query('ROLLBACK');
        console.error('❌', e.message);
        process.exit(1);
    } finally {
        cli.release();
    }
})();
