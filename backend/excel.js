// Plantillas Excel (descargar / cargar) para notas del docente y carga masiva de usuarios.
// Solo se leen valores de celdas: las fórmulas se toman por su resultado y nunca se ejecutan.
const ExcelJS = require('exceljs');

const MAX_FILAS = 1000;
const AZUL = 'FF1D3A8A';
const TIPOS_DOCUMENTO = ['CC', 'TI', 'CE', 'PPT', 'PA', 'RC'];

// Valor de una celda como texto limpio (números, fechas, texto enriquecido, fórmulas, hipervínculos)
function texto(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
        if ('result' in v) return texto(v.result);
        if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('').trim();
        if ('text' in v) return texto(v.text);
        return '';
    }
    return String(v).trim();
}

// Nota con punto o coma; '' = sin cambio; NaN = inválida
function nota(v) {
    const t = texto(v).replace(',', '.');
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 && n <= 5 ? Math.round(n * 100) / 100 : NaN;
}

async function leer(buffer) {
    const wb = new ExcelJS.Workbook();
    try {
        await wb.xlsx.load(buffer);
    } catch {
        const e = new Error('El archivo no es un Excel válido (.xlsx). Descarga la plantilla y úsala tal cual.');
        e.status = 400;
        throw e;
    }
    return wb;
}

async function enviar(res, wb, nombre) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    await wb.xlsx.write(res);
    res.end();
}

function encabezado(ws, fila, titulos, anchos) {
    const r = ws.getRow(fila);
    titulos.forEach((t, i) => {
        const c = r.getCell(i + 1);
        c.value = t;
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
        c.alignment = { vertical: 'middle', wrapText: true };
    });
    r.height = 30;
    anchos.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

// ---------- Notas del docente ----------
const NOTAS_FILA_ENCABEZADO = 5;

function plantillaNotas(asignatura, estudiantes) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Portal Académico CEPDECO';
    const ws = wb.addWorksheet('Notas', { views: [{ state: 'frozen', ySplit: NOTAS_FILA_ENCABEZADO }] });
    ws.getCell('A1').value = 'CEPDECO · Planilla de calificaciones';
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: AZUL } };
    ws.getCell('A2').value = `Asignatura: ${asignatura.nombre}`;
    ws.getCell('A3').value = 'Escribe las notas de 0.0 a 5.0 (con punto o coma). Deja vacío lo que no quieras cambiar. No cambies las columnas A a D.';
    ws.getCell('A3').font = { italic: true, color: { argb: 'FF5F6A79' } };
    encabezado(ws, NOTAS_FILA_ENCABEZADO,
        ['ID matrícula', 'Estudiante', 'Documento', 'Usuario', 'Corte 1 (30%)', 'Corte 2 (30%)', 'Corte 3 (40%)'],
        [12, 36, 16, 18, 14, 14, 14]);
    estudiantes.forEach((s, i) => {
        const r = ws.getRow(NOTAS_FILA_ENCABEZADO + 1 + i);
        r.values = [s.matricula_id, s.nombre, s.documento || '', s.username, s.notas[0], s.notas[1], s.notas[2]];
        for (let c = 5; c <= 7; c++) {
            const cel = r.getCell(c);
            cel.protection = { locked: false };
            cel.numFmt = '0.0';
            cel.dataValidation = {
                type: 'decimal', operator: 'between', formulae: [0, 5], allowBlank: true, showErrorMessage: true,
                errorTitle: 'Nota inválida', error: 'La nota debe estar entre 0.0 y 5.0'
            };
        }
    });
    // Protección sin clave: evita borrar por error los nombres o IDs (las notas sí se pueden editar)
    ws.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true });
    // Marca de la asignatura para no cargar la planilla en otra por error
    const meta = wb.addWorksheet('_cepdeco', { state: 'veryHidden' });
    meta.getCell('A1').value = 'asignatura';
    meta.getCell('B1').value = asignatura.id;
    return wb;
}

