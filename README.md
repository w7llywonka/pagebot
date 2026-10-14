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
- **Announcement**: post a message (up to 500 characters) and everyone with an account sees it at the top of their panel the next time they open it, until they close it. Posting a new one replaces it, **Take it down** hides it, and the card shows how many people have closed it.
- **Limits per question**: max tokens per answer (any number from 256 to 100,000), how much page text gets sent, and how many web searches one question can run. Accounts can pick a shorter answer length in their settings, but never more than this.
- **Passcode lock**: set a 5-digit passcode and choose how long the panel can sit idle before it locks (1 minute to 1 day, or never). With a passcode set, the panel shows a number pad instead of the password box. After 10 wrong passcodes in a row, only the password can unlock it.
- **Access password**: changing it signs out every device you're logged in on. Accounts stay signed in.

## Using it

- Click the bookmark to open the panel. Click it again to hide it. Esc closes it.
- **Signing in**: while sign-ups are open (or anyone has an account), the panel opens on **Sign in**. As the owner, leave the username blank and type your password. After that, on that site, the panel goes straight to your passcode (if you set one). New people choose **Create an account**, pick a username and password, and can leave a note for you. Until you accept them, they see a screen saying they're waiting to be accepted into the program, and the panel opens up by itself once you do.
- **Passcodes for everyone**: anyone with an account can set their own 5-digit passcode in ⚙ Settings (it asks for their password) and pick how long the panel can sit idle before it locks. Their panel then locks like yours, and that site shows their number pad. After 10 wrong passcodes in a row, only their password works.
- **Drag the top bar** to move the panel anywhere on the page. It remembers where you put it on each site.
- **Resize** by dragging the panel's left or top edge, or its top-left corner. The ▯ button next to minimize **docks** it to the right side as a full-height sidebar (drag its left edge to change the width); press it again to float it. Size and docking are remembered on each site.
- **Minimize** (the – button) shrinks it to a small pill. A dot on the pill means an answer finished while it was minimized. Click the pill or the bookmark to open it again.
- The **+** button under the message box has everything you can add:
  - **Screenshot this tab**, or **Screenshot a region** to drag a box over just the part you mean. Chrome asks to share the tab once per page load, and the panel hides itself while the shot is taken. You can also paste any image with Ctrl/Cmd+V.
  - **Page text** sends the page along. It's on for the first message of each chat (shown as a 📄 Page pill) and off after that, since the page stays in the chat history anyway.
  - **Web search** lets the model search the web (shown as a 🌐 Web pill). Answers that used it list their sources.
  - Click a pill's × to turn that thing off.
- The model name next to the send button picks the model: ⚡ Haiku 5.5 is fast and cheap; ✦ Sonnet 5.5 is smarter.
- Every time you open the panel, a short animation plays while it loads (under 3 seconds).
- **⚙ Settings**: pick a theme (Auto, Ember, Paper, Midnight, Forest, Dusk, Sakura, Terminal, or Glass) and the max tokens per answer, from presets between 512 and 8k (anything up to 100,000 can be set in `/admin`). Settings apply everywhere you use pagebot, and each account has its own.
- **✨ Your pagebot Wrapped** (top of ⚙ Settings): your year on pagebot, one card at a time — how many questions you asked, your most-asked sites, the hours you ask most, your go-to model, your favorite theme, and your longest streak of days in a row. Tap (or use ← →) to go through it. Early in a new year it shows the year before.
- **Glass** is see-through: the page shows through a soft blur, and the text switches between dark and light to match the page behind it.
- With an account, Settings also shows how much of today's limit is used, and lets you change your password and set a passcode. Each answer shows what's left for the day.
- **Announcements** from the owner show at the top of the panel until you press **Got it**.
- **Highlighted text** goes with your next message. While something on the page is highlighted, a ✂️ pill shows the start of it; click its × to leave it out. Once it's been sent, it isn't sent again unless you highlight something new.
- **Show me where**: when an answer uses the page, it gets small numbered markers. Click one and the page scrolls to the passage it came from and highlights it (click anywhere on the page to clear the highlight). Hover a marker to see the quote.
- Old screenshots aren't resent on follow-ups, which saves tokens.
- Some sites block overlays. On those, pagebot opens in a small window instead. If your browser blocks that pop-up, click the bookmark again.
- You log in once per site, and it's remembered there. With a passcode set (yours, or an account's own), the panel locks itself after the idle time you chose, or right away with the 🔒 button.

Updating from an older version? Drag the button from the homepage to your bookmarks bar again. Old bookmarks still work, but only the newest one gets resizing, docking, the ✂️ highlight pill, and "show me where" quotes (older bookmarks include highlighted text without a pill). Older ones also miss the blur behind the Glass theme (they get a frosted tint instead), the bigger panel, the animation on every open, and (for the oldest ones) moving, minimizing, and full-page region shots.

## Local dev

```
cp .env.example .env   # set DATABASE_URL to a local Postgres
npm install
npm run dev
```
