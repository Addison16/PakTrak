# Using PakTrak offline

PakTrak keeps a copy of your collection and decks on each device, so you can look through them when the server can't be reached: on mobile data away from a home-network server, on a plane, or while the server restarts. Edits you can safely make offline wait in a queue and are sent in order when PakTrak is reachable again.

## Connection status

When something is different from normal, the header shows it next to **Menu**:

- **Offline** means PakTrak can't be reached. You're seeing copies saved on this device. A number after it counts changes waiting to send.
- **Queued · 2** means two changes are waiting and are about to be sent.
- **1 not sent** means the server turned a change down. Open it to see why.
- **Sign in to send** means your sign-in ended while changes were waiting. They stay on the device until you sign in again.

Tap it, or choose **Menu → Queued actions**, to see every waiting change. Each one shows what it does, when you made it and its state. **Remove** drops a change without sending it; **Try again** resends one the server turned down. While offline, **Check connection** tries the server right away instead of waiting for the next automatic check.

PakTrak checks the server itself rather than only the phone's internet connection, so a home server that's out of reach from mobile data counts as offline.

## What works offline

| | |
| --- | --- |
| **View** | Collection (gallery, list, card details, storage locations), decks and the batch list, once they've been opened or saved while connected |
| **Queued** | Removing copies, editing a copy's finish, condition or notes, moving copies to another location, creating or editing a storage location, saving deck changes |
| **Needs a connection** | Uploading photos, reviewing scans, card search, imports and exports, trade value, deck value and legality, price updates, account and administration settings |

A photo you take or choose while offline is kept on the device, and **Upload photo** offers to resume it once you're back.

Queued changes are sent in the order you made them. Each keeps the same request key it was made with, so a change that reached the server just before the connection dropped isn't applied twice. When two changes touch the same copy or deck, the later one is updated to follow the first. If the server turns one down, for example because the same copies were changed on another device, it stays in the list with the reason and the rest are still sent.

## What's saved on the device

- **Collection and deck data.** Everything you open while connected is saved. About once a day, when you open the collection or decks, PakTrak also saves the whole collection and every deck in the background. **Menu → Queued actions → Save collection for offline** does it right away and also saves card pictures. Up to 600 saved pages are kept per device; the oldest go first.
- **Card pictures.** Pictures you look at are kept, up to 1,000 of them (roughly 60 to 100 MB); the oldest go first. Pictures that aren't saved show as blank card frames offline.
- **The app itself**, so PakTrak opens with no connection at all.

Card pictures and opening the app with no connection need PakTrak on an **HTTPS** address (or `localhost`), because browsers only run the offline helper (a service worker) there. On a plain `http://` home-network address, saved lists and queued changes still work while PakTrak stays open, but reopening it offline or seeing pictures you haven't loaded recently won't. See [Using HTTPS](UNRAID.md#using-https) to set one up.

When PakTrak's **App address** is an `https://` one (for example behind Cloudflare or another reverse proxy), opening it at a plain `http://` address such as `http://192.168.1.50:8095` moves straight to the HTTPS address, so the camera and full offline use always work. Bookmark and add the HTTPS address to the Home Screen.

Signing out removes the saved copies, saved pictures and any queued changes from that device; PakTrak asks first if changes are still waiting. Sign-out itself needs a connection.

On iPhone and iPad, Safari may clear a site's saved data after about a week without visiting it. Adding PakTrak to the Home Screen (**Share → Add to Home Screen**) avoids that.

## For developers

Reads opt in by endpoint with `allowOfflineRead` in `apps/web/src/offline.ts`, which saves successful responses per account in IndexedDB and serves them when a request can't reach the server or the server hasn't answered in eight seconds. `addOfflineFallback` can build an answer from other saved copies. Edits opt in by calling `send` from `apps/web/src/api.ts` instead of `request`, with a label for the queue list, a `resource` key for edits that must follow each other, and an optional `preview` the screen shows until the edit is sent. Only use `send` for edits that are safe to replay later. `apps/web/src/offlineSync.ts` sends the queue; the service worker is built from `apps/web/sw/`.
