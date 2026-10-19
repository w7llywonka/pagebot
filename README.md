# pagebot

A bookmarklet that opens a small chat panel on any page. It can read the page text, your highlighted text, screenshots (the whole tab or just a region), and PDFs you upload, and it answers using Claude Haiku 5.5 or Claude Sonnet 5.5, optionally with web search. It runs on Railway with Postgres.

You own it and log in with your password or passcode. Other people can create their own accounts (and give them their own passcode), but they can't ask anything until you accept them in `/admin`, and each of them gets a daily limit you set. They see how much of it they've used as a percentage; only you see the actual tokens and dollars.

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
| `PDF_STORAGE_MB` | `100` | How much uploaded-PDF storage each person (the owner counts as a person) can keep at once, in MB. Fractions work (`0.5`). Going over it turns the upload down with a note to delete a PDF. See **PDFs**. |
| `SYSTEM_PROMPT` | built in | Replaces the default instructions. |
| `SESSION_DAYS` | `30` | How long a login lasts without use. Applies to accounts, and to you when no passcode is set. |

## Admin (`/admin`)

Enter your `ADMIN_TOKEN`. The admin page has five tabs:

- **Overview**: pick a range (today, 7, 30 or 90 days) and a person, or everyone. Everything on the tab follows that choice:
  - Tiles for questions, tokens, estimated cost, people asking, web searches and average answer length. Each is compared with the period just before.
  - A usage chart split by model, in tokens or dollars: per hour for today, per day otherwise. Hover for details, or open the table view.
  - Your token budget, and how long it lasts at the current pace.
  - Tables by model, by what came with the questions (page text, highlights, screenshots, PDFs, web search, declined, stopped, fallbacks), by top people, and by top sites.
  - A heatmap of the busiest days and hours.
  - Click a row to jump to those questions in Activity, or to that person.
