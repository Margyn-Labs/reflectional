# SPEC-SITE.md

Marketing homepage remap. **This file is the spec.** Do not implement it in the PR that adds this file.

Follow-up work is a visual rewrite of `index.html` (and CTA copy on `waitlist.html` if it still disagrees with the homepage). Drive that rewrite from this document, in order.

---

## 1) What’s wrong vs Ramp / Brex

Current `index.html` is a product demo / architecture deck. The job of the page is **waitlist**.

Ramp and Brex marketing pages do one thing: a disagreement with the status quo, a number that makes the disagreement feel expensive, and one CTA. They do not animate a fake console. They do not teach you a three-layer stack before they ask for an email.

This page does the opposite.

**It speaks Operator, not a finance team.** Title, kicker, subcopy, and footer all say the same invented job title:

> “Financial AI Operator”
> “Margyn is a Financial AI Operator for Indian digital-native businesses.”

**It stages a live Opening Bell that is not live.** The hero is a fake-browser reel (`reel-frame` / three window dots / `margyn sends this to you`) cycling Opening Bell 07:30, Cash watch, Reconciled, Closing Bell 18:00. The first card is theatre:

> “PULSE 76”
> “Pulse 76, up 4 overnight. Cash ₹42.1L, tracking fine.”

**It teaches architecture before it asks for the waitlist.** Section 02 is a three-step pipe of identical cards:

> “Three layers, in order. Each one only works if the one under it does.”
> “See everything. Understand it. Act on it.”

Then more layers: “The chat layer”, “The trust layer”, “Enhancer layer”. That is a deck, not a landing page.

**The primary CTA is a demo, not the waitlist.** Hero primary is “See it work” (`href="#what"`). Nav primary is “Get started” (`href="/app.html"`). The waitlist is a ghost button and a modal. Pulse 76 sits in the hero and again as a giant ring in `#vitals`. None of that is how Ramp/Brex sell: one argument, one number, one CTA, no fake dashboard.

The waitlist is buried. That is the bug.

---

## 2) Page-by-page remap

Map of **what is on the page today**, then kill / keep / replace. Do not invent extra current sections. Chrome (nav, cookie, footer) is listed because it is in `index.html`; it is not a marketing section in the new page.

### Current `index.html` sections

| Current | Verdict | What to do |
|---|---|---|
| **Nav** (`#nav`) | **Replace-with** | Keep the mark + “margyn”. Kill in-page demo anchors (How it works / Agents / Connections / Trust) once those sections are gone. Kill “Get started” → `/app.html`. One CTA: **Join the waitlist**, scrolls to the on-page waitlist. |
| **Hero** (`.hero`) | **Replace-with** | Kill kicker “Financial AI Operator”. Kill dual CTAs (“See it work” + “Get early access”). Kill the briefing reel entirely (Opening Bell / Closing Bell / PULSE 76 / fake browser chrome / live ticker). Replace with: disagreement → one real number → **one** CTA (Join the waitlist). Trust chips (Read-only / AA / DPDPA) may stay as a single quiet line under the CTA, not a second sell. |
| **Waitlist modal** (`#wlBackdrop`) | **Replace-with** | Kill the modal as the homepage waitlist. Move the existing fields onto the page as the last section. Same POST: `POST /api/waitlist`. Do not change waitlist backend. Button label today is “Request access”; new label is **Join the waitlist**. |
| **01 `#problem`** | **Keep** (idea) / **Replace-with** (form) | This is the only section that already sounds like Ramp. Keep the disagreement. Do not keep it as its own long section with the five-row scatter theatre. Lift the disagreement into the **hero**. Kill the scatter widget (Razorpay ₹42.1L / Shopify ₹40.6L / Zoho ₹41.0L / bank ₹37.2L / GST “no view”). |
| **02 `#what`** | **Kill** | Kill “three layers”, the pipe, the three identical `pstep` cards, the `data-ticker` loops, “Live today” / “The frontier we are building toward”. Architecture is not the page. |
| **03 `#vitals`** | **Kill** | Kill “Six vitals. One number.” Kill the six glass `vcard`s. Kill the Pulse ring and `#pulseNum` 76 in the hero *and* here. Pulse is not a credit score and is **not in the hero**. Do not rebuild a vitals dashboard. |
| **04 `#ask`** | **Kill** | Kill “The chat layer”, “You can talk to it.”, and the fake chat window (`ask-window` / typed Q&A). Not a waitlist argument. |
| **05 `#agents`** | **Replace-with** | Kill the dark-band deck, the fake iPhone, the Opening Bell / Closing Bell script, and the wrong live/coming list (page today: WhatsApp Bell **Live**, Auto-Reconciliation **Coming**). Replace with **three product cards** (see new order). Live/coming must match section 5, not the current page. |
| **06 `#connectors`** | **Keep** (names) / **Replace-with** (form) | Keep the live/coming vendor names. Kill the SVG map, animated `animateMotion` pulses, floating nodes, and “Enhancer layer” (Meta Ads / Google Ads). Replace with a **connector row**. |
| **07 `#security`** | **Replace-with** | Keep the rule, not the diagram. Kill “The trust layer”, the four-source triangle (“all four agree”), and the WhatsApp delivery stats block. Replace with the **two-source line** (exact sense below). |
| **`#cta` standing panel** | **Replace-with** | Kill “Tell us what you want to see.” / “Request access” / “Talk to us” as a second closer. The waitlist **is** the closer. |
| **Cookie bar** | **Keep** | Legal chrome. Do not restyle as a marketing section. |
| **Footer** | **Keep** (chrome) / **Replace-with** (copy) | Keep privacy / terms / email. Kill “A Financial AI Operator…”. Kill Product links to killed sections and to `/app.html`. No app/auth surface from this page. |

