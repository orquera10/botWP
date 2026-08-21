# Proyecto WP Bot

Servidor Node.js con Express y Baileys para conectar varias cuentas de WhatsApp como dispositivos vinculados, separadas por nombre de cliente.

> Baileys no es la API oficial de WhatsApp Business. Usa el protocolo de WhatsApp Web y conviene usarlo con cuidado, sin spam ni automatizaciones abusivas.

## Requisitos

- Node.js 20 o superior.
- Un telefono con WhatsApp para escanear cada QR.

## Instalacion

```bash
npm install
cp .env.example .env
npm run dev
```

## Crear un cliente

Cada numero de WhatsApp se asocia a un perfil de negocio. El perfil define el flujo de respuestas y la API que usa. El servidor crea automaticamente `la-toxica` y `sin-automatizacion`; desde el panel admin se pueden agregar otros negocios.

Para crear un perfil de reservas por API:

```http
POST http://localhost:3000/businesses
Content-Type: application/json

{
  "name": "Padel Norte",
  "flows": ["reservas", "registro", "admin_agenda"],
  "apiUrl": "https://ejemplo.com/api.php",
  "apiKey": "clave-del-negocio",
  "adminApiUrl": "https://ejemplo.com/admin_api.php",
  "adminApiKey": "clave-administrativa-del-negocio",
  "settings": {
    "welcomeMessage": "¡Hola, {name}! Bienvenido a {businessName}.",
    "catalogUrl": "https://ejemplo.com/catalogo.php",
    "unregisteredMessage": "Para continuar necesito comprobar tus datos.",
    "adminAgendaAction": "turnos"
  },
  "adminPhones": ["5491112345678"]
}
```

Las API keys quedan en el servidor y no se devuelven al navegador al listar clientes o negocios.

Los modulos se habilitan por negocio. `reservas` consulta y crea reservas; si el telefono no existe, deriva automaticamente al modulo `registro`, que solicita nombre y email en un estado independiente. El endpoint `crear_cliente` puede asociar el telefono remitente a un usuario encontrado por email y, al terminar, el bot vuelve a la seleccion de cancha. `admin_agenda` solo responde a telefonos incluidos en `adminPhones`. Usa credenciales separadas (`adminApiUrl` y `adminApiKey`) y el encabezado `X-Admin-API-Key`.

El flujo administrativo muestra un menu exclusivo cuando un administrador escribe `hola` o `menu`; permite responder `1`, `2` o `3`. Tambien reconoce consultas como `agenda de hoy`, `informe diario de ayer` e `informe mensual julio 2026`. Consume `turnos`, `informe_diario` e `informe_mensual` y muestra por WhatsApp los turnos o el resumen financiero correspondiente.

Para La Toxica tambien se puede configurar directamente en `.env`:

```env
ADMIN_API_URL=https://mediumslateblue-pony-524766.hostingersite.com/admin_api.php
ADMIN_API_KEY=tu-clave-administrativa
ADMIN_PHONES=5491112345678,5491198765432
CATALOG_URL=https://mediumslateblue-pony-524766.hostingersite.com/catalogo.php
BUSINESS_TIME_ZONE=America/Argentina/Buenos_Aires
```

Los telefonos se escriben con codigo de pais, sin `+`, espacios ni guiones. Al iniciar, se guardan como administradores de `la-toxica` y, cuando la URL y la clave estan configuradas, se habilita la agenda administrativa. Tambien podes administrarlo desde el panel marcando **Agenda para administradores** al guardar el negocio La Toxica.

En Postman:

```http
POST http://localhost:3000/clients
Content-Type: application/json

{
  "clientName": "Cliente Demo",
  "businessId": "la-toxica"
}
```

El servidor normaliza el nombre para usarlo como carpeta. Por ejemplo, `Cliente Demo` se guarda como `cliente-demo`.

Si `DATABASE_URL` esta configurado, tambien guarda el cliente en PostgreSQL.

## Conectar WhatsApp

Abri el QR del cliente:

