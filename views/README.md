# Sophie Living v5

## Lo que ve el cliente
Es el configurador original del zip (mismo diseño, mismos pasos, misma página de pago). Lo único que cambió es de dónde salen los datos: productos, telas, patas, precios, textos, foto de perfil y redes vienen del panel.

- `views/configurador.html`: plantilla original con los datos inyectados por el servidor.
- `public/checkout-payment.js`, `public/pago.html`, `public/payment-status.js`: flujo de compra original, adaptado al nuevo pedido.

## Panel (`/admin.html`)
Ingreso con `ADMIN_PASSWORD`.
- Dashboard y Pedidos por periodo, aceptar / rechazar / entregado / borrar pedidos, confirmar transferencias.
- Productos: nombre, medidas, precios, cuotas máximas, fotos, colores, patas, izquierda/derecha, tela pendiente, simular color sobre la foto.
- Telas y colores, Maderas y patas.
- Configuración: interés de cuotas y seña (globales).
- Sitio y redes: título, textos, dirección de retiro, foto de perfil, WhatsApp (botón flotante) y redes (Instagram, Facebook, TikTok, etc.).

## Variables de entorno
`DATABASE_URL`, `DATABASE_SSL=true`, `ADMIN_PASSWORD`, `SESSION_SECRET`, datos bancarios, tokens de Mercado Pago, `PUBLIC_BASE_URL`. `SEED_LEGACY_CATALOG=true` importa los productos del sitio anterior si la base está vacía.

## Limitaciones conocidas
- El configurador del cliente muestra las telas Pana Shot y Pana Best, como el original. Telas nuevas creadas en el panel no aparecen en el configurador hasta agregar esa lógica.
- El configurador usa un solo color por sillón, como el original. La opción de color distinto para izquierda y derecha se guarda en el panel pero el cliente todavía no la puede elegir.
- Las cuotas (hasta el máximo de cada producto) se eligen en Mercado Pago. El interés global se suma al precio con tarjeta.
