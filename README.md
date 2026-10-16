# pagebot

A bookmarklet that opens a small chat panel on any page. It can read the page text, your highlighted text, and screenshots (the whole tab or just a region), and it answers using Claude Haiku 5.5 or Claude Sonnet 5.5, optionally with web search. It runs on Railway with Postgres.

You own it and log in with your password or passcode. Other people can create their own accounts (and give them their own passcode), but they can't ask anything until you accept them in `/admin`, and each of them gets a daily limit you set.

## Deploy on Railway

1. **New Project → Deploy from GitHub repo →** pick this repo.
2. In the same project: **+ Create → Database → PostgreSQL**. Leave it named `Postgres`.
3. Open the pagebot service → **Variables → Raw Editor**, paste the contents of `.env.example`, and fill in the blanks:

   | Variable | What to put |
   |---|---|
   | `DATABASE_URL` | Leave as `${{Postgres.DATABASE_URL}}`. Railway fills it in. |
   | `ANTHROPIC_API_KEY` | Your key from console.anthropic.com |
   | `OPENROUTER_API_KEY` | Optional. Your key from openrouter.ai/keys. It adds ◆ Muse Spark 1.3 to the model menu, which runs on your OpenRouter credits. Leave it blank to skip it. |
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
| `OPENROUTER_MODEL` | `meta/muse-spark-1.3-contributor` | Model for the ◆ setting, as an OpenRouter model id. Only used when `OPENROUTER_API_KEY` is set. |
| `SONNET_FALLBACK` | on | If Sonnet declines a request, the API retries it on the model Anthropic recommends. Set to `off` to turn that off. |
| `MAX_TOKENS` | `2048` | Starting value for "max tokens per answer" (100,000 at most). After that, change it in `/admin` or the panel's settings. |
| `SYSTEM_PROMPT` | built in | Replaces the default instructions. |
| `SESSION_DAYS` | `30` | How long a login lasts without use. Applies to accounts, and to you when no passcode is set. |

## Admin (`/admin`)

Enter your `ADMIN_TOKEN` to manage pagebot:

- **Usage**: tokens used today, over the last 7 days, and all time, plus roughly how long your budget will last at your current pace and an estimated cost at list prices.
- **Daily usage chart**: the last 7, 30, or 90 days, split by model, in tokens or dollars. Show everyone, just you, or one person. Hover a day for input/output tokens, cost, questions, and web searches, or open the table view.
- **Users**:
  - People who sign up wait under **Waiting to be accepted**, with the note they left. **Accept** lets them in; **Deny** deletes the request.
  - Click someone to set their **daily limit** in tokens or dollars (or no limit), choose whether they can use **Sonnet 5.5** and **web search**, and keep a private note. You also see what they've used today, over the last 7 days, and in total.
  - **Reset password**, **Sign out** (signs them out on every device), **Block** (signs them out and keeps them out until you unblock them), and **Delete** are there too. Resetting a password also turns off that person's passcode. Each person's details show whether they have a passcode.
  - The switch at the top opens or closes sign-ups. **What newly accepted users start with** sets the limit and access each new person gets when you accept them.
  - Daily limits reset at midnight in your `TIMEZONE`. Dollar amounts are estimates from Anthropic's list prices.