// Devuelve { notas: [{matricula_id, corte, nota}], errores: [] }; idsValidos = matrículas de la asignatura
function leerNotas(wb, asignaturaId, idsValidos) {
    const ws = wb.getWorksheet('Notas');
    const meta = wb.getWorksheet('_cepdeco');
    if (!ws) return { notas: [], errores: ['El archivo no tiene la hoja "Notas". Descarga la plantilla de esta asignatura.'] };
    if (meta && Number(texto(meta.getCell('B1').value)) !== Number(asignaturaId)) {
        return { notas: [], errores: ['Esta planilla es de otra asignatura. Selecciona la asignatura correcta o descarga su plantilla.'] };
    }
    const notas = [];
    const errores = [];
    const vistos = new Set();
    const ultima = Math.min(ws.rowCount, NOTAS_FILA_ENCABEZADO + MAX_FILAS);
    for (let f = NOTAS_FILA_ENCABEZADO + 1; f <= ultima; f++) {
        const r = ws.getRow(f);
        const id = parseInt(texto(r.getCell(1).value), 10);
        if (!id) continue;
        const quien = texto(r.getCell(2).value) || `ID ${id}`;
        if (!idsValidos.has(id)) { errores.push(`Fila ${f} (${quien}): el estudiante no está matriculado en esta asignatura.`); continue; }
        if (vistos.has(id)) { errores.push(`Fila ${f} (${quien}): el estudiante aparece repetido.`); continue; }
        vistos.add(id);
        for (let corte = 1; corte <= 3; corte++) {
            const n = nota(r.getCell(4 + corte).value);
            if (n === null) continue;
            if (Number.isNaN(n)) errores.push(`Fila ${f} (${quien}): la nota del corte ${corte} debe estar entre 0.0 y 5.0.`);
            else notas.push({ matricula_id: id, corte, nota: n });
        }
    }
    return { notas, errores };
}

// ---------- Usuarios (administración) ----------
const COLUMNAS_USUARIOS = [
    ['Usuario *', 18], ['Nombre completo *', 32], ['Correo *', 30], ['Rol *', 15], ['Tipo documento', 14],
    ['Documento', 16], ['Teléfono', 16], ['Programa (solo estudiantes)', 44], ['Matricular en periodo (ej. 2026-B)', 20],
    ['Clave temporal (vacía = se genera)', 22]
];

// Sin filas = plantilla vacía para crear; con filas = exportación de los usuarios actuales (mismo formato)
function plantillaUsuarios(roles, programas, filas = []) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Portal Académico CEPDECO';
    const ws = wb.addWorksheet('Usuarios', { views: [{ state: 'frozen', ySplit: 1 }] });
    encabezado(ws, 1, COLUMNAS_USUARIOS.map((c) => c[0]), COLUMNAS_USUARIOS.map((c) => c[1]));
    filas.forEach((u, i) => {
        ws.getRow(i + 2).values = [u.username, u.nombre_completo, u.email, u.rol, u.tipo_documento || '', u.documento || '', u.telefono || '', u.programa || '', '', ''];
    });

    const listas = wb.addWorksheet('Listas', { state: 'hidden' });
    listas.getColumn(1).values = ['Rol', ...roles];
    listas.getColumn(2).values = ['Tipo documento', ...TIPOS_DOCUMENTO];
    listas.getColumn(3).values = ['Programa', ...programas];
    const lista = (col, n) => ({ type: 'list', allowBlank: true, formulae: [`Listas!$${col}$2:$${col}$${n + 1}`] });
    for (let f = 2; f <= MAX_FILAS + 1; f++) {
        const r = ws.getRow(f);
        r.getCell(4).dataValidation = lista('A', roles.length);
        r.getCell(5).dataValidation = lista('B', TIPOS_DOCUMENTO.length);
        r.getCell(8).dataValidation = lista('C', programas.length);
        r.getCell(6).numFmt = '@'; // documento y teléfono como texto (no pierden ceros ni se vuelven 1E+10)
        r.getCell(7).numFmt = '@';
    }

    const ins = wb.addWorksheet('Instrucciones');
    ins.getColumn(1).width = 110;
    [
        'CEPDECO · Carga masiva de usuarios',
        '',
        '1. Llena una fila por persona en la hoja "Usuarios". Las columnas con * son obligatorias.',
        '2. Usuario: letras, números, punto, guion o guion bajo (3 a 40 caracteres). No puede repetirse.',
        `3. Rol, Tipo documento y Programa tienen lista desplegable. Tipos: ${TIPOS_DOCUMENTO.join(', ')}.`,
        '4. Programa y Periodo solo aplican a estudiantes. Si pones periodo, se matricula en todas las asignaturas del programa.',
        '5. Clave temporal (solo usuarios nuevos): si la dejas vacía, el portal genera una. Todos deben cambiarla en su primer ingreso.',
        '6. Si el usuario YA EXISTE, se actualizan su nombre, correo, documento, teléfono y programa. El rol y la clave no se cambian desde Excel.',
        '7. En un usuario existente, una celda vacía en Documento, Teléfono o Programa deja el dato como está.',
        '8. Sube el archivo en Administración > Usuarios > Cargar Excel. Verás qué se crea y qué cambia; nada se guarda hasta que confirmes.',
        '9. Este archivo tiene datos personales: guárdalo en un lugar seguro y bórralo cuando ya no lo necesites.'
    ].forEach((t, i) => { const c = ins.getCell(i + 1, 1); c.value = t; if (i === 0) c.font = { bold: true, size: 14, color: { argb: AZUL } }; });
    return wb;
}

