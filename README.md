# Sophie Living v3

Configurador de sillones con catálogo editable desde el panel, pedidos, transferencias y Mercado Pago.

## Dónde está cada cosa

- `server.js`: API y rutas.
- `lib/db.js`: Postgres. Las tablas se crean solas al iniciar.
- `lib/pricing.js`: precios, validaciones y reglas de pago. Todo el cálculo ocurre en el servidor.
- `lib/catalog.js`, `lib/stats.js`, `lib/images.js`: catálogo, métricas y validación de imágenes.
- `public/configurador.html`: lo que ve el cliente.
- `public/admin.html`: el panel (Dashboard, Pedidos, Productos, Telas y colores, Maderas y patas).
- `public/pago.html`: estado del pedido para el cliente.

## Panel de administración

Entrá a `/admin.html` con `ADMIN_USER` y `ADMIN_PASSWORD`.

- **Dashboard:** pedidos por día, modelos, colores, medios de pago, patas, estado de pagos, cobrado y por cobrar.
- **Pedidos:** aceptar, rechazar (con motivo), marcar entregado y confirmar transferencias.
- **Productos:** nombre, descripción, medidas, precios, fotos (se comprimen en el navegador), colores permitidos, patas permitidas, si se puede elegir izquierda o derecha (la foto se voltea), y si el color es único o distinto para cada pieza.
- **Telas y colores:** telas con recargo, colores con foto de muestra.
- **Maderas y patas:** opciones con foto y adicional de precio.

Al borrar un producto, sus fotos se borran. Los pedidos ya hechos conservan su copia y no se modifican.

## Reglas de precio

- Recargo de tela: se aplica el mayor de las dos piezas.
- Contado, débito y saldo MP: seña del 50%. Crédito: total íntegro (cuotas en Mercado Pago).
- Adicional de patas o madera: se suma al total.

## Correr en local

```
npm install
cp .env.example .env
npm test
npm start
```

## Render

El servicio debe usar `npm install` como build y `npm start` como start. `render.yaml` ya define las variables. Después de desplegar, cargá las telas, las maderas y los productos desde `/admin.html`.

## Pendientes

- Mercado Pago sigue apagado hasta probar compras de prueba.
- Las fotos de los 15 modelos originales no están en el repositorio: subilas desde el panel.
- Cuentas separadas para Sophie y vos: hoy hay un solo usuario de administración.
