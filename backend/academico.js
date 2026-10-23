// Reglas académicas de CEPDECO (compartidas por server.js y seed.js)

const NOTA_MINIMA = 3.2;          // Nota mínima aprobatoria. Cambiar solo aquí.
const PESOS = [0.3, 0.3, 0.4];    // Cortes 30 % / 30 % / 40 %

const num = (v) => (v === null || v === undefined ? null : parseFloat(v));

// Periodo académico según la fecha (hora de Colombia, UTC-5 sin horario de verano):
// A = enero a junio, B = julio a diciembre. Ej.: "2026-B"
function periodoActual(fecha = new Date()) {
    const d = new Date(fecha.getTime() - 5 * 3600 * 1000);
    return `${d.getUTCFullYear()}-${d.getUTCMonth() < 6 ? 'A' : 'B'}`;
}

// Acumulado y estado de una asignatura. El estado solo se define con los 3 cortes.
function resumenNotas(c1, c2, c3) {
    const notas = [num(c1), num(c2), num(c3)];
    const suma = notas.reduce((s, n, i) => s + (n === null ? 0 : n * PESOS[i]), 0);
    const acumulado = Math.round(suma * 100) / 100;
    const completa = notas.every((n) => n !== null);
    const estado = !completa ? 'En curso' : acumulado >= NOTA_MINIMA ? 'Aprobado' : 'Reprobado';
    return { notas, acumulado, completa, estado };
}

module.exports = { NOTA_MINIMA, PESOS, num, periodoActual, resumenNotas };
