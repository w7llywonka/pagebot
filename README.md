# pagebot

A bookmarklet that opens a small chat panel on any page. It can read the page text, your highlighted text, and screenshots, and it answers using Claude Haiku 5.5. It runs on Railway with Postgres.

## Deploy on Railway

1. **New Project → Deploy from GitHub repo →** pick this repo.
2. In the same project: **+ Create → Database → PostgreSQL**. Leave it named `Postgres`.
3. Open the pagebot service → **Variables → Raw Editor**, paste the contents of `.env.example`, and fill in the blanks:

   | Variable | What to put |
   |---|---|
   | `DATABASE_URL` | Leave as `${{Postgres.DATABASE_URL}}`. Railway fills it in. |
   | `ANTHROPIC_API_KEY` | Your key from console.anthropic.com |
   | `ADMIN_TOKEN` | Your personal admin token. Use a long random string (16+ chars). It unlocks `/admin`. |
   | `INITIAL_PASSWORD` | The first password for the bookmarklet. It's only used if no password is set yet. You can delete it after the first deploy. |
   | `MODEL` | `claude-haiku-5-5` |
   | `TOKEN_BUDGET` | Used for the "tokens left" bar in `/admin` |
   | `TIMEZONE` | Sets when "today" starts in the stats |

4. **Settings → Networking → Generate Domain.**
5. Open `https://<your-domain>/install` and drag the button to your bookmarks bar.

To generate an admin token: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`

Optional variables: `SYSTEM_PROMPT`, `MAX_TOKENS` (default 2048), `SESSION_DAYS` (default 30), `PUBLIC_URL` (set this if you add a custom domain, then re-install the bookmarklet).

## Admin (`/admin`)

Enter your `ADMIN_TOKEN` to change the bookmarklet password. Changing it signs out every device. The page also shows tokens used today, over the last 7 days, and all time, plus roughly how long your budget will last at your current pace.

## Using it

- Click the bookmark to open the panel. Click it again to hide it. Esc closes it.
- **📄 Page** attaches the page text (up to 20k characters). It's on for the first message of each chat and off after that, since the page stays in the chat history anyway.
- **📷 Screenshot**: Chrome asks to share the tab once per page load. The panel hides itself while the shot is taken. You can also paste any image with Ctrl/Cmd+V.
- Highlighted text on the page is included automatically.
- Old screenshots aren't resent on follow-ups, which saves tokens.
- Some sites block overlays. On those, the bookmark shows an "Open pagebot" button that opens it in a popup window instead.
- You log in once per site, and it's remembered there.

## Local dev

```
cp .env.example .env   # set DATABASE_URL to a local Postgres
npm install
npm run dev
```