### `waitlist.html` (CTA only)

Do **not** rewrite this page’s form logic or `/api/waitlist`.

| Current | Verdict | What to do |
|---|---|---|
| Title / CTA **“Join the waitlist.”** | **Keep** | This is already the right button. Homepage must match it. |
| Subcopy *“We're onboarding a small group of SME founders before public launch…”* | **Replace-with** (copy only) | Same promise as the homepage waitlist section. No new fields, no new layout system, no backend change. If the homepage waitlist is on-page, `/waitlist` stays a dedicated URL with matching heading + CTA. |
| “← Back to the website” | **Keep** | |

Do not touch Tally, LinkedIn, or waitlist backend.

### NEW page order (stop after waitlist)

Nothing else. No vitals, no chat mock, no phone mock, no architecture, no second CTA band, no Pulse, no fake Opening Bell.

1. **Hero**
   - **Disagreement** (from current `#problem`, not invented): five logins, four answers to “how much cash do I have?”
   - **One real number** next to that disagreement. Not Pulse. Not the fake reel (₹42.1L, 42 payments, 76). If the team has a verified production figure (Reconciler matches, time-to-first-recon), use that. If not, use the disagreement’s own number (four answers / five sources) as the typographic figure. Do not mint a vanity metric.
   - **One CTA:** Join the waitlist (same-page `#waitlist`). No “See it work”. No “Get started”.
2. **Three cards** (not three identical rounded SaaS tiles; Reconciler is the live one and should take more weight)
   - **Reconciler** — Live
   - **Briefing** (Opening / Closing Bell) — Coming
   - **GST Guard** — Coming
3. **Two-source line** (one sentence, not a diagram): an agent acts only when two independently operated sources corroborate; else human review.
4. **Connector row** — names, not a map. Live today: Razorpay, Shopify, Zoho Books. Coming: Cashfree, RBI Account Aggregator, WooCommerce, Amazon SP-API, PayU, QuickBooks Online. Drop enhancer-layer ads.
5. **Waitlist** — on-page form. Fields already on the modal: name, email, business name, annual revenue range, marketing opt-in. POST `/api/waitlist`. Button: **Join the waitlist**.

STOP.

Collections is Coming (do not add a Collections card). Inbound WhatsApp is live; it is not a fourth card. Mention it as a line under Reconciler or under the two-source rule, not as a fake chat.

---

## 3) Visual

This is a one-page waitlist, not a design system.

**Keep (tokens already in the repo):** Fraunces (headlines; already on `waitlist.html`, missing from `index.html`), Manrope (body), IBM Plex Mono (the number, labels, Live/Coming). Canvas `#FAFAF8`, ink `#14181F`, action `#0E8F5C`.

**Do**

- Load Fraunces on `index.html`. Headlines in Fraunces; the hero number in IBM Plex Mono, large, tabular, not inside a card.
- Asymmetric type: disagreement is the biggest thing on the page; the number is a second voice, not a twin column of equal cards.
- Reconciler card is larger / left / sharper than Briefing and GST Guard. Two Coming cards can share a quieter treatment. Do not clone one card three times.
- Connector row: a line of names, maybe one live/coming rule. No hub-and-spoke SVG.
- Waitlist: form on `#FAFAF8` or white, sharp corners or one small radius (4px, already used on buttons), not a floating 16px “SaaS panel”.
- Plenty of empty canvas. Fewer boxes than today.

