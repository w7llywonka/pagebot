# pagebot

A bookmarklet that opens a small chat panel on any page. It can read the page text, your highlighted text, and screenshots (the whole tab or just a region), and it answers using Claude Haiku 5.5 or Claude Sonnet 5.5, optionally with web search. It runs on Railway with Postgres.

You own it and log in with your password or passcode. Other people can create their own accounts, but they can't ask anything until you accept them in `/admin`, and each of them gets a daily limit you set.

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
   | `TOKEN_BUDGET` | Used for the "tokens left" bar in `/admin` |
   | `TIMEZONE` | Sets when "today" starts in the stats and the usage chart |

4. **Settings → Networking → Generate Domain.**
5. Open `https://<your-domain>/` — that's the site: drag the button to your bookmarks bar, or use the full-page chat at `/chat`.

To generate an admin token: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`

The bookmarklet points back at whatever address you opened the homepage from. If you move to a different domain, open the homepage there and drag the button again.

Optional variables:

| Variable | Default | What it does |
|---|---|---|
| `HAIKU_MODEL` | `claude-haiku-5-5` | Model for the ⚡ Haiku setting. The older `MODEL` variable still works for this. |
| `SONNET_MODEL` | `claude-sonnet-5-5` | Model for the ✦ Sonnet setting. |
| `EFFORT` | `low` | How hard the models think before answering (`low`, `medium`, `high`, `xhigh`, `max`). Thinking counts toward each answer's token limit. |
| `SONNET_FALLBACK` | on | If Sonnet declines a request, the API retries it on the model Anthropic recommends. Set to `off` to turn that off. |
| `MAX_TOKENS` | `2048` | Starting value for "max tokens per answer" (8,000 at most). After that, change it in `/admin` or the panel's settings. |
| `SYSTEM_PROMPT` | built in | Replaces the default instructions. |
| `SESSION_DAYS` | `30` | How long a login lasts without use. Applies to accounts, and to you when no passcode is set. |

## Admin (`/admin`)

Enter your `ADMIN_TOKEN` to manage pagebot:

- **Usage**: tokens used today, over the last 7 days, and all time, plus roughly how long your budget will last at your current pace and an estimated cost at list prices.
- **Daily usage chart**: the last 7, 30, or 90 days, split by model, in tokens or dollars. Show everyone, just you, or one person. Hover a day for input/output tokens, cost, questions, and web searches, or open the table view.
- **Users**:
  - People who sign up wait under **Waiting to be accepted**, with the note they left. **Accept** lets them in; **Deny** deletes the request.
  - Click someone to set their **daily limit** in tokens or dollars (or no limit), choose whether they can use **Sonnet 5.5** and **web search**, and keep a private note. You also see what they've used today, over the last 7 days, and in total.
  - **Reset password**, **Sign out** (signs them out on every device), **Block** (signs them out and keeps them out until you unblock them), and **Delete** are there too.
  - The switch at the top opens or closes sign-ups. **What newly accepted users start with** sets the limit and access each new person gets when you accept them.
  - Daily limits reset at midnight in your `TIMEZONE`. Dollar amounts are estimates from Anthropic's list prices.
- **Limits per question**: max tokens per answer (8,000 at most), how much page text gets sent, and how many web searches one question can run. Accounts can pick a shorter answer length in their settings, but never more than this.
- **Passcode lock**: set a 5-digit passcode and choose how long the panel can sit idle before it locks (1 minute to 1 day, or never). With a passcode set, the panel shows a number pad instead of the password box. Wrong passcodes count for 24 hours, even if the right one is entered in between. After 10, only the password can unlock it.
- **Access password**: at least 8 characters. Changing it signs out every device you're logged in on. Accounts stay signed in.

## Using it

- Click the bookmark to open the panel. Click it again to hide it. Esc closes it.
- The panel takes the keyboard only when you open it with the bookmark. An answer arriving, a screenshot, or a lock never pulls your typing out of the page or another tab, and closing or minimizing the panel gives the keyboard back to the page.
- **Signing in**: while sign-ups are open (or anyone has an account), the panel opens on **Sign in**. **Owner? Unlock here** takes you to your passcode or password, and after that, the panel goes straight to it on that site. New people choose **Create an account**, pick a username and password, and can leave a note for you. Until you accept them, they see a screen saying they're waiting to be accepted into the program, and the panel opens up by itself once you do.
- **Drag the top bar** to move the panel anywhere on the page. It remembers where you put it on each site.
- **Minimize** (the – button) shrinks it to a small pill. A dot on the pill means an answer finished while it was minimized. Click the pill or the bookmark to open it again.
- The **+** button under the message box has everything you can add:
  - **Screenshot this tab**, or **Screenshot a region** to drag a box over just the part you mean. The panel hides itself while the shot is taken. You can also paste any image with Ctrl/Cmd+V.
  - Screenshots stay on after the first one (shown as a 📷 Screen or ⛶ Region pill): every message you send takes a new shot of the whole tab, or of the same area. Take a different kind of screenshot to switch, or click the pill to turn it off.
  - Chrome asks to share the tab the first time. Sharing then stays on, even when you close the panel, until you choose **Stop sharing this tab** in the + menu or Chrome's own Stop sharing button.
  - **Page text** sends the page along. It's on for the first message of each chat (shown as a 📄 Page pill) and off after that, since the page stays in the chat history anyway.
  - **Web search** lets the model search the web (shown as a 🌐 Web pill). Answers that used it list their sources.
  - Click a pill's × to turn that thing off.
- The model name next to the send button picks the model: ⚡ Haiku 5.5 is fast and cheap; ✦ Sonnet 5.5 is smarter.
- Every time you open the panel, a short animation plays while it loads (under 3 seconds).
- **⚙ Settings**: pick a theme (Auto, Ember, Paper, Midnight, Forest, Dusk, Sakura, Terminal, or Glass) and the max tokens per answer, from 512 up to 8k. No answer can go past 8,000 tokens. Settings apply everywhere you use pagebot, and each account has its own.
- **Glass** is see-through: the page shows through a soft blur, and the text switches between dark and light to match the page behind it.
- Links in answers show which site they go to, in grey after the link text.
- With an account, Settings also shows how much of today's limit is used, and lets you change your password. Each answer shows what's left for the day.
- Highlighted text on the page is included automatically.
- Old screenshots aren't resent on follow-ups, which saves tokens.
- Some sites block overlays. On those, pagebot opens in a small window instead. If your browser blocks that pop-up, click the bookmark again.
- You log in once per site, and it's remembered there. With a passcode set, the panel locks itself after the idle time you chose, or right away with the 🔒 button.

Updating from an older version? Drag the button from the homepage to your bookmarks bar again. Old bookmarks still work, but only the newest one makes Glass see-through on every site (with older ones it turns solid grey on dark-mode sites like Google's), plus the bigger panel, the animation on every open, and (for the oldest ones) moving, minimizing, and full-page region shots.

## Security

- **Daily limits hold**:
  - Each account gets one answer at a time.
  - An answer that's stopped partway (the panel closed or the page reloaded) stops there, but what it used still counts: the whole question, the answer so far, and any web searches it ran.
  - A question that wouldn't fit in what's left of the day is turned down, and the answer length is capped to fit.
- **Logins**:
  - Each address gets 10 tries a minute and 30 wrong logins an hour.
  - After 200 wrong owner passwords in an hour from anywhere, owner password logins pause until it dies down. Devices already signed in and the passcode keep working.
  - Passwords are stored as scrypt hashes, and sessions as hashes of random tokens.
- **Pages**:
  - Every page runs only its own scripts and talks only to this server.
  - Only `/widget` can be embedded in other sites.
  - Answers are shown as text with simple formatting, never as raw HTML.
- These counters live in memory, so restarting the server resets them, and they assume a single server instance (Railway's default).
- **Be careful on pages you don't trust**:
  - The bookmarklet runs inside the page you're on, so a malicious page could draw a fake panel to catch what you type.
  - Answers are generated from that page's text, so a page can try to steer them.
  - If a site looks off, use `/chat` instead.

## Local dev

```
cp .env.example .env   # set DATABASE_URL to a local Postgres
npm install
npm run dev
```