// Filas crudas de la hoja Usuarios (sin validar contra la base)
function leerUsuarios(wb) {
    const ws = wb.getWorksheet('Usuarios');
    if (!ws) return { filas: [], error: 'El archivo no tiene la hoja "Usuarios". Descarga la plantilla y úsala tal cual.' };
    const filas = [];
    for (let f = 2; f <= ws.rowCount; f++) {
        const r = ws.getRow(f);
        const v = Array.from({ length: COLUMNAS_USUARIOS.length }, (_, i) => texto(r.getCell(i + 1).value));
        if (v.every((x) => !x)) continue;
        if (filas.length >= MAX_FILAS) return { filas, error: `Máximo ${MAX_FILAS} usuarios por archivo.` };
        const [username, nombre, email, rol, tipo, documento, telefono, programa, periodo, clave] = v;
        filas.push({ fila: f, username, nombre, email, rol, tipo_documento: tipo.toUpperCase(), documento, telefono, programa, periodo: periodo.toUpperCase(), clave });
    }
    return { filas };
}

// ---------- Cursos, asignaturas y matrículas (administración) ----------
const COL_ASIG = [['ID (no cambiar)', 10], ['Asignatura *', 36], ['Curso', 46], ['Docente (usuario)', 20], ['Docente (nombre, informativo)', 30], ['Estudiantes (informativo)', 14]];
const COL_MAT = [['Estudiante (usuario) *', 22], ['Estudiante (nombre, informativo)', 32], ['Documento (informativo)', 16], ['Asignatura *', 36], ['Curso (informativo)', 40], ['Docente (informativo)', 28], ['Periodo (ej. 2026-B)', 14]];

