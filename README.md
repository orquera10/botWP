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

En Postman:

```http
POST http://localhost:3000/clients
Content-Type: application/json

{
  "clientName": "Cliente Demo"
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