- **People**:
  - The waiting list, with the note each person left. Accept or deny people one at a time or all at once.
  - A sortable, searchable table with these columns: status, daily limit, today's use against it, questions and cost this week, cost all time, Sonnet, web search, PDF and page actions access, devices, last active, and joined.
  - Select several people to change them together: set a daily limit, turn Sonnet, web search, PDF upload or page actions on or off, sign them out, block or unblock them.
  - Click someone to open their panel:
    - usage today, this week and all time, plus a 30-day chart
    - under their usage, a small line like **PDFs stored: 3 (12.4 MB of 100 MB cap)** (the file count and size they have stored now, against `PDF_STORAGE_MB`)
    - their daily limit (tokens, dollars or none), Sonnet, web search, PDF upload and page actions access, and a private note
    - their recent questions and the devices they're signed in on
    - whether they have a passcode, and how soon their panel locks
    - moderation: ban, restrict or terminate them, answer their appeal, and their past bans and restrictions
    - reset password (it turns their passcode off too), sign out everywhere, block, and delete
  - The sign-ups switch, what newly accepted people start with, and a CSV export.
  - **Bans, restrictions and terminations** (under **Moderation** in each person’s panel):
    - **Ban** someone for 1 hour, 1, 3, 7, 14 or 30 days, or permanently, with a reason (pick one or write your own) and an optional moderator note. They see both.
    - Their pagebot panel switches to a ban notice right away (the next time it talks to the server), in place of the chat. It shows their account, the reason, the note, when it was reviewed, when it ends, and a countdown. Signing in again shows the same notice.
    - When a timed ban ends, they tick **I agree to follow pagebot’s rules** and press **Re-activate my account** in the panel. A permanent ban never ends on its own.
    - **Terminate** shows a termination notice on every sign-in, and the account is deleted 14 days later (their usage stays in the totals). **Reverse termination** undoes it before then.
    - **Unban** lifts a ban at any time; their panel goes back to the chat by itself within 30 seconds. Banning someone who's already banned replaces the old ban.
    - **Appeals**: a banned or terminated person can send one appeal per ban from their panel. It shows up under **Appeals waiting** at the top of the **Moderation** card (with a count, which the People tab's badge includes) and in their panel. **Accept & unban** lifts the ban; **Deny** keeps it. Either way you can add a reply, and their panel shows your answer.
    - **Restrict** is the lighter option: for 1 hour to 30 days, take away Sonnet, web search, PDF uploads, page actions, and/or set a different daily limit. They keep using pagebot, with a note above their chat saying what's restricted, why, and until when. It ends by itself, or press **Lift restriction**. Their own settings aren't changed: while it runs, the table's daily limit, today and "can use" columns show what they have now with a **restricted** tag (hover it for their own setting), and changing their settings, one at a time or in bulk, takes effect once it ends.
    - **Terminated people can't sign straight back up**: a terminated account's username stays taken, even after the account is deleted, and a browser that was used by a terminated account can't create new accounts. Anyone else who has used the same browser gets a **⚠ shared browser** tag in the table and the waiting list, and a warning in their panel. This goes by a random id the panel keeps in the browser's storage, so clearing site data or switching browsers gets around it. Reversing the termination lifts both.
    - The person's row shows a **Banned**, **Terminated** or **Restricted** chip with the time left, and their details show whether they've seen the notice yet and their past bans and restrictions.
    - The **Moderation** card on the People tab lists every ban, termination and restriction, newest first, with what happened to each one (still in force, re-activated, lifted, ended, account deleted, and any appeal), and lets you unban, reverse or lift from there.
  - **Announcement** (on the People tab): post a message (up to 500 characters) and everyone with an account sees it at the top of their panel the next time they open it, until they close it. Posting a new one replaces it, **Take it down** hides it, and the card shows how many people have closed it.
  - Daily limits reset at midnight in your `TIMEZONE`. Dollar amounts are estimates from Anthropic's list prices. Accounts see their use of the limit as a percentage only, and a restriction that sets a different daily limit just tells them it's lower; the numbers you set stay in `/admin`.
- **Activity**: every question, newest first, with who asked, the model, the site, tokens and cost.
  - Filter by range, person, model, or kind (page text, highlight, screenshot, web search, declined, stopped, fallback), and search the questions and page addresses.
  - Click a question to see it in full: the highlighted text, the page it came from, the PDF that came with it (its name, pages and whether the file is still stored; never its contents), the steps it took on the page if it used page actions, and the answer.
  - A question can carry several small tags at once: Page, Highlight, Screenshot, a 📄 PDF name, Web, 🖱 Page actions, Fallback, Declined, Stopped, and **Removed from history**.
  - Chats someone removed from their history are marked **Removed from history**. Removing doesn't erase anything: you still see the question, the answer and the usage here.
  - Export the matching questions as CSV, up to 5,000.
- **Devices**:
  - Every signed-in device: whose it is, the browser, the address it was last used from, when it signed in, and when it was last used. Sign out one device or everyone.
  - **Login security** shows:
    - wrong logins in the last hour, by address
    - whether owner password logins are paused
    - the passcode's wrong tries
    - wrong admin tokens
  - **Clear lockouts** resets all of them.
- **Settings**:
  - **Limits per question**: max tokens per answer (any number from 256 to 100,000), how much page text gets sent, and how many web searches one question can run. Accounts can pick a shorter answer length in their own settings, but never more than this.
  - **Passcode lock**: set a 5-digit passcode and choose how long the panel can sit idle before it locks (1 minute to 1 day, or never).
    - With a passcode set, the panel shows a number pad instead of the password box.
    - Wrong passcodes count for 24 hours, even if the right one is entered in between. After 10, only the password can unlock it.
  - **Access password**: at least 8 characters. Changing it signs out every device you're logged in on. Accounts stay signed in.

What people ask (and the answers) is stored and shows up under Activity, along with the browser and address each device signs in from. The sign-up screen tells people the owner can see their questions and usage.

## Using it

- Click the bookmark to open the panel. Click it again to hide it. Esc closes it.
- The panel takes the keyboard only when you open it with the bookmark. An answer arriving, a screenshot, or a lock never pulls your typing out of the page or another tab, and closing or minimizing the panel gives the keyboard back to the page.
- **Signing in**: while sign-ups are open (or anyone has an account), the panel opens on **Sign in**. As the owner, leave the username blank and type your password. After that, on that site, the panel goes straight to your passcode (if you set one). New people choose **Create an account**, pick a username and password, and can leave a note for you. Until you accept them, they see a screen saying they're waiting to be accepted into the program, and the panel opens up by itself once you do.
- **Passcodes for everyone**: anyone with an account can set their own 5-digit passcode in ⚙ Settings (it asks for their password) and pick how long the panel can sit idle before it locks. Their panel then locks like yours, and that site shows their number pad. Wrong passcodes count for 24 hours, even if the right one is entered in between. After 10, only their password works.
- **Drag the top bar** to move the panel anywhere on the page. It remembers where you put it on each site.
- **Resize** by dragging the panel's left or top edge, or its top-left corner. The ▯ button next to minimize **docks** it to the right side as a full-height sidebar (drag its left edge to change the width); press it again to float it. Size and docking are remembered on each site.
- **Size**: the panel opens big, about half of your window (50% as wide and 80% as tall, tucked into the bottom-right corner), so there's room to read. The first time on a site that's whatever your window works out to, never narrower than 360 pixels or wider than the window, and on a phone-sized window it simply fills it. Docked, the sidebar opens about 40% as wide as the window (at least 420 pixels). Once you resize or dock it on a site, that choice wins from then on. A big panel lays itself out for the room: answers sit in a comfortable reading column (up to about 760 pixels wide, centred, with the panel's background filling the rest), the type and spacing grow with the panel's own width, the message box gets roomier, and history shows two columns of chats. Narrow, docked and small panels keep the compact layout they always had. `/chat` and the pop-up window use the whole window the same way (⚙ Settings fills the window there too, with its two panes in a centred column). The pop-up now opens at about half your screen too.
- **Minimize** (the – button) shrinks it to a small pill. A dot on the pill means an answer finished while it was minimized. Click the pill or the bookmark to open it again.
- The **+** button under the message box has everything you can add:
  - **Screenshot this tab**, or **Screenshot a region** to drag a box over just the part you mean. The panel hides itself while the shot is taken. You can also paste any image with Ctrl/Cmd+V.
  - Screenshots stay on after the first one (shown as a 📷 Screen or ⛶ Region pill): every message you send takes a new shot of the whole tab, or of the same area. Take a different kind of screenshot to switch, or click the pill to turn it off.
  - Chrome asks to share the tab the first time. Sharing then stays on, even when you close the panel, until you choose **Stop sharing this tab** in the + menu or Chrome's own Stop sharing button.
  - **Upload a PDF** (a 📄 pill with its name and page count): pick a file, or drop one anywhere on the panel (a dashed outline shows where), or paste one with Ctrl/Cmd+V. See **PDFs** just below.
  - **Page text** sends the page along. It's on for the first message of each chat (shown as a 📄 Page pill) and off after that, since the page stays in the chat history anyway.
  - **Web search** lets the model search the web (shown as a 🌐 Web pill). Answers that used it list their sources.
  - **Page actions** lets the model work on the page for you, not just read it (shown as a 🖱 Actions pill). Ask it to “fill in the contact form with my details”, “pick the 2-person table” or “click Next” and it looks at the page's buttons and fields, then does it step by step. See **Page actions** below.
  - Click a pill's × to turn that thing off.
- **PDFs** (PDFs only: anything else you drop gets a friendly “only PDFs” note, and the server checks the file's first bytes itself, not just its name):
  - Up to 10 MB and 100 pages. It uploads as soon as you pick it, with a progress count in its pill, and goes with your next message (alone, or with text, a screenshot and the page). A 📄 chip with its name and page count sits in your message.
  - Claude reads the whole PDF, text and pictures, and answers can quote it. Each quote gets a numbered marker like the page quotes do, but on a PDF, hovering or clicking a marker shows the quote and its page (“p. 3”) instead of scrolling the page you're on. That works on `/chat` too.
  - The PDF stays part of that chat: every follow-up sends it again (it's cached, so that's cheap). The pill clears after you send, since you don't need to attach it twice. A chat can hold three PDFs, 20 MB in all. Start a new chat for a different one.
  - It counts toward your daily limit on every question it goes with. Its size is counted when you upload it (by Claude's own token counter, or about 2,500 tokens a page if that isn't available), so a question the PDF makes too big is turned down up front with a note about the PDF (without its size in tokens, for accounts), before anything is asked.
  - ◆ Muse Spark can't read PDFs. Picking a PDF with it selected switches to Haiku, and the ◆ choice shows as unavailable while a chat has a PDF.
  - Files are kept for 30 days after you upload them (or a day, if you never send them with a question). After that the chat remembers the name (“no longer available”), and follow-ups carry a note instead of the file. Removing a chat from your history doesn't delete its PDF; it goes with the 30 days like the rest. The owner can see in `/admin` which questions came with a PDF (a 📄 tag in Activity, with its name and page count), but doesn't see file contents there.
  - **Storage cap and deleting**: each person (the owner too) can keep up to `PDF_STORAGE_MB` of PDFs at once, 100 MB unless you change it. Files that are already deleted or past their 30 days don't count. An upload that would go over the cap is turned down with a note saying how much you've used and to delete a PDF, and a **Manage PDFs** button right in that note. You can also open **Your PDFs** any time from the **+** menu (a small **Manage PDFs** link at the bottom) or from the footer of the chat history sheet (**Manage your PDFs**). It's a sheet like history: each PDF with its name, pages, size, upload date and the chat it's in, a bar showing how much of the cap you're using, and a **Delete** button on every row (it asks first). Deleting removes the file for good. The chats it was in keep their messages and show it as “no longer available”, and follow-ups carry a note instead of the file, just as after 30 days. Deleting one that's waiting on your message just clears its pill, and deleting while an answer is coming in doesn't spoil that answer. Settings isn't involved. You can always see and delete your own PDFs, even if PDF uploads are turned off for your account.
  - The owner can always upload PDFs. For accounts, turn **PDF uploads** on or off per person, in the defaults for new people, in bulk, or as part of a timed restriction (**Take away PDF uploads**). It's in the CSV export too. Turning it off also stops chats that already have a PDF in them: a follow-up there is turned down with a note to start a new chat (once a PDF's file is cleared after 30 days, the chat can carry on).
- The model name next to the send button picks the model: ⚡ Haiku 5.5 is fast and cheap; ✦ Sonnet 5.5 is smarter. With `OPENROUTER_API_KEY` set there's also ◆ Muse Spark 1.3, Meta's model through OpenRouter (the cheapest of the three). Its answers don't point at passages on the page.
- When a new version of pagebot is out, a panel opened from an older bookmark shows a small strip that links to the homepage, where dragging the button again updates it. The version is under ⚙ Settings → **About** and in the homepage footer.
- While an answer is coming in, the send button turns into a **stop** button. What arrived so far stays in the chat, and follow-ups can build on it.
- Scroll up while an answer is coming in and the panel stays where you are. **Jump to latest** takes you back down.
- A new chat offers one-click starters: **Summarize this page**, **Key points**, and **Explain it simply**, plus any of your own slash commands you chose to show there.
- **Slash commands**: type `/` at the start of the message box for a list of commands, and keep typing to narrow it down. ↑ ↓ pick one, Enter (or a click) runs it, Tab fills in its name so you can type more after it, and Esc closes the list without closing the panel.
  - `/summarize`, `/keypoints` and `/simple` send the same questions as the starters, and on a new chat they send the page along like the starters do. With text highlighted they're about your highlight, and with a screenshot or a PDF attached they're about that (and skip the page). Anything you type after them is added at the end, like `/summarize in three bullets`.
  - `/web` and `/page` turn web search or Page text on or off. Put a question after them (`/web who won last night?`) and they're on for just that message. They also work in front of another command, like `/page /keypoints`.
  - `/history` opens your past chats (`/history budget` searches them), `/pdf` opens the file picker to attach a PDF, and `/actions` turns page actions on or off (`/actions on`, `/actions off`, or just `/actions` to flip it). `/pdf` and `/actions` are greyed out, with the reason, where they can't work (an account without them, or `/chat` for actions).
  - `/new` starts a new chat (it also stops an answer that's still coming in), `/screenshot` and `/region` take a screenshot, `/settings` opens ⚙ Settings, and `/help` shows the whole list. Anything you type after these stays in the message box for your next message.
  - **Your own commands** live in ⚙ Settings → **Memory & commands**: give one a name, like `tldr` or `translate-es`, and the prompt it sends. Put `{input}` where the words you type after the command should go. With the prompt `Translate the highlighted text into {input}.`, typing `/translate Spanish` sends “Translate the highlighted text into Spanish.” A command with `{input}` waits until you type something after it, and says so. Without `{input}`, anything you type after the command is added at the end after a blank line.
  - Your message shows the prompt that was actually sent, with a small `/translate` tag on it. The page, your highlight and screenshots go along like with any message, and it counts toward your daily limit like any message.
  - Pick a saved command from the list in Settings to change its name or prompt, or delete it. Tick **Show on new chats** to put it next to the starters as a `/tldr` chip (up to 3); clicking a chip sends it, or fills it in if it has `{input}`.
  - Each account has its own commands, up to 50 with up to 2,000 characters each. They follow you to every site and device, and to `/chat`. Names are up to 24 lowercase letters, numbers, `-` or `_`, start with a letter, and can't be a built-in command's name.
  - The owner sees the questions your commands send in Activity, like any question; your saved commands themselves stay private to your account.
  - Things that only look like commands, like `/usr/bin` or a name you haven't saved, are sent as normal messages, and so is `/help` with words after it. To send a message that starts with a command's name, start it with two slashes: `//new` sends “/new”. Pasting text that starts with `/` doesn't open the list.
  - In `/chat` there's no page, so `/page` says it needs the bookmark, and `/summarize`, `/keypoints` and `/simple` work on a screenshot you add or text you type after them. `/screenshot` and `/region` work there like the **+** menu's screenshot items: they ask which tab or window to capture.
- Each answer has a copy button next to its details, and code blocks get their own **Copy** button when you hover them.
- The panel opens as soon as its settings load. Reopening an existing panel goes straight back to the chat while refreshing your session.
- **⚙ Settings** is organised into nine categories, so everything has a place:
  - **General**: the default model (Haiku or Sonnet, whichever your account can use), whether web search is on by default, and the longest reply, from presets between 512 and 8k tokens (anything up to 100,000 can be set in `/admin`). Accounts see those presets as Brief, Short, Standard, Long and Very long instead of token counts.
  - **Appearance**: a theme gallery with a preview of each theme's colours and a line saying what it is (Auto, Ember, Paper, Midnight, Forest, Dusk, Sakura, Terminal, Pond, Orbit, Void, Arcade, Glass, Clear); **Animations** (System, Less or Full, to override your device's reduce-motion setting; it's kept in this browser only and also calms the pixel loader and the Wrapped counters); and, when pagebot is on a page through a bookmark that can move and resize, **Panel**: dock to the side, and **Reset** to put the size and position back where they started.
  - **Memory & commands**: website memory and slash commands, as described below.
  - **Page actions**: how much pagebot asks before it clicks or types (see **Skip all permissions**), what it never does whatever you choose, and, if page actions can't be used right now, why. An old bookmark, `/chat`, or an account without page actions sees the same reason the **+** menu gives, and the choices are greyed out.
  - **Files & chats**: what's saved for you (chats, website memory, commands, PDFs), your PDF storage bar with a **Manage PDFs** button, and chat history: **Open history** and **Remove all from history** (it asks first; accounts are told the owner can still see removed chats).
  - **Privacy**: what pagebot can see on the page it's open on, one row each for page text, your highlight, screenshots, PDFs, web search and page actions, with whether each is on right now and a button that opens the **+** menu item that controls it. It never sees your other tabs. Below that, where your questions go and, for accounts, that the owner can see your chats.
  - **Account**: who you're signed in as, Lock now and Log out, change password (it signs your other devices out; there's no separate "sign out everywhere") and quick-unlock passcode with its auto-lock time. The owner sees a shorter version: the owner password and passcode are set in `/admin`.
  - **Usage**: how much of today's limit is used (accounts), your **✨ Wrapped**, and, for the owner, a link to `/admin`.
  - **About**: the version (and a strip to update an old bookmark), and a keyboard shortcuts cheat sheet (Enter and Shift+Enter, `/` for commands, Ctrl/Cmd+V to paste an image or a PDF, how Esc closes things, and the arrow keys in Settings and history).
  - On a wide panel (560 pixels or more, and `/chat`) the categories are a list on the left and the chosen one is on the right, in a column up to 600 pixels wide, under a header that stays put. On a narrow or docked panel the categories are a list that opens into the one you tap, with **‹** back to the list. Settings opens at once and remembers the category you were in until the panel reloads. Arrow keys, Home and End move through the list; Esc closes a confirmation first, then Settings. In Glass and Clear the settings page has its own backing and hides the chat behind it, like history. Theme, model, web search, answer length, page-actions mode and the rest apply everywhere you use pagebot, and each account has its own (Animations and the panel's size stay in this browser).
- **Website memory** in Settings saves instructions for a particular website, such as “Explain code with examples” or “Keep answers to three bullet points.” Open Settings on that website, write your instructions, and save them. You can also enter another website or choose a saved one to edit or delete it, including from `/chat`. Instructions apply automatically to your next question on that website, even with Page text off, and persist across visits and devices. Each account has its own memory, with up to 100 websites and 4,000 characters per website. Matching uses the exact hostname: paths and ports share instructions, while subdomains such as `www.example.com` and `docs.example.com` are separate. Memory stores only the instructions you save; it does not automatically save facts or conversations as instructions.
- **🕘 Chat history** (the clock button in the header; or `/history` where slash commands are available): every chat is saved, newest first, grouped as Today, Yesterday, Previous 7 days and Older. Each row shows the chat's name (what you asked first, or the page's title when that was a starter like “Summarize this page.”), the site, and how long ago it was. Search looks through the titles, your questions, the answers and the page titles; **Load more** (or scrolling down) shows older chats. Click a chat to reopen it and keep going: your questions show without the page text behind them, highlighted text shows as a small ✂️ quote above the question, and the answers keep their sources, their page-action steps (as read-only lines: skipped ones say so, failed ones show in red) and the PDF each question came with (a 📄 chip, greyed out once the file's 30 days are up). Quotes from a PDF keep their page markers. The "show me where" markers on a reopened answer scroll the page only when you're on the page they came from; anywhere else, hover a marker to read its quote. Reopening a chat that has a PDF keeps it in that chat, so follow-ups still send it (and ◆ Muse Spark is unavailable for it). A reopened chat starts with **Page text** off, because the page you're on now may not be the one it was about; turn it on in **+** to add this page. A very long chat shows its last 200 messages.
- **Removing a chat**: hover a chat in history and press × (it asks first), or use **Remove all from history** at the bottom of the list. It disappears from your history and can't be reopened. Nothing is erased: it still counts toward your usage and daily limit and your Wrapped, and the owner can still read it under Activity in `/admin` (accounts are told this when they remove one). If you remove a chat that's open in another tab, your next question there simply starts a new chat.
- **✨ Your pagebot Wrapped** (⚙ Settings → Usage): your year on pagebot, one card at a time — how many questions you asked, your most-asked sites, the hours you ask most, your go-to model, your favorite theme, and your longest streak of days in a row. Tap (or use ← →) to go through it. Early in a new year it shows the year before.
- **Four pixel-art themes** (inspired by dithered pixel art, ASCII and dot-matrix graphics, but all drawn from scratch with CSS and a little canvas): **Pond** is a cave pond (dark brown rock, tan light dithered in from the top right, turquoise water rising from the bottom, and the message box glints with water sparkles when you click into it); **Orbit** is a near-black field of faint + marks with a big dotted orbit behind the chat, white and blue accents, monospace for the small lettering, and a thin red/blue fringe on headings and active buttons; **Void** is a muted grey room with an isometric lattice, orange accents, a dithered orange glow in the corner, and three orange strings hanging from the top; **Arcade** is deep purple with neon pink, scanlines, a grid floor and notched corners. The textures are static CSS (nothing animates), they fade out behind the text, and every colour pair in them is checked to be easy to read (WCAG 4.5:1 or better). Like every theme they apply to bubbles, code blocks, tables, pills, menus, history, the `/` list, approval cards, PDF chips, the lock and ban screens and Wrapped, and your choice is saved to your account like the others. Settings keeps its plain background in all of them.
- **The loading screen** is a little pixel-art fox dangling from three strings over a dithered void, gently swaying and blinking, drawn in your theme's accent colour. It shows on the opening splash (with the strings coming down from the top of the panel), on the “You're on the list” screen while you wait to be accepted, and in an answer's place until its first words arrive (with a small “Thinking…”). It only moves while it's on screen (about 12 frames a second), it stops the moment it goes away, and with “reduce motion” turned on in your system it's a single still picture. In the code it's one function, `loaderSprite(canvas, options)` in `public/widget.html`: put a `<canvas>` anywhere and call it on it (`.start()`, `.stop()`, and `.retheme()` if the colours change), so moving it somewhere else is a small change.
- **Glass** is see-through: the page shows through a soft blur, and the text switches between dark and light to match the page behind it.
- **Clear** drops the panel entirely: no tint, no blur, no shadow, only the words, buttons and message box floating over the page. Text gets a thin halo so it stays readable, and switches between dark and light like Glass.
- Answers show headings, lists, tables, quotes, bold and italics. Links show which site they go to, in grey after the link text.
- With an account, Settings → **Usage** shows how much of today's limit is used, as a percentage with a bar (amber from 80%, red once it's used up; it resets at midnight), and **Account** lets you change your password and set a passcode. Accounts never see tokens or dollars: each answer's details line shows its model, any web searches and the share of today's limit that answer used (like "used 1.2% of today's limit"), and the messages and notices say "you've used today's limit" or "a lower daily limit" instead of a number. The numbers are not sent to accounts at all, so they can't be found in the network responses either. You, the owner, keep seeing tokens and cost everywhere, and `/admin` shows everything.
- **Announcements** from the owner show at the top of the panel until you press **Got it**.
- **If your account is banned**, the panel shows the ban notice instead of the chat: the reason, the owner's note, and when it ends. **Think this is wrong? Appeal it** sends the owner one appeal per ban, and their answer shows up on the same screen. A restricted account sees a note above the chat instead. A timed ban counts down; once it's over, agree to the rules to re-activate the account. A terminated account shows its notice every time you sign in, until it's deleted.
- **Highlighted text** goes with your next message. While something on the page is highlighted, a ✂️ pill shows the start of it; click its × to leave it out. Once it's been sent, it isn't sent again unless you highlight something new.
- **Show me where**: when an answer uses the page, it gets small numbered markers. Click one and the page scrolls to the passage it came from and highlights it (click anywhere on the page to clear the highlight). Hover a marker to see the quote.
- Old screenshots aren't resent on follow-ups, which saves tokens. (PDFs are resent: they're part of the chat.)
- Some sites block overlays. On those, pagebot opens in a small window instead. If your browser blocks that pop-up, click the bookmark again.
- You log in once per site, and it's remembered there. With a passcode set (yours, or an account's own), the panel locks itself after the idle time you chose, or right away with the 🔒 button.

