# Sophie Living v4

Configurador de sillones con panel de administración, pedidos, transferencia y Mercado Pago.

## Panel de administración (`/admin.html`)

Entrás con la contraseña del panel (`ADMIN_PASSWORD`). El ingreso es dentro de la misma página.

- **Dashboard:** cifras y gráficos por periodo (hoy, 7 días, 30 días, este mes, este año, todo o fechas personalizadas).
- **Pedidos:** filtrar por periodo y estado, aceptar, rechazar con motivo, marcar entregado, confirmar transferencias y borrar pedidos.
- **Productos:** nombre, descripción, medidas, precios, fotos, colores, patas, izquierda/derecha y cuotas máximas por producto.
- **Telas y colores** y **Maderas y patas**: se administran con fotos y precios.
- **Configuración:** interés de cuotas (global) y seña (global).

## Reglas de precio

- Tarjeta de crédito: precio con tarjeta del producto + recargo de tela + interés global. Las cuotas (hasta el máximo de cada producto) se eligen en Mercado Pago.
- Transferencia, Mercado Pago y débito: el cliente paga el porcentaje de seña global. El resto se coordina con Sophie.
- Adicional de patas o madera: se suma al total.

## Variables de entorno (Render)

- `DATABASE_URL`, `DATABASE_SSL=true` (Supabase).
- `ADMIN_PASSWORD`: contraseña del panel.
- `SESSION_SECRET`: se genera sola en `render.yaml`.
- `SEED_LEGACY_CATALOG=true`: importa los productos del sitio anterior si la base está vacía. Después de la primera carga podés dejarla en `false`.
- Datos bancarios, tokens de Mercado Pago y `PUBLIC_BASE_URL` como antes.

## Notas

- Los productos del sitio anterior se importan con sus fotos (comprimidas) y sus telas Shot y Best. El Luxury Panamá/Tussor queda oculto hasta tener telas.
- Las muestras de color se descargan de los sitios originales al importar. Si alguna no carga, se puede subir la foto desde el panel.
- Sobre el precio con tarjeta: en el sitio anterior ya venía con financiación incluida. Con el interés global en 0%, el precio se mantiene igual que antes.