**Don’t**

- Inter. Purple. Gradient text sheen on the headline (current `.hero-title .accent`).
- Fake-browser dashboard mock (current `.reel-frame` topbar dots). No chat window. No iPhone. No Pulse ring. No glass vital cards.
- Three identical rounded cards in a row (current `.pstep` / `.vcard`).
- Dark full-bleed “deck” bands unless the waitlist closer truly needs contrast. Prefer paper (`#FAFAF8`) for most of the page.
- Scroll-snap one-section-per-viewport (current desktop `scroll-snap-stop: always`). Let the page be a page.
- AI-slop layout: even columns, even radii, even shadows, kicker-dot + big title + three cards + fake UI.

If a layout looks like it was generated, cut a box.

---

## 4) Motion

**CSS first. At most one small library.**

Current page already has CSS `@keyframes`, `.reveal` + IntersectionObserver, and `prefers-reduced-motion`. Keep that idea. Delete the theatrical loops: hero reel autoplay, ticker `data-ticker`, Pulse count-up, WhatsApp typing, SVG `animateMotion` pulses, `scroll-snap`.

### Follow-up implementation: add this one package

| Use | npm | GitHub |
|---|---|---|
| Hero number + scroll in-view (vanilla JS, this repo is HTML not React) | `motion` | https://github.com/motiondivision/motion |

```bash
npm install motion
```

Import from `motion` (vanilla): `inView`, `animate`, and `scroll` if a single scroll-linked fade is needed. Do not import `motion/react`.

**Do not add:** `gsap` / ScrollTrigger, `lottie-web`, `tsparticles`, `particles.js`, `typed.js`, a live ticker, or a second animation library. GSAP is free now (https://github.com/greensock/GSAP, npm `gsap`) and is the wrong weight for this page.

### Hero treatment

- CSS: headline settles (opacity/transform, 200–400ms). Number can count once on first in-view via `motion` **only if** `prefers-reduced-motion` is false.
- No particles. No Lottie. No fake live ticker. No auto-advancing briefing reel. No looping sheen.

### Scroll

- One pattern: elements fade/translate once when they enter. CSS is enough; `motion` `inView` is allowed so you do not re-invent observers.
- No pin, no scrubbed timeline, no section snap.

### `prefers-reduced-motion: reduce`

- No count-up (set the number in full).
- No transform travel; opacity only or instant.
- No infinite loops (current kicker `beat`, reel `uvFloat`, ticker).
- Existing reduce-motion block in `index.html` is the right shape; keep it and make sure new `motion` calls check it.

---

## 5) Copy rules (bind the follow-up)

- We are an **AI finance team**, not Operator. Ban “Financial AI Operator” from title, kicker, subcopy, footer, meta description.
- No em dashes.
- Do not say **dashboard**.
- Pulse is not a credit score and is **not in the hero**. Do not show 76.
- Opening Bell, Closing Bell, Collections, GST Guard: **Coming**.
- Reconciler + inbound WhatsApp: **live**.
- Not an FIU, not a PA, not a lender. Do not imply licence, credit scoring, or lending. (Current Pulse card already says no CIC / not for a lender; keep that discipline, without putting Pulse in the hero.)
- **Waitlist is the job of the page.** Every section either earns the waitlist or it is cut.
- Live/coming on the page today is wrong. Do not copy it. Do not present Opening Bell as live.

Suggested CTA label, used once: **Join the waitlist.**

---

## 6) Out of scope

Do not touch:

- `app.html` or any app / auth surface
- LinkedIn
- Tally
- Pulse calculator
- Waitlist backend (`waitlist.js`, `/api/waitlist` handlers, database)
- Connector OAuth / WhatsApp agent / Reconciler implementation

This spec is homepage marketing only.

---

## Follow-up build order (for Claude Code Desktop)

Not this PR.

1. Add npm package `motion` (https://github.com/motiondivision/motion). No other new libraries.
2. Rewrite `index.html` to the five-block order in section 2. Delete killed sections and their CSS/JS (reel, pulse ring, chat mock, phone mock, connector SVG, tickers, scroll-snap).
3. Remap nav + footer CTAs to the on-page waitlist. Remove `/app.html` from this page.
4. Align `waitlist.html` heading/subcopy/CTA with the homepage waitlist section. Do not change the form POST.
5. Optional: extract a small `site.css` / `site.js` if `index.html` should not stay a single 1.5k-line file. Not required.
6. Respect copy rules and `prefers-reduced-motion`. SQL: none.
