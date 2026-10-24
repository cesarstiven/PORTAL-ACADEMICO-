# Portal Web CEPDECO (TPI3)

Portal académico para CEPDECO (Agustín Codazzi, Cesar): login por roles, notas por cortes,
certificados PDF con QR de verificación pública y pagos en ePayco Sandbox.
Proyecto TPI3, Universidad Nacional de Colombia, Sede La Paz. **Versión de demostración: aún no es oficial.**

Node 22 + Express 5 + PostgreSQL (Supabase). El backend también sirve el frontend (`backend/public/index.html`).

## Qué hace hoy

| Rol | Puede |
| --- | --- |
| Estudiante | Ver sus datos y su programa, calificaciones del periodo e historia académica, pagar el certificado (ePayco / PSE) y generarlo en PDF con QR |
| Docente | Registrar notas por corte (30 % / 30 % / 40 %) de sus asignaturas |
| Administrador | Crear usuarios, cursos y asignaturas, matricular por curso y periodo, marcar pagos manuales |
| Cualquiera | Verificar un certificado en `/verificar/<código>` (lo abre el QR) |

Reglas de CEPDECO incluidas: licencia Resolución 002844, escala 0.0–5.0, nota mínima 3.2
(Aprobado / Reprobado / En curso, solo con los 3 cortes), calendarios A (enero–junio) y B (julio–diciembre),
y los 5 programas técnicos laborales con su resolución.

## Correr en local
```bash
cd backend
npm install
copy .env.example .env   # Windows (en Mac/Linux: cp .env.example .env) y completa los valores
# En Supabase > SQL Editor pega y ejecuta schema.sql (se puede correr varias veces, no borra datos)
node seed.js             # usuarios demo; requiere SEED_PASSWORD en el .env
npm start                # http://localhost:5000
```
Usuarios del seed: `ceshernandez` (Administrador), `docente1`, `estudiante1`, `estudiante2`, con la clave
que pongas en `SEED_PASSWORD`. Las cuentas creadas desde Administración reciben una clave temporal que
deben cambiar en su primer ingreso.

## Demo en Render (plan gratis)
1. En [Render](https://render.com): **New > Blueprint** y elige este repositorio (usa `render.yaml`).
2. Completa las variables que pide: `DATABASE_URL` (pooler de Supabase, puerto 6543),
   `PUBLIC_URL` (la URL que te da Render, ej. `https://cepdeco-portal.onrender.com`) y las `EPAYCO_*` de Sandbox.
   `JWT_SECRET` se genera solo.
3. Cuando termine el despliegue, abre la URL y entra con una cuenta demo.

Notas del plan gratis: el servicio se duerme tras 15 minutos sin visitas y tarda cerca de un minuto en
despertar. Supabase gratis se pausa si pasa días sin uso (se reanuda con "Resume project").
El webhook de ePayco (`/api/pagos/webhook`) solo funciona con la URL pública.

Interruptores: `MODO_DEMO=off` quita el aviso de demostración; `PAGO_MANUAL=off` apaga el pago manual.

## Seguridad
- Claves con bcrypt, sesiones JWT de 8 h, rutas protegidas por rol y clave temporal obligatoria.
- Webhook con firma SHA-256; un pago aceptado no se degrada ni se reutiliza (1 pago = 1 certificado).
- Nunca subas `backend/.env` ni los archivos `claves-temporales*.txt` (están en `.gitignore`).
- No se cargan datos reales de estudiantes hasta tener la política de datos (Ley 1581) y la autorización de CEPDECO.
