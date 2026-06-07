# Deploy to Coolify

FreeQwenApi ships a Coolify-compatible `docker-compose.yml`. Coolify rejects environment-variable interpolation in volume paths (e.g. `${VAR:-./path}`), so mounts use fixed container paths and named Docker volumes.

## Quick start

1. In Coolify: **Add Resource** → **Private/Public Repository** → select this repo.
2. **Build Pack**: Docker Compose.
3. **Environment variables** (minimum):
   - `SKIP_ACCOUNT_MENU=true`
   - `PORT=3264` (must match the exposed port)
   - **Accounts** (pick one):
     - `QWEN_ACCOUNTS_JSON=[{"id":"acc_1","token":"..."},{"id":"acc_2","token":"..."}]`
     - or `QWEN_TOKENS=token1,token2` (comma-separated, auto ids)
     - Set `QWEN_ACCOUNTS_OVERWRITE=true` to replace tokens on each deploy
4. Assign a domain to the `qwen-proxy` service; Coolify routes traffic to port **3264**.
5. Deploy.

## Extract tokens (browser console)

Log into [chat.qwen.ai](https://chat.qwen.ai) in each account (use separate profiles/incognito). Paste in DevTools console:

```javascript
(() => {
  const token = localStorage.getItem('token');
  if (!token) return console.error('Not logged in — open chat.qwen.ai and sign in first');
  const entry = { id: 'acc_' + Date.now(), token, resetAt: null };
  console.log('Single account entry:\n', JSON.stringify(entry, null, 2));
  const w = window.__qwenAccounts = window.__qwenAccounts || [];
  w.push(entry);
  console.log('Collected accounts (' + w.length + '). Copy for QWEN_ACCOUNTS_JSON:\n', JSON.stringify(w, null, 2));
  try { copy(JSON.stringify(w)); console.log('Copied to clipboard'); } catch {}
})();
```

Run once per account. The last log line is your `QWEN_ACCOUNTS_JSON` value for Coolify.

## Persistent storage

These named volumes keep data across redeploys:

| Volume        | Container path   | Purpose                          |
|---------------|------------------|----------------------------------|
| `session_data`| `/app/session`   | Browser auth tokens / accounts   |
| `logs_data`   | `/app/logs`      | Application logs                 |
| `uploads_data`| `/app/uploads`   | Uploaded files                   |

In Coolify **Storages**, confirm the three volumes are attached. When deleting the resource, choose **Keep Volumes** to preserve sessions.

## First-time authentication

The container has no GUI for Qwen login. Seed the session volume before use:

**Option A — auth locally, then copy into the volume**

```bash
npm run auth
cp docker-compose.override.example.yml docker-compose.override.yml
docker compose up --build -d
docker compose cp ./session/. qwen-proxy:/app/session/
```

**Option B — shell into the running Coolify container**

Use Coolify’s terminal on `qwen-proxy` and run account setup scripts if you have SSH/file access to upload `session/` contents.

## Health check

Health checks are defined in the `Dockerfile` (`GET /api/health` on `PORT`). Coolify uses this for rolling updates and proxy routing.

## Local development

For bind mounts to `./session`, `./logs`, and `./uploads`:

```bash
cp docker-compose.override.example.yml docker-compose.override.yml
docker compose up --build -d
```

Run `npm run auth` first so `./session` contains valid credentials.