Updating from an older version? Drag the button from the homepage to your bookmarks bar again to get smoother dragging and resizing, faster quote lookup, and lighter page requests when Page text is off. Old bookmarks still work, but only newer ones work the half-window size out from the window itself (version 11; older bookmarks still get the bigger panel, sized from your screen instead: half its width and about 72% of its height, and the docked sidebar 40% of its width, only until you resize it) and get the stricter page-action checks (version 10), resizing, docking, the ✂️ highlight pill, "show me where" quotes, and page actions (older bookmarks include highlighted text without a pill). Older ones also miss the see-through Glass on every site and the shadow-free Clear (with older ones they turn solid grey on dark-mode sites like Google's), and (for the oldest ones) moving, minimizing, and full-page region shots.

## Page actions

Turn on **Page actions** in the + menu (next to Web search) and the model can use the page for you. It only works from the bookmark on a real page: it's greyed out, with the reason, on `/chat` (there's no page there), with a bookmark older than version 9 (drag the new one from the homepage), with the OpenRouter model, and for an account the owner hasn't allowed it for. It's off until you turn it on, and it's remembered like web search.

- **What it can do**: *read the page* again (after something changed), *find elements* (a numbered list of the visible fields, dropdowns, checkboxes, buttons and links, each with its label and what's in it), *highlight* one or more passages, *scroll to* a passage or element, and *fill* a text box, *choose* an option, *tick* a checkbox or radio button, and *click* a button or link. Anything that changes the page works on the numbers from the list, so it can't wander off to something it hasn't looked at.
- **You stay in control**: reading, highlighting and scrolling show up as small step lines in the answer. Before every fill, choice, tick or click, a card in the answer says in plain words what it's about to do (“Type “Sam” into the “Name” box”) with **Allow** and **Skip**. Skip tells the model you said no, and it won't try again. **Allow all for this answer** stops the questions for the rest of that one answer. Press stop or close the panel and the answer ends right there, and the page isn't touched again.
- **Skip all permissions**: if the asking gets in the way, ⚙ Settings has a **Page actions** category with **Ask before each click or edit** (the default) and **Skip all permissions**, which works like the bypass mode in coding tools: clicks, typing and choices go ahead without a card, on every site, and your choice is saved to your account. Turning it on shows a warning first, because a web page can hide text meant to steer the model, and you confirm it. While it's on, the Actions pill shows **auto** in a warning colour.
- **Limits that never switch off**, even when you skip permissions, and enforced by the bookmarklet in the page itself, whatever the model asks for:
  - It never types into, and never reads the value of, password fields, payment card fields (card number, CVV, expiry, by field type, autocomplete hint, name, id, title, any label including `aria-labelledby`, or text drawn as dots) or file pickers. One-time codes, PINs and fields named “secret” count as passwords. The model sees that such a field exists and is told to ask you to do it yourself.
  - At most **15 steps** for one question.
  - A click that would take you to another page (a link to another address, a form that submits, a link that runs a script) still asks you first, with a note that the panel closes with the page. So does a link or form that opens a *different site* in a new tab, naming the site (without the note about closing, and with no **Allow all**). Links to a spot on the same page (#anchors), new tabs on the same site and ordinary buttons don't count. Where a form goes is read from the button's own `formaction` first, and from the form's attributes (a field called “action” or “target” can't hide it). The address you approve is the one the click is held to: if the link goes somewhere else by the time it's clicked, it asks again.
  - A button that sends you elsewhere with its own script (there's no real link or form behind it) looks like any other button from the bookmark, so it isn't asked about. That's one more reason **Skip all permissions** is only for pages you trust.
  - The approval card shows what the model asked for, the name the model saw for the control, and, when the control's own text is different (a button labelled “Cancel” by its `aria-label` that says “Pay now” on the page), what it says itself.
- **Page text is untrusted**: the model is told never to follow instructions it finds on the page, only yours.
- **Billing**: each step goes back to the model, so a question with page actions costs more than one without. Every round counts toward your daily limit, also when you stop partway, and pagebot checks what's left before each round and finishes the answer if there isn't room for another.
- **For the owner**: page actions is a permission like web search. Turn it off per person, in bulk, in the defaults for new people, or take it away for a while with **Restrict**. A waiting step times out after about 20 seconds when the page doesn't answer, or 5 minutes when the person hasn't decided. The steps an answer took are saved with it (`steps` on the answer's row) and a short summary of them goes along on follow-ups.

## Security

- **Daily limits hold**:
  - Each account gets one answer at a time.
  - An answer that's stopped partway (you press stop, close the panel, or reload the page) stops there, but what it used still counts: the whole question, the answer so far, and any web searches it ran.
  - A question that wouldn't fit in what's left of the day is turned down ("That's more than what's left of today"), and the answer length is capped to fit. Accounts are only ever told this in words and percentages, never in tokens or dollars.
- **Chat history**: you only ever see your own chats; asking for someone else's looks the same as asking for one that doesn't exist. Removing a chat hides it from your history only (the owner can still read it under Activity), and a removed chat can't be continued. Search is limited (30 a minute, one at a time per person, three seconds at most) so a long history can't slow everyone else down.
- **Logins**:
  - Each address gets 10 tries a minute and 30 wrong logins an hour, and 20 wrong admin tokens every 10 minutes.
  - After 200 wrong owner passwords in an hour from anywhere, owner password logins pause until it dies down. Devices already signed in and the passcode keep working.
  - Passwords are stored as scrypt hashes, and sessions as hashes of random tokens.
- **PDF uploads**: the upload route needs a signed-in, accepted account and is rate limited (20 a minute and 120 an hour per address). It reads the file only after that check, and only a body that starts with `%PDF-` is kept, whatever its content type says. Counting a file's pages is done in a single pass with a fixed budget for unpacking, so a file built to be slow to read can't hold up the server. Everyone only ever sees their own uploads, and a PDF can only be used in the chat it first went with. Each person's stored PDFs are capped (`PDF_STORAGE_MB`), checked and saved together under a per-person lock so quick parallel uploads can't squeeze past it, and listing or deleting your PDFs is scoped to you (someone else's id is a plain 404) and rate limited. The owner sees a PDF's name and size in Activity, never its contents.
- **The panel itself**:
  - Every page runs only its own scripts and talks only to this server.
  - Only `/widget` can be embedded in other sites.
  - Answers are shown as text with simple formatting, never as raw HTML.
  - Slash commands only run from what you type in the message box (or a list row or chip you click). Page text, highlights and answers can't run them, and no command turns a permission on (`/actions` only switches page actions on or off for you, and never touches **Skip all permissions**).
- **Page actions**: password, payment card and file fields are off limits to the model whatever the settings, a question has at most 15 steps, and clicks that leave the page (or open another site in a new tab) always ask. A step's result can only be sent back by the session that asked for it, with a random id that is only good once. See **Page actions** above.
- These counters live in memory, so restarting the server resets them, and they assume a single server instance (Railway's default).
- **Be careful on pages you don't trust**:
  - The bookmarklet runs inside the page you're on, so a malicious page could draw a fake panel to catch what you type.
  - Answers are generated from that page's text, so a page can try to steer them.
  - A page can hide text meant to steer the model. With page actions on, that is how it could try to make a click or an edit; that's why each one asks first, and why **Skip all permissions** is only for pages you trust.
  - If a site looks off, use `/chat` instead.

## Versions

pagebot's version is `VERSION` at the top of `server.js` (now 11). It's written into the bookmark people drag from the homepage. To release an update, raise it by one and deploy. Panels opened from an older bookmark then point people to the homepage to drag the new one.

Changes to the panel and the server reach everyone as soon as you deploy, whatever their bookmark. Raise the version whenever `bookmarklet.js` changes, or whenever you want everyone to get a fresh bookmark.

## Local dev

```
cp .env.example .env   # set DATABASE_URL to a local Postgres
npm ci
npm run dev
```

Node 20 or newer and PostgreSQL are required. The server creates its tables and applies additive schema updates at startup, including website memory, slash commands, chat history, PDF uploads and page actions. Set `INITIAL_PASSWORD` and a 16-character-or-longer `ADMIN_TOKEN` for local sign-in and administration. An `ANTHROPIC_API_KEY` is required for real Claude replies; `OPENROUTER_API_KEY` is optional. Keep credentials in environment variables or the ignored `.env` file.

Run `npm test` for bookmarklet regression tests (including the half-window default size). To also run the website-memory, slash-command, chat-history, PDF upload, page action, ban and combined (how those features fit together) integration tests, point `PAGEBOT_TEST_DATABASE_URL` at a disposable PostgreSQL database before running `npm test`; without it, those integration tests are explicitly skipped. They create and clean up a separate schema and use local mock model servers, so they need no AI keys or credits. Browser regression tests run with `npm run test:browser` and require Playwright and Chromium.
