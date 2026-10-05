# Portal Web CEPDECO (TPI3)

MVP de portal académico: login por roles (Estudiante / Docente / Administrador), notas por cortes,
certificados PDF con QR de verificación pública y pagos en ePayco Sandbox.
Node.js + Express + PostgreSQL (Supabase). El backend también sirve el frontend (`public/index.html`).

## Correr en local
```bash
npm install
cp .env.example .env     # y completa los valores (Windows: copy .env.example .env)
# 1. En Supabase > SQL Editor pega y ejecuta schema.sql
node seed.js             # usuarios y datos de demo
npm start                # http://localhost:5000
```
Usuarios demo (clave `Cepdeco2026*`, o la que pongas en `SEED_PASSWORD`):
`ceshernandez` (Administrador), `docente1`, `estudiante1`, `estudiante2`.

## Flujo del MVP
1. Admin crea usuarios/asignaturas y matricula estudiantes. 2. Docente carga notas (cortes 30/30/40).
3. Estudiante paga $25.000 (ePayco Sandbox) → 4. genera su certificado PDF (1 pago = 1 certificado)
→ 5. cualquiera valida el QR en `/verificar/<código>`.

## Despliegue en Render (Staging)
Web Service desde el repo · Build: `npm install` · Start: `npm start` · variables de entorno:
`DATABASE_URL`, `JWT_SECRET`, `EPAYCO_*`, `NODE_ENV=production` y `PUBLIC_URL=https://tu-app.onrender.com`.
En ePayco el webhook (`/api/pagos/webhook`) solo funciona con esa URL pública; en local el pago se
confirma al volver de ePayco (`/api/pagos/confirmar`).

## Seguridad
- Claves con bcrypt, sesiones JWT (8 h), rutas protegidas por rol.
- Webhook con verificación de firma SHA-256; un pago aceptado no se puede degradar ni reutilizar.
- `.env` está en `.gitignore`: nunca lo subas.
