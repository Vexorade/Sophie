# Sophie Living

Configurador de sillones con pedidos, pago por transferencia y Mercado Pago.

## Estructura

- `server.js`: servidor Express (API y páginas estáticas).
- `lib/pricing.js`: precios, validaciones y reglas de pago. Todo el cálculo ocurre en el servidor.
- `lib/mercadopago.js`: llamadas a la API de Mercado Pago.
- `lib/webhook-signature.js`: verificación HMAC de las notificaciones.
- `lib/db.js`: Postgres. La tabla se crea sola al iniciar.
- `data/catalog.json`: modelos, telas, patas y precios (confirmar con Sophie).
- `public/`: configurador original, pago del pedido (`pago.html`) y panel de pedidos (`pedidos.html`).
- `tests/`: pruebas de precios y firma (`npm test`).

## Cambios respecto de la versión anterior

- Se eliminó la confianza en encabezados de la plataforma. Cada comprador recibe una cookie httpOnly solo para su pedido.
- El panel de pedidos usa usuario y contraseña (`ADMIN_USER` / `ADMIN_PASSWORD`), no un email fijo en el código.
- Los datos bancarios salen del código y se cargan como variables de entorno.
- Se eliminó el código de plataforma que no se usaba (componentes de shadcn, conectores, ejemplos D1, scripts de build).
- El webhook de Mercado Pago se valida con la firma y no depende de una bandera de acceso público.

## Correr en local

```
npm install
cp .env.example .env   # completar DATABASE_URL (Postgres local)
npm test
npm start              # http://localhost:3000
```

## Subir a GitHub

```
git init
git add .
git commit -m "Sophie Living v2"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/sophie-living.git
git push -u origin main
```

Revisar antes del push que `.env` no esté en el commit (ya está en `.gitignore`).

## Desplegar en Render

1. En Render: New > Blueprint, conectar el repositorio de GitHub. Render lee `render.yaml` y crea el servicio y la base.
2. En el panel del servicio, completar los valores marcados como secretos: `PUBLIC_BASE_URL` (la URL de Render, por ejemplo `https://sophie-living.onrender.com`), `ADMIN_PASSWORD`, datos bancarios y, cuando corresponda, los tokens de Mercado Pago.
3. Esperar el deploy y abrir `/api/health`. Debe responder `{"ok":true}`.
4. Ingresar a `/pedidos.html` con el usuario y contraseña de administración.

## Mercado Pago (pendiente)

Mantener `MERCADO_PAGO_LIVE_ENABLED=false` hasta probar:

1. Compras de prueba con el usuario de prueba: aprobada, rechazada y pendiente.
2. Retorno desde el celular y reintento con doble clic (no debe duplicar el cobro).
3. Notificaciones: en el panel de Mercado Pago, configurar la URL `PUBLIC_BASE_URL/api/webhooks/mercadopago` y el secreto de firma.
4. Confirmar costos online y cuotas con la cuenta receptora.

Las cuotas (hasta 18) dependen de lo que Mercado Pago ofrezca para cada tarjeta.

## Pendientes de negocio

- Confirmar precios del catálogo (los modelos 0 y 2 tienen el mismo precio; revisar).
- Definir el modelo Luxury Panamá/Tussor cuando estén las telas.
- Las imágenes de telas siguen apuntando a sitios externos (Tiendanube y Telas Express). Conviene descargarlas al repositorio.
- El sistema no envía emails. Si Sophie los necesita, se agrega un proveedor de correo.
- Los pedidos quedan asociados al navegador del comprador. Para verlos desde otro dispositivo se usa el número de pedido en `pedidos.html`.
