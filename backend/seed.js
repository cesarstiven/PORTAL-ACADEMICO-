// Datos de demo. Uso: node seed.js   (correr DESPUÉS de schema.sql)
const bcrypt = require('bcryptjs');
const db = require('./db');

const PASS = process.env.SEED_PASSWORD || 'Cepdeco2026*';

async function main() {
    const hash = await bcrypt.hash(PASS, 10);
    const usuarios = [
        ['ceshernandez', 'Cesar Hernandez',   'cesar.hernandez@cepdeco.edu.co', 'Administrador'],
        ['docente1',     'Docente Demo',      'docente1@cepdeco.edu.co',        'Docente'],
        ['estudiante1',  'Estudiante Demo',   'estudiante1@cepdeco.edu.co',     'Estudiante'],
        ['estudiante2',  'Estudiante Dos',    'estudiante2@cepdeco.edu.co',     'Estudiante'],
    ];
    for (const [username, nombre, email, rol] of usuarios) {
        await db.query(
            `INSERT INTO usuarios (username, password_hash, nombre_completo, email, rol_id)
             VALUES ($1, $2, $3, $4, (SELECT id FROM roles WHERE nombre = $5))
             ON CONFLICT (username) DO UPDATE
               SET password_hash = EXCLUDED.password_hash,
                   nombre_completo = EXCLUDED.nombre_completo,
                   rol_id = EXCLUDED.rol_id`,
            [username, hash, nombre, email, rol]
        );
    }

    const docente = (await db.query(`SELECT id FROM usuarios WHERE username='docente1'`)).rows[0].id;
    for (const nombre of ['Taller de Proyectos Interdisciplinarios 3 (TPI3)', 'Sistemas de Control y Automatización']) {
        await db.query(
            `INSERT INTO asignaturas (nombre, docente_id) VALUES ($1, $2)
             ON CONFLICT (nombre) DO UPDATE SET docente_id = EXCLUDED.docente_id`,
            [nombre, docente]
        );
    }
    await db.query(
        `INSERT INTO matriculas (estudiante_id, asignatura_id)
         SELECT u.id, a.id FROM usuarios u CROSS JOIN asignaturas a
         WHERE u.username IN ('estudiante1','estudiante2')
         ON CONFLICT DO NOTHING`
    );
    await db.query(
        `INSERT INTO calificaciones (matricula_id, corte, nota)
         SELECT m.id, c.corte, c.nota
         FROM matriculas m
         JOIN usuarios u ON u.id = m.estudiante_id AND u.username = 'estudiante1'
         JOIN asignaturas a ON a.id = m.asignatura_id
         JOIN (VALUES (1, 4.5), (2, 4.8)) AS c(corte, nota) ON a.nombre LIKE 'Taller%'
         ON CONFLICT DO NOTHING`
    );

    console.log('✅ Seed listo. Usuarios (clave para todos: ' + PASS + '):');
    usuarios.forEach(u => console.log(`   ${u[0].padEnd(14)} ${u[3]}`));
    await db.pool.end();
}

main().catch(e => { console.error('❌ Error en seed:', e.message); process.exit(1); });