- **Bans and terminations** (under **Moderation** in each person's details):
  - **Ban** someone for 1 hour, 1, 3, 7, 14 or 30 days, or permanently, with a reason (pick one or write your own) and an optional moderator note. They see both.
  - Their panel switches to a ban notice right away (the next time it talks to the server) and opens the full notice in a new tab on your pagebot site, at `/banned`. It shows the reason, the note, when it was reviewed, when it ends, and a countdown. Signing in again shows the same notice.
  - When a timed ban ends, they tick **I agree to follow pagebot’s rules** and press **Re-activate my account**, on the notice or in the panel. A permanent ban never ends on its own.
  - **Terminate** shows a termination notice on every sign-in, and the account is deleted 14 days later (their usage stays in the totals). **Reverse termination** undoes it before then.
  - **Unban** lifts a ban at any time; their panel goes back to the chat by itself within 30 seconds. Banning someone who's already banned replaces the old ban.
  - The person's row shows a **Banned** or **Terminated** chip with the time left, and their details show whether they've seen the notice yet, a link to it, and their past bans.
  - The **Moderation** card lists every ban and termination, newest first, with what happened to each one (still in force, re-activated, lifted, account deleted), and lets you unban from there.
- **Announcement**: post a message (up to 500 characters) and everyone with an account sees it at the top of their panel the next time they open it, until they close it. Posting a new one replaces it, **Take it down** hides it, and the card shows how many people have closed it.
- **Limits per question**: max tokens per answer (any number from 256 to 100,000), how much page text gets sent, and how many web searches one question can run. Accounts can pick a shorter answer length in their settings, but never more than this.
- **Passcode lock**: set a 5-digit passcode and choose how long the panel can sit idle before it locks (1 minute to 1 day, or never). With a passcode set, the panel shows a number pad instead of the password box. Wrong passcodes count for 24 hours, even if the right one is entered in between. After 10, only the password can unlock it.
- **Access password**: at least 8 characters. Changing it signs out every device you're logged in on. Accounts stay signed in.

## Using it

- Click the bookmark to open the panel. Click it again to hide it. Esc closes it.
- The panel takes the keyboard only when you open it with the bookmark. An answer arriving, a screenshot, or a lock never pulls your typing out of the page or another tab, and closing or minimizing the panel gives the keyboard back to the page.
- **Signing in**: while sign-ups are open (or anyone has an account), the panel opens on **Sign in**. As the owner, leave the username blank and type your password. After that, on that site, the panel goes straight to your passcode (if you set one). New people choose **Create an account**, pick a username and password, and can leave a note for you. Until you accept them, they see a screen saying they're waiting to be accepted into the program, and the panel opens up by itself once you do.
- **Passcodes for everyone**: anyone with an account can set their own 5-digit passcode in ⚙ Settings (it asks for their password) and pick how long the panel can sit idle before it locks. Their panel then locks like yours, and that site shows their number pad. Wrong passcodes count for 24 hours, even if the right one is entered in between. After 10, only their password works.
- **Drag the top bar** to move the panel anywhere on the page. It remembers where you put it on each site.
- **Resize** by dragging the panel's left or top edge, or its top-left corner. The ▯ button next to minimize **docks** it to the right side as a full-height sidebar (drag its left edge to change the width); press it again to float it. Size and docking are remembered on each site.
- **Minimize** (the – button) shrinks it to a small pill. A dot on the pill means an answer finished while it was minimized. Click the pill or the bookmark to open it again.
- The **+** button under the message box has everything you can add:
  - **Screenshot this tab**, or **Screenshot a region** to drag a box over just the part you mean. The panel hides itself while the shot is taken. You can also paste any image with Ctrl/Cmd+V.
  - Screenshots stay on after the first one (shown as a 📷 Screen or ⛶ Region pill): every message you send takes a new shot of the whole tab, or of the same area. Take a different kind of screenshot to switch, or click the pill to turn it off.
  - Chrome asks to share the tab the first time. Sharing then stays on, even when you close the panel, until you choose **Stop sharing this tab** in the + menu or Chrome's own Stop sharing button.
  - **Page text** sends the page along. It's on for the first message of each chat (shown as a 📄 Page pill) and off after that, since the page stays in the chat history anyway.
  - **Web search** lets the model search the web (shown as a 🌐 Web pill). Answers that used it list their sources.
  - Click a pill's × to turn that thing off.
- The model name next to the send button picks the model: ⚡ Haiku 5.5 is fast and cheap; ✦ Sonnet 5.5 is smarter. With `OPENROUTER_API_KEY` set there's also ◆ Muse Spark 1.3, Meta's model through OpenRouter (the cheapest of the three). Its answers don't point at passages on the page.
- When a new version of pagebot is out, a panel opened from an older bookmark shows a small strip that links to the homepage, where dragging the button again updates it. The version is in small print at the bottom of ⚙ Settings and in the homepage footer.
- While an answer is coming in, the send button turns into a **stop** button. What arrived so far stays in the chat, and follow-ups can build on it.
- Scroll up while an answer is coming in and the panel stays where you are. **Jump to latest** takes you back down.
- A new chat offers one-click starters: **Summarize this page**, **Key points**, and **Explain it simply**.
- Each answer has a copy button next to its details, and code blocks get their own **Copy** button when you hover them.
- The panel opens as soon as its settings load. Reopening an existing panel goes straight back to the chat while refreshing your session.
- **⚙ Settings**: pick a theme (Auto, Ember, Paper, Midnight, Forest, Dusk, Sakura, Terminal, Glass, or Clear) and the max tokens per answer, from presets between 512 and 8k (anything up to 100,000 can be set in `/admin`). Settings apply everywhere you use pagebot, and each account has its own.
- **Website memory** in Settings saves instructions for a particular website, such as “Explain code with examples” or “Keep answers to three bullet points.” Open Settings on that website, write your instructions, and save them. You can also enter another website or choose a saved one to edit or delete it, including from `/chat`. Instructions apply automatically to your next question on that website, even with Page text off, and persist across visits and devices. Each account has its own memory, with up to 100 websites and 4,000 characters per website. Matching uses the exact hostname: paths and ports share instructions, while subdomains such as `www.example.com` and `docs.example.com` are separate. Memory stores only the instructions you save; it does not automatically save facts or conversations as instructions.
- **✨ Your pagebot Wrapped** (top of ⚙ Settings): your year on pagebot, one card at a time — how many questions you asked, your most-asked sites, the hours you ask most, your go-to model, your favorite theme, and your longest streak of days in a row. Tap (or use ← →) to go through it. Early in a new year it shows the year before.
- **Glass** is see-through: the page shows through a soft blur, and the text switches between dark and light to match the page behind it.
- **Clear** drops the panel entirely: no tint, no blur, no shadow, only the words, buttons and message box floating over the page. Text gets a thin halo so it stays readable, and switches between dark and light like Glass.
- Answers show headings, lists, tables, quotes, bold and italics. Links show which site they go to, in grey after the link text.
- With an account, Settings also shows how much of today's limit is used, and lets you change your password and set a passcode. Each answer shows what's left for the day.
- **Announcements** from the owner show at the top of the panel until you press **Got it**.
- **If your account is banned**, the panel shows why instead of the chat and opens the full notice in a new tab. A timed ban counts down; once it's over, agree to the rules to re-activate the account. A terminated account shows its notice every time you sign in, until it's deleted.
- **Highlighted text** goes with your next message. While something on the page is highlighted, a ✂️ pill shows the start of it; click its × to leave it out. Once it's been sent, it isn't sent again unless you highlight something new.
- **Show me where**: when an answer uses the page, it gets small numbered markers. Click one and the page scrolls to the passage it came from and highlights it (click anywhere on the page to clear the highlight). Hover a marker to see the quote.
- Old screenshots aren't resent on follow-ups, which saves tokens.
- Some sites block overlays. On those, pagebot opens in a small window instead. If your browser blocks that pop-up, click the bookmark again.
- You log in once per site, and it's remembered there. With a passcode set (yours, or an account's own), the panel locks itself after the idle time you chose, or right away with the 🔒 button.

