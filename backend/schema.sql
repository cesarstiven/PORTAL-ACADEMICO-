-- Esquema CEPDECO (idempotente: se puede correr varias veces sin romper datos)

CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(50) UNIQUE NOT NULL
);
INSERT INTO roles (nombre) VALUES ('Estudiante'), ('Docente'), ('Administrador')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    nombre_completo VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    rol_id INT REFERENCES roles(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transacciones (
    id SERIAL PRIMARY KEY,
    referencia_pago VARCHAR(100) UNIQUE NOT NULL,
    usuario_id INT REFERENCES usuarios(id),
    monto DECIMAL(10,2) NOT NULL,
    moneda VARCHAR(3) DEFAULT 'COP',
    estado VARCHAR(20) DEFAULT 'PENDING', -- PENDING, ACCEPTED, REJECTED
    ref_epayco VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS certificados (
    id SERIAL PRIMARY KEY,
    codigo_verificacion VARCHAR(50) UNIQUE NOT NULL,
    usuario_id INT REFERENCES usuarios(id),
    tipo_certificado VARCHAR(100) NOT NULL,
    fecha_emision TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    activo BOOLEAN DEFAULT TRUE
);
-- Cada certificado consume UN pago aceptado (evita reusar el mismo pago)
ALTER TABLE certificados ADD COLUMN IF NOT EXISTS transaccion_id INT UNIQUE REFERENCES transacciones(id);

-- Módulo académico
CREATE TABLE IF NOT EXISTS asignaturas (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(150) UNIQUE NOT NULL,
    docente_id INT REFERENCES usuarios(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS matriculas (
    id SERIAL PRIMARY KEY,
    estudiante_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    asignatura_id INT NOT NULL REFERENCES asignaturas(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (estudiante_id, asignatura_id)
);

CREATE TABLE IF NOT EXISTS calificaciones (
    id SERIAL PRIMARY KEY,
    matricula_id INT NOT NULL REFERENCES matriculas(id) ON DELETE CASCADE,
    corte SMALLINT NOT NULL CHECK (corte BETWEEN 1 AND 3),
    nota NUMERIC(3,2) NOT NULL CHECK (nota BETWEEN 0 AND 5),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (matricula_id, corte)
);