function plantillaAcademico({ asignaturas, matriculas, cursos, docentes }) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Portal Académico CEPDECO';
    const gris = { color: { argb: 'FF5F6A79' } };

    const wa = wb.addWorksheet('Asignaturas', { views: [{ state: 'frozen', ySplit: 1 }] });
    encabezado(wa, 1, COL_ASIG.map((c) => c[0]), COL_ASIG.map((c) => c[1]));
    asignaturas.forEach((a, i) => {
        const r = wa.getRow(i + 2);
        r.values = [a.id, a.nombre, a.curso || '', a.docente_usuario || '', a.docente || '', a.estudiantes];
        [1, 5, 6].forEach((c) => { r.getCell(c).font = gris; });
    });

    const wm = wb.addWorksheet('Matrículas', { views: [{ state: 'frozen', ySplit: 1 }] });
    encabezado(wm, 1, COL_MAT.map((c) => c[0]), COL_MAT.map((c) => c[1]));
    matriculas.forEach((m, i) => {
        const r = wm.getRow(i + 2);
        r.values = [m.usuario, m.estudiante, m.documento || '', m.asignatura, m.curso || '', m.docente || '', m.periodo];
        [2, 3, 5, 6].forEach((c) => { r.getCell(c).font = gris; });
    });
    wm.autoFilter = { from: 'A1', to: 'G1' };
    wa.autoFilter = { from: 'A1', to: 'F1' };

    const listas = wb.addWorksheet('Listas', { state: 'hidden' });
    listas.getColumn(1).values = ['Curso', ...cursos];
    listas.getColumn(2).values = ['Docente', ...docentes];
    listas.getColumn(3).values = ['Asignatura', ...asignaturas.map((a) => a.nombre)];
    const lista = (col, n) => ({ type: 'list', allowBlank: true, showErrorMessage: false, formulae: [`Listas!$${col}$2:$${col}$${Math.max(n, 1) + 1}`] });
    for (let f = 2; f <= Math.max(asignaturas.length + 200, 300); f++) {
        wa.getRow(f).getCell(3).dataValidation = lista('A', cursos.length);
        wa.getRow(f).getCell(4).dataValidation = lista('B', docentes.length);
    }
    for (let f = 2; f <= matriculas.length + MAX_FILAS; f++) wm.getRow(f).getCell(4).dataValidation = lista('C', asignaturas.length);

    const ins = wb.addWorksheet('Instrucciones');
    ins.getColumn(1).width = 115;
    [
        'CEPDECO · Cursos, asignaturas y matrículas',
        '',
        'Hoja "Asignaturas": qué materias hay, a qué curso pertenecen y qué docente las dicta.',
        '  · Para corregir: cambia el nombre, el curso o el docente (usuario del docente, de la lista). No cambies la columna ID.',
        '  · Para crear una asignatura: agrega una fila nueva SIN ID.',
        '  · Curso vacío = asignatura general. Docente vacío = sin docente.',
        'Hoja "Matrículas": qué estudiante ve qué asignatura y con qué docente (filtra con las flechas del encabezado).',
        '  · Para matricular: agrega una fila con el usuario del estudiante, la asignatura (de la lista) y el periodo. Si el periodo va vacío se usa el actual.',
        '  · Las columnas "informativo" no se leen: el portal las llena al descargar.',
        '  · Borrar una fila NO quita la matrícula (así no se pierden notas). Para retirar a un estudiante, habla con quien administra el portal.',
        'Sube el archivo en Administración > Cursos y asignaturas > Cargar Excel. Verás qué se crea y qué cambia; nada se guarda hasta que confirmes.',
        'Este archivo tiene datos personales: guárdalo en un lugar seguro y bórralo cuando ya no lo necesites.'
    ].forEach((t, i) => { const c = ins.getCell(i + 1, 1); c.value = t; if (i === 0) c.font = { bold: true, size: 14, color: { argb: AZUL } }; });
    return wb;
}

function leerAcademico(wb) {
    const wa = wb.getWorksheet('Asignaturas');
    const wm = wb.getWorksheet('Matrículas');
    if (!wa && !wm) return { error: 'El archivo no tiene las hojas "Asignaturas" ni "Matrículas". Descarga el Excel del portal y úsalo tal cual.' };
    const asignaturas = [];
    const matriculas = [];
    if (wa) for (let f = 2; f <= wa.rowCount; f++) {
        const r = wa.getRow(f);
        const v = [1, 2, 3, 4].map((c) => texto(r.getCell(c).value));
        if (v.every((x) => !x)) continue;
        if (asignaturas.length >= MAX_FILAS) return { error: `Máximo ${MAX_FILAS} asignaturas por archivo.` };
        asignaturas.push({ fila: f, id: v[0], nombre: v[1].replace(/\s+/g, ' '), curso: v[2], docente: v[3] });
    }
    if (wm) for (let f = 2; f <= wm.rowCount; f++) {
        const r = wm.getRow(f);
        const usuario = texto(r.getCell(1).value);
        const asignatura = texto(r.getCell(4).value).replace(/\s+/g, ' ');
        const periodo = texto(r.getCell(7).value).toUpperCase();
        if (!usuario && !asignatura) continue;
        if (matriculas.length >= 5000) return { error: 'Máximo 5000 matrículas por archivo.' };
        matriculas.push({ fila: f, usuario, asignatura, periodo });
    }
    return { asignaturas, matriculas };
}

module.exports = { leer, enviar, plantillaNotas, leerNotas, plantillaUsuarios, leerUsuarios, plantillaAcademico, leerAcademico, TIPOS_DOCUMENTO };
