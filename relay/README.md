# Relay de ChatGPT 2 Remote (Cloudflare Worker)

Un buzón HTTPS efímero que conecta tu PC con tu teléfono. **No es un proxy de modelos**: tus conversaciones, credenciales y
herramientas se quedan en tu PC. El teléfono y la PC cifran todo de punta a punta (AES-256-GCM) con una clave que solo viaja en el QR de
emparejamiento; el relay guarda únicamente verificadores (SHA-256) y paquetes cifrados opacos (órdenes 5 min, respuestas 15 min, máximo 100 en cola).

Es el mismo relay «Forja Remote Anywhere» del proyecto Tessarion, con otro nombre. Cada persona despliega el suyo: el plan gratuito de Cloudflare basta.

## Desplegar el tuyo (una vez)

Necesitas una cuenta gratuita de Cloudflare y Node 18+.

```bash
cd relay
npm install
npx wrangler login          # abre el navegador para autorizar
npx wrangler deploy         # imprime la URL: https://chatgpt2-relay.<tu-usuario>.workers.dev
```

La URL que te imprime es la que pegas en **Ajustes → Modelos personalizados → Control desde el teléfono → URL de tu relay**.
Tiene que ser HTTPS y de 64 caracteres como máximo (limite del QR).

## Seguridad

- Hasta 8 teléfonos emparejados; cada uno tiene su propio token y se puede revocar desde Ajustes.
- El QR de emparejamiento se consume la primera vez que un teléfono lo usa.
- «Renovar claves» o «Desactivar y desemparejar todo» borran la sala del relay al instante.
- El relay no puede leer mensajes ni capturas; solo ve tamaños y horas de los paquetes.