```http
GET http://localhost:3000/clients/cliente-demo/qr
```

Escanealo desde WhatsApp:

```text
WhatsApp > Dispositivos vinculados > Vincular un dispositivo
```

La sesion queda guardada en:

```text
sessions/clients/cliente-demo
```

## Endpoints

Listar clientes activos en memoria:

```http
GET http://localhost:3000/clients
```

Ver estado de un cliente:

```http
GET http://localhost:3000/clients/cliente-demo/status
```

Ver ultimos mensajes recibidos por ese cliente:

```http
GET http://localhost:3000/clients/cliente-demo/messages
```

Con PostgreSQL activo, ese endpoint devuelve mensajes persistidos. Sin PostgreSQL, devuelve solo los mensajes en memoria desde que prendiste el servidor.

Listar conversaciones guardadas:

```http
GET http://localhost:3000/clients/cliente-demo/conversations
```

Ver mensajes de una conversacion:

```http
GET http://localhost:3000/clients/cliente-demo/conversations/5491123456789@s.whatsapp.net/messages
```

Enviar mensaje desde ese cliente:

```http
POST http://localhost:3000/clients/cliente-demo/send
Content-Type: application/json

{
  "to": "5491123456789",
  "message": "Hola desde Cliente Demo"
}
```

`to` puede ser un numero internacional sin `+`, o un JID completo como `5491123456789@s.whatsapp.net`.

Cerrar la sesion de un cliente:

```http
POST http://localhost:3000/clients/cliente-demo/logout
```

## Panel administrador

El proyecto incluye una web simple:

```text
http://localhost:3000/admin
```

Desde ahi podes:

- crear clientes
- ver estado de conexion
- abrir QR
- iniciar, resetear o cerrar sesiones
- enviar mensajes
- ver conversaciones y mensajes guardados

Para protegerlo, configura `.env`:

```env
ADMIN_USER=admin
ADMIN_PASSWORD=cambia-esta-clave
```

Si dejas esas variables vacias, `/admin` queda sin login.

### Error `Stream Errored (conflict)`

Este error significa que WhatsApp reemplazo la conexion de esa sesion por otra
que usa las mismas credenciales. Detene cualquier otra instancia del bot,
presiona **Resetear** en el panel y escanea el QR nuevo. No copies la carpeta
`sessions/clients/<cliente>` entre servidores ni ejecutes dos procesos con esa
misma carpeta.

## Multiples clientes

Repeti el flujo con otro `clientName`:

```http
POST http://localhost:3000/clients
Content-Type: application/json

{
  "clientName": "Ventas Norte"
}
```

QR:

```http
GET http://localhost:3000/clients/ventas-norte/qr
```

Enviar:

```http
POST http://localhost:3000/clients/ventas-norte/send
```

## Webhook opcional

Si queres reenviar cada mensaje entrante a otro servicio, configura en `.env`:

```env
WEBHOOK_URL=https://tu-servidor.com/webhook
```

El webhook incluye `clientId` y `clientName` para que sepas a que cliente pertenece el mensaje.

## Flujo de reservas por WhatsApp

El bot puede tomar reservas conversando con el cliente y usando la API PHP del sistema de turnos.

Configura:

```env
WP_RESERVAS_API_URL=https://mediumslateblue-pony-524766.hostingersite.com/wp_reservas_api.php
WP_RESERVAS_API_KEY=
CATALOG_URL=https://mediumslateblue-pony-524766.hostingersite.com/catalogo.php
BUSINESS_TIME_ZONE=America/Argentina/Buenos_Aires
RESERVATION_FLOW_TIMEOUT_MINUTES=120
```

Cuando `CATALOG_URL` tiene un valor, el bot agrega el enlace al mensaje de bienvenida. Tambien podes usar `{catalogUrl}` en el saludo para elegir exactamente en que parte mostrarlo.
`BUSINESS_TIME_ZONE` define la zona horaria usada para interpretar `hoy`, `manana`, `ayer` y `este mes`, independientemente de la zona horaria del servidor.