Updating from an older version? Drag the button from the homepage to your bookmarks bar again to get smoother dragging and resizing, faster quote lookup, and lighter page requests when Page text is off. Old bookmarks still work, but only newer ones get resizing, docking, the ✂️ highlight pill, and "show me where" quotes (older bookmarks include highlighted text without a pill). Older ones also miss the see-through Glass on every site and the shadow-free Clear (with older ones they turn solid grey on dark-mode sites like Google's), the bigger panel, and (for the oldest ones) moving, minimizing, and full-page region shots.

## Security

- **Daily limits hold**:
  - Each account gets one answer at a time.
  - An answer that's stopped partway (you press stop, close the panel, or reload the page) stops there, but what it used still counts: the whole question, the answer so far, and any web searches it ran.
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

## Versions

pagebot's version is `VERSION` at the top of `server.js` (now 8). It's written into the bookmark people drag from the homepage. To release an update, raise it by one and deploy. Panels opened from an older bookmark then point people to the homepage to drag the new one.

Changes to the panel and the server reach everyone as soon as you deploy, whatever their bookmark. Raise the version whenever `bookmarklet.js` changes, or whenever you want everyone to get a fresh bookmark.

## Local dev

```
cp .env.example .env   # set DATABASE_URL to a local Postgres
npm ci
npm run dev
```

Node 20 or newer and PostgreSQL are required. The server creates its tables and applies additive schema updates at startup, including website memory. Set `INITIAL_PASSWORD` and a 16-character-or-longer `ADMIN_TOKEN` for local sign-in and administration. An `ANTHROPIC_API_KEY` is required for real Claude replies; `OPENROUTER_API_KEY` is optional. Keep credentials in environment variables or the ignored `.env` file.

Run `npm test` for bookmarklet regression tests. To also run the website-memory and ban integration tests, point `PAGEBOT_TEST_DATABASE_URL` at a disposable PostgreSQL database before running `npm test`; without it, those integration tests are explicitly skipped. They create and clean up a separate schema and use local mock model servers, so they need no AI keys or credits. Browser regression tests run with `npm run test:browser` and require Playwright and Chromium.
