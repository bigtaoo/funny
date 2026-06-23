# Nivara Datenschutzerklärung

> **Datum des Inkrafttretens**: {{EFFECTIVE_DATE}} (vor Veröffentlichung rechtlich zu bestätigen)
> **Zuletzt aktualisiert**: 23.06.2026 (Entwurf)
> **Gilt für**: Nivara (Entwicklungs-Codename *Notebook Wars*; das „Spiel"), einschließlich Webversion, iOS-/Android-Clients, WeChat-Mini-Game sowie Aggregator-Plattformen wie CrazyGames.
>
> ⚠️ **Dies ist ein Produkt-/Engineering-Entwurf, kein endgültiger Rechtstext.** Er ist vor der Veröffentlichung von Rechtsbeiständen zu prüfen und freizugeben sowie mit jedem Vertriebskanal (App Store / Google Play / WeChat / CrazyGames) und dem anwendbaren regionalen Recht (DSGVO / UK GDPR / PIPL / CCPA usw.) abzugleichen. Platzhalter (URLs, juristische Einheit, Kontakt-E-Mail, Datum, Liste der Drittanbieter-SDKs) sind vor dem Start durch echte Werte zu ersetzen.
>
> Maßgebliches Datenverzeichnis: [`COMPLIANCE_GLOBAL.md §3.2`](../../game/COMPLIANCE_GLOBAL.md). Die Datenkategorien müssen über alle drei Stellen hinweg konsistent sein (diese Erklärung / iOS Privacy Nutrition Label / Google Play Data Safety Form).

---

## 1. Einleitung

{{COMPANY_LEGAL_NAME}} („wir", „uns") entwickelt und betreibt das Spiel. Wir achten Ihre Privatsphäre. Diese Erklärung beschreibt, **welche Daten wir erheben, wie wir sie verwenden, mit wem wir sie teilen, wie lange wir sie speichern, welche Rechte Sie haben** und wie Sie uns kontaktieren.

Mit der weiteren Nutzung des Spiels bestätigen Sie, diese Erklärung gelesen und verstanden zu haben. Befinden Sie sich in der EU / im UK, erfordern bestimmte nicht notwendige Verarbeitungen Ihre **vorherige Einwilligung** (siehe §6).

---

## 2. Welche Daten wir erheben

Wir folgen dem Grundsatz der **Datenminimierung** und erheben nur, was zur Bereitstellung und zum Betrieb des Spiels erforderlich ist.

| Kategorie | Daten | Quelle | Erforderlich? | Zweck (siehe §3) |
|---|---|---|---|---|
| **Gerätekennung** | Geräte-UUID (deviceId) | automatisch erzeugt | Erforderlich | anonyme Kontobasis, Login, Betrugsabwehr |
| **Kontodaten** | E-Mail / Login-ID, Passwort (gesalzen gehasht gespeichert) | bei Registrierung angegeben | Optional (im anonymen/Offline-Modus nicht erhoben) | Registrierung, Cloud-Speicherung, geräteübergreifende Synchronisation |
| **Profildaten** | Anzeigename, Avatar-Auswahl | von Ihnen angegeben | Optional | soziale Anzeige, Match-Identität |
| **Transaktionsdaten** | Kaufaufträge, Plattform-Zahlungsbelege/-Tickets, Guthaben an virtueller Währung & Gegenständen | App-Store-IAP / Zahlungskanäle | nur bei Kauf | Kaufabwicklung, Betrugsabwehr, Support |
| **Analyse-Ereignisse** | Spielereignisse, einer pseudonymen user_id zugeordnet (Levelfortschritt, Match-Ergebnisse, Klickpfade usw.) | automatisch vom Client gemeldet | nicht notwendig (in EU/UK Einwilligung erforderlich) | Betriebsanalyse, Balancing, Fehlerbehebung |
| **Kommunikation** | Privatchat-Texte, Meldeinhalte | von Ihnen gesendet | nur bei Nutzung sozialer Funktionen | Nachrichten, Moderation, Sicherheit |

Wir erheben **nicht**: präzise Standortdaten, Kontakte, Kamera/Mikrofon oder app-übergreifende Werbe-IDs (sofern nicht gesondert um Einwilligung gebeten, siehe §6.3).

> **Hinweis zur Version für Festlandchina**: Nach dem PIPL und den Anti-Sucht-Regeln erhebt die China-Version bei der Identitätsprüfung **echten Namen + Personalausweisnummer** (sensible personenbezogene Daten, mit gesonderter Einwilligung). Diese Daten werden **minimiert, verschlüsselt und auf das Ergebnis reduziert** (Kennzeichen `realNameVerified` + `ageBand`) und ausschließlich für Identitätsprüfung sowie Minderjährigen-Suchtprävention / Ausgabenlimits verwendet. Siehe §10.

---

## 3. Wie wir Daten verwenden

- **Kernfunktionen**: Konto-Login, Cloud-Speicherung und geräteübergreifende Synchronisation, Matchmaking und Online-Matches, Kampagnenfortschritt, soziale Funktionen (Freunde/Chat/Post).
- **Transaktionen & Monetarisierung**: Käufe abwickeln, virtuelle Währung und Gegenstände gewähren, Gacha (kostenpflichtige Zufallsgegenstände) erfüllen, Doppelbelastungen und Betrug verhindern.
- **Sicherheit & Betrugsabwehr**: Integrität von Client-Daten prüfen (z. B. serverautoritative Wallet-Prüfungen), Anomalien erkennen, verstoßende Konten sperren.
- **Betrieb & Verbesserung**: Funktionsnutzung über pseudonyme Ereignisse analysieren, Balancing optimieren, Fehler beheben.
- **Inhaltsmoderation**: Filterung anstößiger Begriffe in Anzeigenamen / Chat, Bearbeitung von Meldungen, sichere Community.
- **Rechtliche Compliance**: regionale Pflichten erfüllen (Minderjährigenschutz, Wahrscheinlichkeitsoffenlegung, Aufbewahrung von Steuer-/Transaktionsdaten).

Wir verwenden Ihre personenbezogenen Daten **nicht** für automatisierte Entscheidungen mit rechtlicher oder ähnlich erheblicher Wirkung.

---

## 4. Rechtsgrundlagen (DSGVO / UK GDPR)

Für nach DSGVO / UK GDPR geschützte Nutzer sind unsere Rechtsgrundlagen:

- **Vertragserfüllung**: Konto, Cloud-Speicherung, Matches, Käufe.
- **Einwilligung**: Analyse-Ereignisse, optionale Analyse-Cookies, jegliche zielgerichtete Werbung (siehe §6). Sie können die Einwilligung jederzeit widerrufen.
- **Berechtigte Interessen**: Betrugs- und Cheat-Abwehr, Sicherheit, erforderliche Betriebsanalyse (gegen Ihre Rechte abgewogen, mit Opt-out).
- **Rechtliche Verpflichtung**: Minderjährigenschutz, Aufbewahrung von Transaktions-/Steuerdaten, Wahrscheinlichkeitsoffenlegung usw.

---

## 5. Weitergabe & Dritte

Wir **verkaufen** Ihre personenbezogenen Daten **nicht**. Wir teilen nur das Notwendige, in folgenden Fällen:

| Empfänger | Geteilte Daten | Zweck |
|---|---|---|
| **App-Stores / Zahlungskanäle** (Apple, Google, WeChat Pay, CrazyGames usw.) | Transaktions-/Belegdaten | Kaufabwicklung & Verifizierung |
| **Cloud-/Hosting-Anbieter** ({{CLOUD_PROVIDER}}) | im Backend gespeicherte Konto- & Speicherdaten | Service-Hosting |
| **Analysedienst** (eigener analyticsvc / {{ANALYTICS_SDK}}) | pseudonyme Analyse-Ereignisse | Betriebsanalyse (in EU/UK mit Einwilligung) |
| **Werbe-SDK** ({{ADS_SDK}}, falls zutreffend) | minimale Auslieferungs-IDs | belohnte Werbung (kein app-übergreifendes Tracking ohne ATT/Einwilligung) |
| **Aggregator-Plattformen** (CrazyGames usw.) | von der Plattform geforderte Login-/Sitzungsdaten | Betrieb innerhalb der Plattform |
| **Behörden / Strafverfolgung** | gesetzlich geforderte Daten | rechtliche Verpflichtung |

> Vor dem Start sind {{CLOUD_PROVIDER}} / {{ANALYTICS_SDK}} / {{ADS_SDK}} durch die tatsächlichen Dritten und deren Datenschutzlinks zu ersetzen, konsistent mit iOS Privacy Label und Google Play Data Safety Form.

---

## 6. Ihre Wahlmöglichkeiten & Einwilligung

### 6.1 Analyse-Einwilligung (EU/UK Opt-in)
Für EU-/UK-Nutzer sind Analyse-Ereignisse und nicht notwendige Analysen **standardmäßig deaktiviert** und werden erst aktiviert, nachdem Sie dem Einwilligungsdialog beim ersten Start ausdrücklich zugestimmt haben. Sie können sie jederzeit unter **Einstellungen → Datenschutz** deaktivieren; wir erheben dann keine neuen Analyse-Ereignisse mehr.

### 6.2 Cookies / lokaler Speicher (Web)
Die Webversion nutzt notwendigen lokalen Speicher (localStorage), um Login und Spielstand zu halten; etwaige Analyse-Cookies unterliegen einem Cookie-Einwilligungsbanner. Notwendiger Speicher ist für den Dienst erforderlich und nicht deaktivierbar.

### 6.3 Werbung & Tracking
Standardmäßig führen wir **kein app-übergreifendes Werbe-Tracking** durch. Sollten wir künftig Tracking einführen, das App Tracking Transparency (ATT) erfordert, holen wir die Einwilligung gesondert über den iOS-Systemdialog ein; eine Ablehnung beeinträchtigt das Kern-Gameplay nicht.

---

## 7. Aufbewahrung & Löschung

- **Konto & Spielstände**: gespeichert, solange das Konto besteht; nach Kontolöschung gilt eine **7-tägige Karenzfrist** (Wiederherstellung durch erneutes Anmelden), danach asynchrone Löschung oder Anonymisierung.
- **Transaktionsdaten**: ein minimaler Satz wird gesetzlich/plattformbedingt aufbewahrt (Steuern, Erstattungsstreitigkeiten) und kann auch nach Kontolöschung bestehen bleiben.
- **Analyse-Ereignisse**: für einen begrenzten Betriebszeitraum gespeichert; bei Kontolöschung per pseudonymer user_id gebündelt gelöscht.
- **Chat/Meldungen**: für einen begrenzten Zeitraum zu Moderations- und Sicherheitszwecken gespeichert.

### In-App-Kontolöschung
Wie von Apple App Store 5.1.1(v) und vergleichbaren Regeln gefordert, bietet das Spiel einen **In-App-Eintrag zur Kontolöschung** in den **Einstellungen** (ohne E-Mail). Ablauf: Einstellungen → Konto löschen → zweite Bestätigung → serverseitige Soft-Löschung (`deletedAt`) → lokale Zugangsdaten & Spielstände gelöscht → innerhalb der 7-tägigen Karenzfrist durch Anmelden wiederherstellbar, danach gelöscht.

---

## 8. Ihre Rechte

Je nach Region (DSGVO / UK GDPR / PIPL / CCPA usw.) können Sie folgende Rechte haben:

- **Auskunft & Datenübertragbarkeit**: eine Kopie Ihrer personenbezogenen Daten (DSAR). In der Testphase manuell über die Kontakt-E-Mail; Self-Service-Export zur allgemeinen Verfügbarkeit.
- **Berichtigung** unrichtiger Daten (z. B. Anzeigename).
- **Löschung** („Recht auf Vergessenwerden") — über die In-App-Kontolöschung (siehe §7).
- **Einschränkung / Widerspruch** gegen bestimmte Verarbeitungen, soweit anwendbar.
- **Widerruf der Einwilligung** für einwilligungsbasierte Verarbeitung (Analyse/Werbung) jederzeit (siehe §6).
- **Beschwerde** bei Ihrer lokalen Datenschutzaufsichtsbehörde.

Zur Ausübung Ihrer Rechte kontaktieren Sie uns über §12; wir antworten innerhalb der gesetzlichen Fristen.

---

## 9. Datenschutz für Kinder

Das Spiel ist **selbsteingestuft als 13+ und richtet sich nicht an Kinder unter 13 Jahren** (Vermeidung von US-COPPA / DSGVO-K). Wir setzen bei Registrierung/Eintritt eine neutrale Altersabfrage ein und schalten keine kindgerichtete zielgerichtete Werbung. Wir erheben wissentlich keine personenbezogenen Daten von Kindern unter 13; falls Sie dies vermuten, kontaktieren Sie uns über §12 zur Löschung.

> Die Festlandchina-Version identifiziert Minderjährige anhand der Identitätsprüfung und wendet Suchtprävention und Ausgabenlimits an (siehe §10); dies ist von der 13+-Selbsteinstufung im Ausland getrennt.

---

## 10. Nutzer in Festlandchina (PIPL)

Gilt nur für die in Festlandchina betriebene Version:

- **Identitätsprüfung**: vor Spielbeginn ist eine Identitätsprüfung erforderlich, mit Erhebung von echtem Namen + Personalausweisnummer (sensible personenbezogene Daten, gesonderte Einwilligung). Diese Daten werden **verschlüsselt, minimal aufbewahrt** und ausschließlich für Identitätsprüfung sowie Minderjährigen-Suchtprävention / altersgestaffelte Ausgabenlimits verwendet.
- **Minderjährigenschutz**: behördlich vorgeschriebene Spielzeitfenster/-limits und Ausgabenlimits für Minderjährige, serverautoritativ durchgesetzt.
- **Speicherung im Inland**: in Festlandchina erhobene personenbezogene Daten werden grundsätzlich **im Inland gespeichert**; eine grenzüberschreitende Übermittlung folgt einer PIPL-Sicherheitsbewertung / Standardvertrag mit gesonderter Information und Einwilligung.
- **Datenrechte**: Sie können die Rechte aus §8 ausüben; Löschumfang und der gesetzlich aufzubewahrende Mindestsatz (z. B. Transaktionsdaten) richten sich nach Recht und rechtlicher Beratung.

---

## 11. Datensicherheit

Wir treffen dem Risiko angemessene technische und organisatorische Maßnahmen, darunter Transportverschlüsselung (TLS), gesalzenes Passwort-Hashing, verschlüsselte Speicherung sensibler Daten, serverautoritative Validierung und Zugriffskontrollen. Keine Internetübertragung oder Speicherung ist jedoch absolut sicher.

---

## 12. Kontakt

Bei Fragen, Anliegen oder Beschwerden zu dieser Erklärung oder Ihren personenbezogenen Daten:

- **Datenschutzkontakt**: {{PRIVACY_CONTACT_EMAIL}}
- **Betreiber**: {{COMPANY_LEGAL_NAME}}, {{COMPANY_ADDRESS}}
- **EU-Vertreter / DSB** (falls zutreffend): {{EU_REP_OR_DPO}}

---

## 13. Änderungen dieser Erklärung

Wir können diese Erklärung von Zeit zu Zeit aktualisieren. Über wesentliche Änderungen informieren wir im Spiel oder auf dem Login-Bildschirm; das Datum „Zuletzt aktualisiert" oben ändert sich entsprechend. Die fortgesetzte Nutzung nach Inkrafttreten gilt als Annahme.

---

> **Platzhalter-Checkliste vor dem Start**: `{{EFFECTIVE_DATE}}` `{{COMPANY_LEGAL_NAME}}` `{{COMPANY_ADDRESS}}` `{{CLOUD_PROVIDER}}` `{{ANALYTICS_SDK}}` `{{ADS_SDK}}` `{{PRIVACY_CONTACT_EMAIL}}` `{{EU_REP_OR_DPO}}` und gehostete URL `{{PRIVACY_POLICY_URL}}` (für den Client-`consent.*`-Link).
