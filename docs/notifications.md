# Discord notifications

Caddy UI can post to a Discord channel when something needs your attention. Messages are sent
by the server, so they arrive with no browser open. Everything is set up in **Settings →
Notifications**.

## Setting it up

1. In Discord, open the channel's settings, then **Integrations → Webhooks → New Webhook**.
   Name it (for example "Caddy UI"), pick an avatar if you like, and press **Copy Webhook
   URL**.
2. In Caddy UI, open **Settings → Notifications**, paste the URL into **Discord webhook** and
   press **Save webhook**.
3. Open any event's **Edit message** and press **Send test**. A message marked "Test message
   with sample values" appears in the channel.
4. Optional: set **Public address** under Settings → Display (`CADDY_UI_PUBLIC_URL`), so each
   message gets a button that opens the right page in the UI.

The webhook URL works like a password for the channel: anyone who has it can post there. Once
saved it is never shown again, not in the page, the API or the settings log (which records only
the webhook's number). It is stored in the UI's database (`CADDY_UI_DATA`) and left out of
exports unless you ask for it. To replace it, paste a new one; **Remove** stops all messages.

## Events

| Event | When | On by default |
| --- | --- | --- |
| Site down | The site failed the set number of probe cycles in a row (default 2) | Yes |
| Site back up | A site that was reported down answers again; says how long it was down | Yes |
| Upstream down | An upstream failed the set number of cycles; names the sites that use it | No |
| Upstream back up | An upstream that was reported down answers again | No |
| Certificate expiring | A certificate of a site in the Caddyfile enters the warning window (`CADDY_UI_CERT_WARN_DAYS`, 14 days by default), and again at 3 days | Yes |
| Caddyfile changed outside the UI | The file changed on disk without the UI (also while the UI was stopped); names the History revision | Yes |
| Update applied | The UI starts on a newer version than last time | Yes |
| Update rolled back | The UI starts on an older version than last time | Yes |

Upstream events are off by default because a down upstream usually takes its site down too,
which is already announced. Each event has its own switch.

**Down after** sets how many failed probe cycles in a row count as down (1 to 20). One cycle is
the probe interval (Settings → Monitoring); the probe already retries once within a cycle.
**At most one message per site every N minutes** (default 5, 0 turns it off) keeps a flapping
site from flooding the channel. A change held back by it is sent when the minutes are up if it
still holds, so the channel's last word is always right.

After a restart the UI remembers which sites were down, so it does not repeat "down" and still
says when they come back.

## Messages

Each event has a default message: a Discord Components v2 container with an accent colour (red
for down, green for up, amber for a warning), a heading, a short text, the time, and a link
button. **Edit message** changes, per event:

- **Heading** and **Text**, with placeholders such as `{site}` (click one to put it at the
  cursor) and Discord markdown (`**bold**`, `*italic*`, `` `code` ``, `[link](https://…)`).
- **Accent colour**.
- **Mention**: `<@&role id>`, `<@user id>`, `@here` or `@everyone`. Only this one mention can
  ping; a mention inside a value (an error text, say) never does. With Developer Mode on in
  Discord, right-click a role or user to copy its id.
- **Link button to this UI**, which needs a public address.

The preview beside the form shows the message with sample values, exactly as it is built for
sending. **Send test** posts it (also before saving, and also to a webhook URL typed but not
saved yet). **Reset to default** brings the default back; an event you never edited follows the
default when a later version improves it.

### Placeholders

| Placeholder | Events | Value |
| --- | --- | --- |
| `{site}` | site, upstream, certificate | The site's addresses (for an upstream, the sites that use it; for a certificate, its host) |
| `{status}` | site | `HTTP 502`, `no answer`, … |
| `{error}` | site down, upstream down | The probe's error |
| `{since}` | site, upstream | When it went down |
| `{duration}` | back up | How long it was down, such as `14m` |
| `{upstream}` | upstream | The upstream's address |
| `{days_left}`, `{expires_in}`, `{expires}`, `{issuer}` | certificate | Days left, "9 days", the expiry time, the issuer |
| `{revision}` | Caddyfile changed | The History revision, such as `#128` |
| `{version}`, `{previous_version}` | update | The version now running, and the one before |
| `{time}` | all | When it happened |
| `{url}` | all | The page in the UI (empty without a public address) |

Times are Discord timestamps, so every reader sees them in their own time zone. Values are
escaped, so a site called `*.example.com` shows as written.

### Raw JSON

**Edit the raw JSON** switches an event to a JSON array of Components v2 components, for layouts
the fields cannot make. It starts from the field layout. A webhook that no app owns may send only
non-interactive components, so the editor accepts: container (17), text display (10), section
(9), separator (14), thumbnail (11), media gallery (12), and action rows (1) of link buttons (2,
style 5). It checks at most 38 components and 3,800 characters of text (Discord allows 40 and
4,000; the mention and the test line take the rest). Placeholders work in any text or URL. A link
button whose URL is empty after filling in (no public address) is left out. Turning the switch
off goes back to the fields, which are kept.

## Delivery

Messages are posted to the webhook with `?with_components=true` and the Components v2 flag, one
at a time. A rate limit from Discord is waited out (up to a minute); a network error or a 5xx
answer is tried again three times over about 13 seconds. A failure never holds up probing.

If the webhook refuses a Components v2 message, the same message is sent as a classic embed
(heading as the title, text, colour, link and mention), and later messages go as embeds straight
away. Settings says so, with **Try Components v2 again**.

**Recently sent** lists the last messages with what Discord answered. A failure is also written
to the container's log (`docker compose logs caddy-ui`). A webhook that was deleted answers
"Unknown Webhook": paste a new one.

## For testing

`CADDY_UI_DISCORD_API_URL` (default `https://discord.com/api/v10`) is where messages are posted.
Only the test suites change it, to point the UI at a fake Discord
(`apps/ui/src/lib/server/notify/fake-discord.ts`); no test posts to the real one.
