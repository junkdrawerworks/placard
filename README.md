# Placard

**Use it: [placard.junkdrawer.works](https://placard.junkdrawer.works/)** (writing stickers needs Chrome on an Android phone)

**A house manual on NFC stickers: tap the sticker on the water heater, the breaker panel or the shutoff and get what it is and what to do, with no app and no sign-in.** Made for a rented house, where the person tapping isn't the owner. Tenants and repair people get plain pages that work on any phone, iPhone included. The owner edits the pages from the same site, writes and locks the stickers, prints QR backups, and gets an email when someone reports a problem.

<p align="center">
  <img src="docs/phone-home.png" width="250" alt="The house manual: emergency tiles for the water shutoff, the panel and the smoke alarms, then who to call.">
  <img src="docs/phone-heater.png" width="250" alt="A system page: where it is, what to do, and its details.">
</p>

## How it works

- **Public pages.** Anyone can read the manual. It comes from the owner's Switchboard ledger with no key, and the phone keeps a copy for next time.
- **Locked stickers.** Each sticker can be made read-only after it's checked, so nobody can rewrite it to point somewhere else. Its link goes through Switchboard, so the page can still move.
- **Reports.** A form on every page, the front page included, keeps the note in the ledger and emails the owner: at most 30 reports an hour, and 20 emails a day (past that the note is still kept, and the tenant is told to call if it's urgent). The same words from the same page again within the hour are kept but not emailed twice. Reports go to the address in the ledger sheet's About tab (B3); more than one, separated with commas, reaches the property manager too. What's typed stays on the phone until it sends, and a failed send offers a text message to the contact instead.
- **QR backups.** A printable sheet of QR codes, one per system, for phones with NFC switched off.
- **The front door.** A sticker and QR card for the whole manual (`tag.junkdrawer.works/h/house`), written and locked from Edit, for inside the front door.
- **Sample house.** Open it with `?demo` for a made-up house to try everything on.
- **Switchboard.** Records live in your Switchboard ledger (a Google Sheet you own), so they follow you between the phone and the laptop. Connect from [tag.junkdrawer.works](https://tag.junkdrawer.works/).

## Running it

It's a static site: plain HTML, CSS and JavaScript, with no build step.

```sh
npx http-server -p 8080 -c-1 .   # then open http://localhost:8080 (add ?demo for sample data)
npm test                         # unit tests, then the page in Chromium with a pretend NFC reader
node tools/make-icons.mjs        # PNG icons from icon.svg
```

GitHub Pages serves it from `main`, `/ (root)`, at its own address (`CNAME`).

### Files

- `js/app.js`: tenant pages and owner tools.
- `js/starter.js`: the usual list of systems, the sample house, and the text helpers.
- `js/config.js`: the ledger's public address, so tenants' phones can read it.
- `js/kit/`, `css/kit.css`: the tag apps' shared kit (ledger client, Web NFC, small UI helpers).
- `fonts/`: Barlow, Barlow Condensed and JetBrains Mono (SIL Open Font License), served from here so nothing loads from elsewhere.
- `test/e2e.mjs`, `test/app-checks.mjs`: the page in Chromium, offline included.

