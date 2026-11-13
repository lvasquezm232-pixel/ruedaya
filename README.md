# RuedaYa - prototipo de mototaxis

Prototipo web responsive para probar el flujo acordado:

- Pasajero solicita una moto e indica destino.
- Los conductores de demostración responden en secuencia.
- El primero obtiene el chat privado; los demás esperan.
- “No hay acuerdo” cierra el turno y pasa al siguiente.
- La confirmación del trato simula el acuerdo de ambas partes y marca el viaje como confirmado.
- Mapa Leaflet + OpenStreetMap y geolocalización del navegador.
- Perfiles visuales: pasajero, mototaxista y panel administrativo.

## Estado actual

Esta entrega está en **modo demostración local**. Los conductores y respuestas son simulados y el estado se guarda solo en memoria durante la sesión. No hay todavía cuentas reales, sincronización entre teléfonos, chat real, notificaciones push ni asignación de viajes en producción.

## Probar localmente

Abre `index.html` mediante un servidor local (por ejemplo, la extensión Live Server de VS Code). La geolocalización requiere `localhost` o HTTPS y permiso del navegador.

## Publicación de prototipo en Vercel

1. Crea un repositorio personal en GitHub y sube el contenido de esta carpeta.
2. Importa el repositorio desde Vercel.
3. Framework preset: Other. Build command: vacío. Output directory: `.`.
4. Publica. El dominio `*.vercel.app` es suficiente para pruebas.

**Aviso:** Vercel Hobby es solo para uso personal/no comercial. No usar este plan para operar un servicio comercial de transporte. Revisar https://vercel.com/legal/terms y https://vercel.com/docs/limits/fair-use-guidelines.

## Backend gratuito propuesto: Supabase

1. Crear un proyecto gratuito en Supabase.
2. Ejecutar `supabase/schema.sql` en SQL Editor.
3. Añadir `drivers`, `ride_requests`, `ride_responses`, `ride_messages` y `trips` a la publicación Realtime.
4. Configurar Auth, RLS y las funciones RPC transaccionales antes de conectar el cliente.

La base SQL es una estructura inicial, no una implementación lista para producción. En particular, falta crear RPC seguras para ordenar respuestas de forma atómica, ceder el turno, aplicar expiración de inactividad y registrar la doble aceptación del precio. No exponer jamás la clave `service_role` en el frontend.

## Mapas

El prototipo usa los mosaicos públicos estándar de OpenStreetMap, con atribución. Son un servicio comunitario de mejor esfuerzo, no un servicio ilimitado ni con SLA. Para un despliegue de producción con tráfico alto, seleccionar un proveedor de mosaicos con límites/condiciones adecuados o autoalojar los mosaicos. Respetar https://operations.osmfoundation.org/policies/tiles/.

## IA y costos

No hay llamada a ningún modelo de IA ni API de pago. La lógica de cola, chat y confirmación es determinista. Una IA generativa integrada en producción puede implicar costos; no es necesaria para solicitar y asignar viajes.
