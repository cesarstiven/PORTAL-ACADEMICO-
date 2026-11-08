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

-- Programas técnicos laborales (resoluciones confirmadas por CEPDECO)
CREATE TABLE IF NOT EXISTS programas (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(150) UNIQUE NOT NULL,
    resolucion VARCHAR(20) NOT NULL
);
INSERT INTO programas (nombre, resolucion) VALUES
    ('Asistente de Educación para la Primera Infancia', '007785'),
    ('Seguridad Ocupacional y Laboral', '007837'),
    ('Auxiliar Administrativo', '007778'),
    ('Auxiliar en Servicios Farmacéuticos', '011644'),
    ('Auxiliar en Enfermería', '011689')
ON CONFLICT (nombre) DO NOTHING;

-- Cada estudiante queda ligado a un programa
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS programa_id INT REFERENCES programas(id) ON DELETE SET NULL;

-- Cuentas con clave temporal: deben cambiarla al entrar
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS debe_cambiar_clave BOOLEAN NOT NULL DEFAULT FALSE;

-- Cada asignatura puede pertenecer a un curso (programa); NULL = asignatura general
ALTER TABLE asignaturas ADD COLUMN IF NOT EXISTS programa_id INT REFERENCES programas(id) ON DELETE SET NULL;

-- Periodo de la matrícula: 2026-A (enero a junio) / 2026-B (julio a diciembre)
ALTER TABLE matriculas ADD COLUMN IF NOT EXISTS periodo VARCHAR(7);
UPDATE matriculas
SET periodo = TO_CHAR(created_at, 'YYYY') || CASE WHEN EXTRACT(MONTH FROM created_at) <= 6 THEN '-A' ELSE '-B' END
WHERE periodo IS NULL;
ALTER TABLE matriculas ALTER COLUMN periodo SET NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matriculas_periodo_formato') THEN
        ALTER TABLE matriculas ADD CONSTRAINT matriculas_periodo_formato CHECK (periodo ~ '^[0-9]{4}-[AB]$');
    END IF;
END $$;

-- Registro de aceptación de los documentos legales (Términos y Política de Tratamiento de Datos).
-- Una fila por usuario y versión: al publicar una versión nueva, todos deben aceptarla otra vez.
CREATE TABLE IF NOT EXISTS aceptaciones_legales (
    id SERIAL PRIMARY KEY,
    usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    version VARCHAR(20) NOT NULL,
    aceptado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip VARCHAR(64),
    user_agent VARCHAR(300),
    UNIQUE (usuario_id, version)
);

-- Identificación y contacto de cada usuario (para buscarlo por cédula o teléfono). Todas opcionales.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS tipo_documento VARCHAR(5);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS documento VARCHAR(20);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefono VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_documento_unico ON usuarios (documento) WHERE documento IS NOT NULL;

-- ---------- Gerencia: roles, datos para análisis, vigencia de cuentas y cartera de matrículas ----------
-- Gerente: solo consulta (cartera, rendimiento) y controla la vigencia de cuentas. Secretaria: registra abonos de matrícula.
INSERT INTO roles (nombre) VALUES ('Gerente'), ('Secretaria') ON CONFLICT DO NOTHING;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS municipio VARCHAR(40);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS jornada VARCHAR(10);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS estado_academico VARCHAR(20) NOT NULL DEFAULT 'ACTIVO';
-- Vigencia: un único estado guardado (ACTIVO / INACTIVO_RETIRADO) + la fecha. "Por vencer" se calcula, no se guarda.
-- fecha_vencimiento_acceso NULL = sin vencimiento.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS estado_cuenta VARCHAR(20) NOT NULL DEFAULT 'ACTIVO';
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS fecha_vencimiento_acceso DATE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS motivo_estado VARCHAR(80) NOT NULL DEFAULT 'Periodo vigente';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_municipio_valido') THEN
        ALTER TABLE usuarios ADD CONSTRAINT usuarios_municipio_valido
            CHECK (municipio IS NULL OR municipio IN ('Valledupar', 'Agustín Codazzi', 'La Paz', 'San Diego', 'Manaure', 'Becerril'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_jornada_valida') THEN
        ALTER TABLE usuarios ADD CONSTRAINT usuarios_jornada_valida
            CHECK (jornada IS NULL OR jornada IN ('Mañana', 'Tarde', 'Sabatino', 'Nocturno'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_estado_academico_valido') THEN
        ALTER TABLE usuarios ADD CONSTRAINT usuarios_estado_academico_valido
            CHECK (estado_academico IN ('ACTIVO', 'RETIRADO_DESERTOR', 'GRADUADO'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_estado_cuenta_valido') THEN
        ALTER TABLE usuarios ADD CONSTRAINT usuarios_estado_cuenta_valido
            CHECK (estado_cuenta IN ('ACTIVO', 'INACTIVO_RETIRADO'));
    END IF;
END $$;
-- Matrícula del periodo: valor y fecha límite. Lo pagado sale de la suma de abonos (no se guarda dos veces);
-- saldo, días y estado de pago se calculan en la consulta.
CREATE TABLE IF NOT EXISTS cartera_matriculas (
    id SERIAL PRIMARY KEY,
    estudiante_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    periodo VARCHAR(7) NOT NULL CHECK (periodo ~ '^[0-9]{4}-[AB]$'),
    valor_total NUMERIC(12,2) NOT NULL CHECK (valor_total > 0),
    fecha_limite_pago DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (estudiante_id, periodo)
);
-- Cada abono queda registrado con quién lo hizo (trazabilidad). Solo Secretaria y Administrador los crean.
CREATE TABLE IF NOT EXISTS abonos_matricula (
    id SERIAL PRIMARY KEY,
    cartera_id INT NOT NULL REFERENCES cartera_matriculas(id) ON DELETE CASCADE,
    monto NUMERIC(12,2) NOT NULL CHECK (monto > 0),
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    nota VARCHAR(120),
    registrado_por INT REFERENCES usuarios(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS abonos_cartera_idx ON abonos_matricula (cartera_id);

-- ---------- Seguridad: cerrar la API pública de Supabase ----------
-- El portal entra solo por el servidor (rol postgres, dueño de las tablas, que no se ve afectado por RLS).
-- Con RLS activo y SIN políticas, los roles públicos de Supabase (anon / authenticated) no pueden leer ni escribir nada.
DO $$
DECLARE t TEXT;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
    END LOOP;
END $$;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
-- Tablas que se creen en el futuro tampoco quedan abiertas a esos roles
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- ---------- Rendimiento: índices para las búsquedas más frecuentes ----------
CREATE INDEX IF NOT EXISTS matriculas_asignatura_idx ON matriculas (asignatura_id);   -- estudiantes de una asignatura (docente)
CREATE INDEX IF NOT EXISTS transacciones_usuario_idx ON transacciones (usuario_id);   -- pagos de un estudiante
CREATE INDEX IF NOT EXISTS certificados_usuario_idx ON certificados (usuario_id);     -- certificados de un estudiante
CREATE INDEX IF NOT EXISTS asignaturas_docente_idx ON asignaturas (docente_id);       -- asignaturas de un docente
CREATE INDEX IF NOT EXISTS asignaturas_programa_idx ON asignaturas (programa_id);     -- asignaturas de un curso
CREATE INDEX IF NOT EXISTS usuarios_programa_idx ON usuarios (programa_id);           -- estudiantes de un curso
CREATE INDEX IF NOT EXISTS usuarios_username_lower_idx ON usuarios (LOWER(username)); -- login sin distinguir mayúsculas