Si `WP_RESERVAS_API_KEY` queda vacio, usa `API_KEY`. El flujo se activa cuando el cliente escribe algo como `reservar`, `turno`, `cancha` o `futbol`.
Si el cliente deja una reserva incompleta sin responder, el estado vence despues de `RESERVATION_FLOW_TIMEOUT_MINUTES` minutos y el bot pide empezar de nuevo.

El bot:

- responde cualquier primer contacto con una presentacion como asistente virtual y el menu principal, aunque el mensaje inicial ya mencione turnos o registro
- informa en el menu que `cancelar` o `menu` permiten volver al menu principal en cualquier momento
- identifica el telefono desde el JID de WhatsApp cuando viene como `@s.whatsapp.net`
- si el mensaje viene como `@lid`, intenta usar primero el mapeo automatico de WhatsApp; cuando no esta disponible pide una sola vez el numero, acepta formatos habituales como `388 410-4530`, `0388 15 410-4530` o `+54 9 388 410-4530`, y relaciona el LID con el JID canonico
- permite consultar disponibilidad sin registrarse; despues de mostrar los horarios pregunta si el usuario quiere reservar y, si acepta, verifica el registro antes de continuar sin perder cancha, duracion, fecha ni horarios
- al iniciar una reserva permite elegir cancha, duracion, fecha y horario antes de verificar o registrar al cliente
- cuando un telefono no esta registrado, busca primero al cliente por email; si lo encuentra asocia el telefono y continua, y si tampoco existe pide nombre y apellido para crear el cliente
- durante el registro puede usar el `pushName` de WhatsApp como pista para buscar un posible cliente por nombre; solicita que el usuario escriba el telefono y email guardados para verificar la coincidencia sin exponerlos
- en los saludos usa `pushName` para personas no identificadas y el nombre normalizado de la base para clientes registrados
- al consultar `mis reservas`, si el telefono no esta vinculado guia el mismo proceso de email y registro y retoma automaticamente la consulta
- consulta canchas, terminos, disponibilidad y turnos contra `wp_reservas_api.php`
- envia los terminos y la instruccion para responder `SI ACEPTO` en mensajes separados para facilitar la lectura
- pregunta cancha, duracion, fecha, horario, aceptacion de terminos, nombre/email si hacen falta
- crea la reserva y devuelve el link de pago de Mercado Pago
- informa que el link de Mercado Pago permanece activo 10 minutos y que, vencido ese plazo sin pago, el turno se cancela y debe solicitarse nuevamente
- despues de acreditarse la seña de una reserva de cumpleaños, ofrece crear una invitacion personalizada con nombre, fecha, horario y telefono de confirmacion
- envia la invitacion personalizada, la plantilla base, el reglamento y el contacto `https://wa.me/5493886002759`; las imagenes se encuentran en `assets/birthday`
- responde consultas como `mis reservas`, `mis turnos`, `ver reservas` o `consultar turno`; combina turnos pasados y futuros, elimina duplicados y muestra hasta 5 reservas ordenadas desde la fecha y hora mas recientes
- registra clientes nuevos cuando escriben `registrarme` o cuando quieren reservar con un telefono no registrado
- si el email o nombre ya existen en la API, el endpoint `crear_cliente` puede actualizar/asociar el telefono en vez de crear un duplicado

## PostgreSQL

Configura `.env` con tu conexion:

```env
DATABASE_URL=postgres://usuario:password@localhost:5432/wpbot
DB_SSL=false
```

Al iniciar, el servidor crea automaticamente estas tablas si no existen:

- `clients`
- `conversations`
- `messages`

Se guarda:

- metadata de cada cliente/sesion
- estado de conexion
- carpeta local de credenciales Baileys
- conversaciones por cliente
- mensajes entrantes y salientes
- payload raw del mensaje en `jsonb`

Las credenciales internas de Baileys siguen en disco dentro de `sessions/clients/<cliente>`. PostgreSQL guarda la metadata y el historial. Esto evita tocar de entrada el storage interno de autenticacion de Baileys, que es la parte mas sensible.
