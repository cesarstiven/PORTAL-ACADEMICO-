// Datos de demostración para el rol Gerente: 100 estudiantes, 12 docentes, 4 administrativos (Secretaria) y demo.gerente,
// con cartera de matrículas, abonos, notas de 3 cortes y vigencias de cuenta. Uso: node seed-gerente.js (después de schema.sql)
// Se puede correr varias veces (mismos datos). Para borrarlos: node limpiar-demo-gerente.js
// Todas las cuentas demo usan la clave de SEED_GERENTE_PASSWORD (backend/.env); no hay claves en el código.
const bcrypt = require('bcryptjs');
const db = require('./db');
const { periodoActual } = require('./academico');

const PASS = process.env.SEED_GERENTE_PASSWORD;

// Números pseudoaleatorios con semilla fija: cada corrida genera exactamente los mismos datos
let semilla = 20261108;
const azar = () => { semilla = (semilla + 0x6d2b79f5) | 0; let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const entre = (a, b) => a + Math.floor(azar() * (b - a + 1));
const uno = (lista) => lista[Math.floor(azar() * lista.length)];
const pesado = (pares) => { let r = azar() * pares.reduce((s, [, p]) => s + p, 0); for (const [v, p] of pares) { if ((r -= p) <= 0) return v; } return pares[0][0]; };
const nota = (base) => Math.max(0, Math.min(5, Math.round((base + (azar() - 0.5) * 1.2) * 10) / 10));

const NOMBRES = ['María', 'José', 'Luis', 'Ana', 'Carlos', 'Laura', 'Andrés', 'Daniela', 'Jorge', 'Valentina', 'Kevin', 'Yuleidis', 'Deivis', 'Yesenia', 'Brayan', 'Mayerlis', 'Jhon', 'Katherine', 'Alexander', 'Yarledis', 'Camilo', 'Paola', 'Eduardo', 'Marelvis', 'Sergio', 'Dayana', 'Hernán', 'Liliana', 'Wilmer', 'Eliana'];
const APELLIDOS = ['Pérez', 'Gutiérrez', 'Arias', 'Mendoza', 'Ospino', 'Fuentes', 'Barrios', 'Quintero', 'Maestre', 'Daza', 'Romero', 'Oñate', 'Zuleta', 'Martínez', 'Hernández', 'Castro', 'Rangel', 'Vega', 'Molina', 'Araújo', 'Pacheco', 'Díaz', 'Torres', 'Ramírez', 'Suárez'];
const nombreCompleto = () => `${uno(NOMBRES)} ${uno(APELLIDOS)} ${uno(APELLIDOS)}`;
const celular = () => `3${uno(['00', '01', '02', '04', '05', '10', '11', '12', '13', '14', '15', '16', '17', '20', '21', '23', '50'])}${String(entre(0, 9999999)).padStart(7, '0')}`;
const MUNICIPIOS = [['Agustín Codazzi', 34], ['Valledupar', 22], ['La Paz', 14], ['San Diego', 12], ['Becerril', 10], ['Manaure', 8]];
const JORNADAS = [['Mañana', 35], ['Tarde', 25], ['Sabatino', 22], ['Nocturno', 18]];
const VALOR = { 'Auxiliar en Enfermería': 1800000, 'Auxiliar en Servicios Farmacéuticos': 1600000, 'Auxiliar Administrativo': 1300000, 'Seguridad Ocupacional y Laboral': 1450000, 'Asistente de Educación para la Primera Infancia': 1250000 };
const MATERIAS = {
    'Auxiliar en Enfermería': ['Cuidado Básico del Paciente', 'Anatomía y Fisiología'],
    'Auxiliar en Servicios Farmacéuticos': ['Farmacología Básica', 'Gestión de Inventarios de Medicamentos'],
    'Auxiliar Administrativo': ['Gestión Documental', 'Contabilidad General'],
    'Seguridad Ocupacional y Laboral': ['Riesgos Laborales', 'Normatividad en SST'],
    'Asistente de Educación para la Primera Infancia': ['Desarrollo Infantil', 'Pedagogía y Juego']
};

async function main() {
    if (!PASS || PASS.length < 8) {
        console.error('❌ Define SEED_GERENTE_PASSWORD (mínimo 8 caracteres) en backend/.env antes de correr seed-gerente.js');
        process.exit(1);
    }
    const hash = await bcrypt.hash(PASS, 10);
    const periodo = periodoActual();
    const roles = Object.fromEntries((await db.query('SELECT id, nombre FROM roles')).rows.map((r) => [r.nombre, r.id]));
    const programas = Object.fromEntries((await db.query('SELECT id, nombre FROM programas')).rows.map((p) => [p.nombre, p.id]));
    const hoy = new Date(new Date().getTime() - 5 * 3600 * 1000); // fecha de Colombia
    const dia = (n) => { const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() + n)); return d.toISOString().slice(0, 10); };
    const finPeriodo = `${periodo.slice(0, 4)}-${periodo.endsWith('A') ? '06-30' : '12-15'}`;

    // ---- Cuentas ----
    const cuentas = [{ username: 'demo.gerente', nombre: 'Gerente Demo CEPDECO', rol: 'Gerente', vence: null, estado: 'ACTIVO', motivo: 'Periodo vigente' }];
    for (let i = 1; i <= 4; i++) {
        cuentas.push({ username: `demo.adm${String(i).padStart(2, '0')}`, nombre: nombreCompleto(), rol: 'Secretaria', cargo: true,
            vence: i === 4 ? dia(9) : dia(365), estado: 'ACTIVO', motivo: 'Periodo vigente' });
    }
    const docentes = [];
    for (let i = 1; i <= 12; i++) {
        const c = { username: `demo.doc${String(i).padStart(2, '0')}`, nombre: nombreCompleto(), rol: 'Docente', vence: finPeriodo, estado: 'ACTIVO', motivo: 'Periodo vigente' };
        if (i === 11) Object.assign(c, { vence: dia(5) });
        if (i === 12) Object.assign(c, { vence: dia(12) });
        if (i === 10) Object.assign(c, { vence: dia(-3), estado: 'INACTIVO_RETIRADO', motivo: 'Fin de contrato docente' });
        cuentas.push(c); docentes.push(c);
    }
    const estudiantes = [];
    const nombresProg = Object.keys(MATERIAS);
    for (let i = 1; i <= 100; i++) {
        const jornada = pesado(JORNADAS);
        // Estado de pago con correlaciones: Nocturno y Sabatino tienden a pagar más tarde
        const tarde = jornada === 'Nocturno' ? 1.7 : jornada === 'Sabatino' ? 1.2 : 1;
        const pago = pesado([['PAZ_Y_SALVO', 55], ['ABONO_PARCIAL', 20], ['POR_VENCER', 10 * tarde], ['PLAZO_VENCIDO', 15 * tarde]]);
        // Deserción: más probable con plazo vencido y en Nocturno
        const pDes = (pago === 'PLAZO_VENCIDO' ? 0.45 : 0.06) * (jornada === 'Nocturno' ? 1.6 : 1);
        const desertor = azar() < pDes;
        const e = { username: `demo.est${String(i).padStart(3, '0')}`, nombre: nombreCompleto(), rol: 'Estudiante', programa: uno(nombresProg),
            municipio: pesado(MUNICIPIOS), jornada, pago, academico: desertor ? 'RETIRADO_DESERTOR' : 'ACTIVO',
            vence: desertor ? dia(-entre(5, 40)) : finPeriodo, estado: desertor ? 'INACTIVO_RETIRADO' : 'ACTIVO',
            motivo: desertor ? 'Retiro voluntario' : 'Periodo vigente' };
        cuentas.push(e); estudiantes.push(e);
    }

    // Documento ficticio único (empieza por 99) y celular con formato 3XX
    let n = 0;
    for (const c of cuentas) {
        n++;
        const r = await db.query(
            `INSERT INTO usuarios (username, password_hash, nombre_completo, email, tipo_documento, documento, telefono, rol_id, programa_id,
                                   municipio, jornada, estado_academico, estado_cuenta, fecha_vencimiento_acceso, motivo_estado, debe_cambiar_clave)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, FALSE)
             ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, nombre_completo = EXCLUDED.nombre_completo,
                 telefono = EXCLUDED.telefono, rol_id = EXCLUDED.rol_id, programa_id = EXCLUDED.programa_id, municipio = EXCLUDED.municipio,
                 jornada = EXCLUDED.jornada, estado_academico = EXCLUDED.estado_academico, estado_cuenta = EXCLUDED.estado_cuenta,
                 fecha_vencimiento_acceso = EXCLUDED.fecha_vencimiento_acceso, motivo_estado = EXCLUDED.motivo_estado, debe_cambiar_clave = FALSE
             RETURNING id`,
            [c.username, hash, c.nombre, `${c.username}@demo.invalid`, c.rol === 'Estudiante' && n % 9 === 0 ? 'TI' : 'CC',
             `99${String(1000000 + n * 7919).slice(-8)}`, celular(), roles[c.rol], c.programa ? programas[c.programa] : null,
             c.municipio || null, c.jornada || null, c.academico || 'ACTIVO', c.estado, c.vence, c.motivo]
        );
        c.id = r.rows[0].id;
    }

    // ---- Asignaturas demo (2 por programa) con docentes demo ----
    const asignaturas = {};
    let d = 0;
    for (const [prog, mats] of Object.entries(MATERIAS)) {
        asignaturas[prog] = [];
        for (const m of mats) {
            const doc = docentes[d++ % 10]; // los docentes 11 y 12 quedan sin asignatura (por vencer)
            const r = await db.query(
                `INSERT INTO asignaturas (nombre, docente_id, programa_id) VALUES ($1, $2, $3)
                 ON CONFLICT (nombre) DO UPDATE SET docente_id = EXCLUDED.docente_id, programa_id = EXCLUDED.programa_id RETURNING id`,
                [`${m} (demo)`, doc.id, programas[prog]]
            );
            asignaturas[prog].push(r.rows[0].id);
        }
    }

    // ---- Matrículas, notas, cartera y abonos (en bloque) ----
    const mats = [], notas = [], cartera = [], abonos = [];
    for (const e of estudiantes) {
        // Rendimiento: desertores y plazo vencido tienden a notas bajas
        const base = e.academico === 'RETIRADO_DESERTOR' ? 2.5 : e.pago === 'PLAZO_VENCIDO' ? 3.1 : 3.4 + azar() * 1.2;
        const sinCorte3 = e.academico === 'RETIRADO_DESERTOR' || azar() < 0.25;
        for (const a of asignaturas[e.programa]) {
            mats.push({ estudiante_id: e.id, asignatura_id: a });
            const cortes = sinCorte3 ? [1, 2] : [1, 2, 3];
            cortes.forEach((corte) => notas.push({ estudiante_id: e.id, asignatura_id: a, corte, nota: nota(base) }));
        }
        const valor = VALOR[e.programa];
        const limite = { PAZ_Y_SALVO: dia(entre(-30, 40)), ABONO_PARCIAL: dia(entre(10, 60)), POR_VENCER: dia(entre(0, 7)), PLAZO_VENCIDO: dia(-entre(1, 60)) }[e.pago];
        cartera.push({ estudiante_id: e.id, valor_total: valor, fecha_limite_pago: limite });
        const pagado = e.pago === 'PAZ_Y_SALVO' ? valor : Math.round((valor * { ABONO_PARCIAL: 0.3 + azar() * 0.4, POR_VENCER: azar() * 0.6, PLAZO_VENCIDO: azar() * 0.5 }[e.pago]) / 10000) * 10000;
        const partes = pagado <= 0 ? 0 : e.pago === 'PAZ_Y_SALVO' ? entre(1, 3) : entre(1, 2);
        let resto = pagado;
        for (let k = 1; k <= partes; k++) {
            const m = k === partes ? resto : Math.round(resto / (partes - k + 1) / 10000) * 10000;
            if (m > 0) abonos.push({ estudiante_id: e.id, monto: m, fecha: dia(-entre(5, 90)), nota: uno(['Efectivo en secretaría', 'Transferencia', 'Consignación bancaria', 'Nequi']) });
            resto -= m;
        }
    }
    const json = (x) => JSON.stringify(x);
    await db.query(
        `INSERT INTO matriculas (estudiante_id, asignatura_id, periodo)
         SELECT estudiante_id, asignatura_id, $2 FROM json_to_recordset($1::json) AS x(estudiante_id int, asignatura_id int)
         ON CONFLICT (estudiante_id, asignatura_id) DO UPDATE SET periodo = EXCLUDED.periodo`, [json(mats), periodo]);
    const demoIds = estudiantes.map((e) => e.id);
    await db.query('DELETE FROM calificaciones WHERE matricula_id IN (SELECT id FROM matriculas WHERE estudiante_id = ANY($1))', [demoIds]);
    await db.query(
        `INSERT INTO calificaciones (matricula_id, corte, nota)
         SELECT m.id, x.corte, x.nota FROM json_to_recordset($1::json) AS x(estudiante_id int, asignatura_id int, corte int, nota numeric)
         JOIN matriculas m ON m.estudiante_id = x.estudiante_id AND m.asignatura_id = x.asignatura_id`, [json(notas)]);
    await db.query(
        `INSERT INTO cartera_matriculas (estudiante_id, periodo, valor_total, fecha_limite_pago)
         SELECT estudiante_id, $2, valor_total, fecha_limite_pago FROM json_to_recordset($1::json) AS x(estudiante_id int, valor_total numeric, fecha_limite_pago date)
         ON CONFLICT (estudiante_id, periodo) DO UPDATE SET valor_total = EXCLUDED.valor_total, fecha_limite_pago = EXCLUDED.fecha_limite_pago`, [json(cartera), periodo]);
    await db.query('DELETE FROM abonos_matricula WHERE cartera_id IN (SELECT id FROM cartera_matriculas WHERE estudiante_id = ANY($1))', [demoIds]);
    const secretaria = cuentas.find((c) => c.username === 'demo.adm01').id;
    await db.query(
        `INSERT INTO abonos_matricula (cartera_id, monto, fecha, nota, registrado_por)
         SELECT cm.id, x.monto, x.fecha, x.nota, $3 FROM json_to_recordset($1::json) AS x(estudiante_id int, monto numeric, fecha date, nota text)
         JOIN cartera_matriculas cm ON cm.estudiante_id = x.estudiante_id AND cm.periodo = $2`, [json(abonos), periodo, secretaria]);

    const cuenta = (e) => estudiantes.filter((x) => x.pago === e).length;
    console.log(`✅ Demo gerencia (${periodo}): ${estudiantes.length} estudiantes, ${docentes.length} docentes, 4 administrativos y demo.gerente`);
    console.log(`   Pagos: ${cuenta('PAZ_Y_SALVO')} paz y salvo · ${cuenta('ABONO_PARCIAL')} abono parcial · ${cuenta('POR_VENCER')} por vencer · ${cuenta('PLAZO_VENCIDO')} plazo vencido`);
    console.log(`   Desertores: ${estudiantes.filter((e) => e.academico === 'RETIRADO_DESERTOR').length} · Matrículas: ${mats.length} · Notas: ${notas.length} · Abonos: ${abonos.length}`);
    process.exit(0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
