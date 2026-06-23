# Nivara Privacy Policy

> **Effective date**: {{EFFECTIVE_DATE}} (to be confirmed by legal before launch)
> **Last updated**: 2026-06-23 (draft)
> **Applies to**: Nivara (development codename *Notebook Wars*; the "Game"), including the web version, iOS / Android clients, the WeChat Mini Game, and aggregator platforms such as CrazyGames.
>
> ⚠️ **This is a product/engineering draft, not final legal text.** It must be reviewed and approved by counsel before release and reconciled against each distribution channel (App Store / Google Play / WeChat / CrazyGames) and applicable regional law (GDPR / UK GDPR / PIPL / CCPA, etc.). Placeholder items (URLs, legal entity, contact email, effective date, third-party SDK list) must be replaced with real values before launch.
>
> Authoritative data inventory: [`COMPLIANCE_GLOBAL.md §3.2`](../../game/COMPLIANCE_GLOBAL.md). Data items must stay consistent across all three surfaces (this policy / the iOS Privacy Nutrition Label / the Google Play Data Safety form).

---

## 1. Introduction

{{COMPANY_LEGAL_NAME}} ("we", "us") develops and operates the Game. We respect your privacy. This Policy explains **what information we collect, how we use it, who we share it with, how long we keep it, what rights you have**, and how to contact us.

By continuing to use the Game you confirm you have read and understood this Policy. If you are located in the EU / UK, certain non-essential processing requires your **prior consent** (see §6).

---

## 2. Information we collect

We follow the principle of **data minimization** and collect only what is necessary to provide and operate the Game.

| Category | Data | Source | Required? | Purpose (see §3) |
|---|---|---|---|---|
| **Device identifier** | Device UUID (deviceId) | Auto-generated | Required | Anonymous account base, login, anti-cheat |
| **Account info** | Email / login ID, password (stored salted-hashed) | Provided when you register | Optional (not collected in anonymous/offline mode) | Registration, cloud save, cross-device sync |
| **Profile info** | Display name, avatar choice | Provided by you | Optional | Social display, match identity |
| **Transaction info** | Purchase orders, platform payment receipts/tickets, virtual currency & item balances | App store IAP / payment channels | Only when you purchase | Fulfilling purchases, fraud prevention, support |
| **Analytics events** | Game events keyed to a pseudonymous user_id (level progress, match results, click paths, etc.) | Reported automatically by the client | Non-essential (consent required in EU/UK) | Operations analytics, balancing, troubleshooting |
| **Communications** | Private chat text, report content | Sent by you | Only when you use social features | Messaging, content moderation, safety |

We **do not collect**: precise location, contacts, camera/microphone, or cross-app advertising identifiers (unless separately prompted for consent, see §6.3).

> **Note for the Mainland China version**: Under the Personal Information Protection Law (PIPL) and anti-addiction rules, the China version collects **real name + national ID number** at the identity-verification step (sensitive personal information, with separate consent). This is **minimized, encrypted, and reduced to the decision result only** (a `realNameVerified` flag + an `ageBand`), used solely for identity verification and minor anti-addiction / spending limits. See §10.

---

## 3. How we use information

- **Core services**: account login, cloud save and cross-device sync, matchmaking and online matches, campaign progress, social features (friends/chat/mail).
- **Transactions & monetization**: process purchases, grant virtual currency and items, fulfil gacha (paid random items), prevent double-charging and fraud.
- **Security & anti-cheat**: validate client data integrity (e.g., server-authoritative wallet guards), detect anomalies, ban violating accounts.
- **Operations & improvement**: analyze feature usage via pseudonymous events, tune balance, fix bugs.
- **Content moderation**: profanity filtering for display names / chat, handle reports, maintain a safe community.
- **Legal compliance**: meet regional obligations (minor protection, odds disclosure, tax/transaction-record retention).

We **do not** use your personal information for automated decisions that produce legal or similarly significant effects on you.

---

## 4. Legal bases (GDPR / UK GDPR)

For users protected by GDPR / UK GDPR, our legal bases are:

- **Performance of a contract**: account, cloud save, matches, purchases.
- **Consent**: analytics events, optional analytics cookies, any targeted advertising (see §6). You may withdraw consent at any time.
- **Legitimate interests**: anti-cheat, security, fraud prevention, and necessary operational analytics (balanced against your rights, with an opt-out).
- **Legal obligation**: minor protection, transaction/tax-record retention, odds disclosure, etc.

---

## 5. Sharing & third parties

We **do not sell** your personal information. We share only what is necessary, in the following cases:

| Recipient | Data shared | Purpose |
|---|---|---|
| **App stores / payment channels** (Apple, Google, WeChat Pay, CrazyGames, etc.) | Transaction / receipt data | Purchase fulfilment & verification |
| **Cloud / hosting providers** ({{CLOUD_PROVIDER}}) | Backend-stored account & save data | Service hosting |
| **Analytics service** (in-house analyticsvc / {{ANALYTICS_SDK}}) | Pseudonymous analytics events | Operations analytics (consent in EU/UK) |
| **Advertising SDK** ({{ADS_SDK}}, if applicable) | Minimal serving identifiers | Rewarded ads (no cross-app tracking unless ATT/consent) |
| **Aggregator platforms** (CrazyGames, etc.) | Login/session info required by the platform | Running inside the platform |
| **Regulators / law enforcement** | Information legally required | Legal obligation |

