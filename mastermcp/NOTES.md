> Notas técnicas de desarrollo del Master MCP integrado (en inglés, tal cual se escribieron). Las rutas con `~/.local/opt/chatgpt2`
> son las de la instalación por defecto; el instalador del repo las respeta o las sustituye por `CHATGPT2_HOME` / `CODEX_HOME`.
> La guía de uso está en el README principal del repo.

# ChatGPT 2 · Master MCP (Linux)

Independent loopback Master MCP inside the **ChatGPT 2 clone**. No live Tessarion daemon, workspace, tunnel, or 127.0.0.1:33575 dependency. Adapted from the user's local Tessarion MasterMCP Lite MIT source; LICENSE preserved. The @ngrok/ngrok JavaScript package and Linux native binary were copied from local packages (no download).

## Files and architecture

- src/host.ts → host.cjs (esbuild CJS): local Settings API at **127.0.0.1:8319**, authenticated with X-Hub-Token + Origin app://- (CLI without Origin is permitted). No public listener, no systemd.
- src/runtime.ts, src/master/*, src/core/*, src/web-ai/*, src/relay/protocol.ts: MIT Lite OAuth DCR + PKCE S256, Streamable HTTP MCP, encrypted OAuth grants/token vault, scope-gated workspace file/search/git/tests/sandboxed terminal.
- src/browser-controller.ts: own Brave CDP profile at ~/.codex-2/mastermcp-browser, independent of the Codex GUI browser; visible when started from desktop. Existing tabs must be shared **manually in Settings**. Browser JavaScript runs in the webpage, not Node. No arbitrary Node eval.
- Data root ~/.codex-2/mastermcp (0700), encrypted oauth.enc/secrets.enc plus separate key files (0600). control.json (0600) stores only enabled/mode/domain, **not** ngrok token. Domain is optional.
- ~/.local/opt/chatgpt2/modelhub/master-mcp-settings.js is inserted by the existing idempotent modelhub/patch_ui.py into clone-only resources/app.asar, extending Settings navigation and the cloned CSP.
- ~/.local/bin/chatgpt2 launches ModelHub :8318 and this host :8319, then the clone with CODEX_HOME=~/.codex-2. The MCP connection itself is **OFF by default**; when enabled in Settings its state persists across host relaunch.

## Usage

1. Relaunch **ChatGPT 2** with chatgpt2 after installation. Open **Ajustes → Master MCP** (not original ChatGPT/Codex app).
2. Add at least one authorized project folder with the KDE folder picker. Select global scopes; dangerous host/SSH/Docker/system/sudo/devices scopes are disabled by default.
3. Turn on locally, or choose ngrok and enter **your separate account's** token into the password field. The token is encrypted and never shown again; set your reserved domain if applicable.
4. Copy the **HTTPS /mcp URL** to the MCP connection dialog in ChatGPT web. Registration/authentication uses OAuth DCR+PKCE; the local pending request is **not** granted until you check a workspace and scopes and press **Aprobar**. You must perform login/approval yourself. Concessions can be reduced/revoked from Settings.
5. Browser actions require forja:read, forja:browser; changing pages requires forja:agent. Brave is **separate** from Codex's internal browser session.

Test from clone build:

    node ~/.local/opt/chatgpt2/mastermcp/tests/e2e.mjs

Rebuild CJS offline (if changing TypeScript):

    ~/Descargas/Tessarion-MasterMCP-Lite/node_modules/.bin/esbuild ~/.local/opt/chatgpt2/mastermcp/src/host.ts --bundle --platform=node --format=cjs --target=node22 --external:@ngrok/ngrok --outfile=$HOME/.local/opt/chatgpt2/mastermcp/host.cjs

Repack UI from the **original saved ASAR**:

    python3 -I ~/.local/opt/chatgpt2/modelhub/patch_ui.py

Backup of previous clone ASAR: ~/.local/opt/chatgpt2/resources/app.asar.before-mastermcp-20261019.bak. Launcher backup: ~/.local/bin/chatgpt2.before-mastermcp-20261019.bak.

## Permissions and limitations

- Controller only binds loopback, checks secret token and rejects foreign Origin. Public ngrok forwards **the separate OAuth-protected MCP endpoint**, not controller port 8319.
- No user OAuth approval is automatic. Synthetic E2E approval uses fresh temporary data root/workspace, unrelated to real connectors.
- forja:read alone can list/read. forja:agent is needed for mutations. Explicit workstation confirmation callbacks are **deny by default**; host-terminal/sudo/system privileges are not implicitly enabled. Filesystem protects clone installation, original ChatGPT/Codex and original profiles.
- Grant **least privilege**. Even approved browser/agent scopes can act as you on linked websites. Local CDP debugging may be reachable by other local same-user programs; do not expose its port through ngrok.
- **Codex parity is partial.** The forja_*_session tools are *not* advertised; Lite doesn't include AI sessions. The original Codex codex_app automation_update and GUI-private browser sockets were **not** bridged. No claim of scheduling automation, native GUI thread/turn access, or accessing original in-app browser.
- kdialog folder chooser and visible Brave require desktop session DISPLAY/WAYLAND_DISPLAY; headless test harness cannot prove a real UI render.
- ngrok connection with real token and ChatGPT web login/approval are reserved for user; not tested here. No Tessarion process or service is manipulated.