> Before launch, replace {{CLOUD_PROVIDER}} / {{ANALYTICS_SDK}} / {{ADS_SDK}} with the actual third parties and their privacy-policy links, and keep them consistent with the iOS Privacy Label and Google Play Data Safety form.

---

## 6. Your choices & consent

### 6.1 Analytics consent (EU/UK opt-in)
For EU / UK users, analytics events and non-essential analytics are **off by default** and enabled only after you explicitly accept the first-launch consent dialog. You may turn them off any time in **Settings → Privacy**; we then stop collecting new analytics events.

### 6.2 Cookies / local storage (web)
The web version uses essential local storage (localStorage) to keep your login and game state; any analytics cookies are subject to a cookie consent banner. Essential storage is required for the service and cannot be disabled.

### 6.3 Advertising & tracking
By default we **do not perform cross-app ad tracking**. If we later introduce tracking that requires App Tracking Transparency (ATT), we will request separate consent via the iOS system prompt; declining does not affect core gameplay.

---

## 7. Retention & deletion

- **Account & saves**: retained while the account exists; after you delete your account a **7-day grace period** applies (log back in to restore), after which data is asynchronously purged or anonymized.
- **Transaction records**: a minimal set is retained as legally/platform required (tax, refund disputes), and may be kept even after account deletion.
- **Analytics events**: retained for a limited operational period; deleted in bulk by pseudonymous user_id on account deletion.
- **Chat/reports**: retained for a limited period for moderation and safety.

### In-app account deletion
As required by Apple App Store 5.1.1(v) and similar rules, the Game provides an **in-app account deletion entry** in **Settings** (no email needed). Flow: Settings → Delete Account → second confirmation → server-side soft delete (`deletedAt`) → local credentials & saves cleared → recoverable by logging in within the 7-day grace period, purged thereafter.

---

## 8. Your rights

Depending on your region (GDPR / UK GDPR / PIPL / CCPA, etc.), you may have the rights to:

- **Access & export** a copy of your personal information (DSAR). Handled manually via the contact email during the test phase; self-service export at general availability.
- **Rectify** inaccurate information (e.g., display name).
- **Erase** ("right to be forgotten") — exercised via in-app account deletion (see §7).
- **Restrict / object** to certain processing where applicable.
- **Withdraw consent** for consent-based processing (analytics/ads) at any time (see §6).
- **Complain** to your local data-protection authority.

To exercise your rights, contact us via §12; we respond within statutory timeframes.

---

## 9. Children's privacy

The Game is **self-rated 13+ and is not directed to children under 13** (avoiding US COPPA / GDPR-K). We use a neutral age gate at registration/entry and do not serve child-directed targeted ads. We do not knowingly collect personal information from children under 13; if you believe we have, contact us via §12 for deletion.

> The Mainland China version identifies minors via real-name results and applies anti-addiction and spending limits (see §10); this is separate from the 13+ overseas self-rating.

---

## 10. Mainland China users (PIPL)

Applies only to the Mainland China operating version:

- **Real-name verification**: as required, you must complete real-name verification before entering the Game, collecting real name + national ID number (sensitive personal information, with separate consent). This is **encrypted, minimally retained**, and used only for identity verification and minor anti-addiction / age-banded spending limits.
- **Minor protection**: government-mandated playtime windows/limits and spending limits for minors, enforced server-authoritatively.
- **In-country storage**: personal information collected in Mainland China is in principle **stored domestically**; any cross-border transfer follows a PIPL security assessment / standard contract with separate notice and consent.
- **Data rights**: you may exercise the rights in §8; deletion scope and the legally retained minimal set (e.g., transaction records) follow law and legal guidance.

---

## 11. Data security

We apply technical and organizational measures proportionate to the risk, including transport encryption (TLS), salted password hashing, encrypted storage of sensitive data, server-authoritative validation, and access controls. No internet transmission or storage is ever fully secure, however.

---

## 12. Contact us

For any question, request, or complaint about this Policy or your personal information:

- **Privacy contact**: {{PRIVACY_CONTACT_EMAIL}}
- **Operator**: {{COMPANY_LEGAL_NAME}}, {{COMPANY_ADDRESS}}
- **EU representative / DPO** (if applicable): {{EU_REP_OR_DPO}}

---

## 13. Changes to this Policy

We may update this Policy from time to time. Material changes will be notified in-game or on the login screen, and the "Last updated" date above will change. Continued use after changes take effect constitutes acceptance.

---

> **Pre-launch placeholder checklist**: `{{EFFECTIVE_DATE}}` `{{COMPANY_LEGAL_NAME}}` `{{COMPANY_ADDRESS}}` `{{CLOUD_PROVIDER}}` `{{ANALYTICS_SDK}}` `{{ADS_SDK}}` `{{PRIVACY_CONTACT_EMAIL}}` `{{EU_REP_OR_DPO}}` and hosted URL `{{PRIVACY_POLICY_URL}}` (for the client `consent.*` link).
