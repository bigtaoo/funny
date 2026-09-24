// Analytics page (OPS_DESIGN §7): monitoring overview + DAU/retention/region/OS/login-hour/funnel/event-count.
//
// DOM assembly only — every pivot, share and "does this section have data" test lives in
// src/logic/analytics.ts (ADR-070 Phase 4e). The five `*_dist` sections used to be five verbatim
// copies of the same table-building block; they are now five calls to `distributionCard` over
// `distribution()`, which is what pulling the arithmetic out made visible.
import { clear, h, pill } from '../dom';
import {
  analyticsUnavailable, barRatio, bootFunnelRows, churnSceneRows,
  distribution, eventCountGrid, funnelPivot, funnelPlatforms, levelFunnelRows,
  loadTimeRows, loginHourRows, metricRows, ONBOARDING_LABELS,
  retentionCell, RETENTION_BY_DIMENSION_LABELS, RETENTION_OFFSETS, retentionRows, sectionRows,
  sectionValue, type ShareRow, stepFunnelRows, TUTORIAL_LABELS,
} from '../logic/analytics';
import { pct } from '../logic/shared';
import {
  bar, badgeDistCards, featureGuideCard, launchFunnelCard, levelFunnelCard, loadTimeCard,
  sessionDurationCard, shareCard, stepFunnelCard,
} from './analyticsCards';
import { showErr, sparkline, type Ctx } from './shared';

export async function pageAnalytics(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(h('h2', {}, 'Analytics'));
  const err = h('div', { class: 'err' });
  const body = h('div', {});
  const daysSel = h('select', { style: 'margin-left:8px' },
    h('option', { value: '1' }, 'Today'),
    h('option', { value: '7', selected: 'selected' }, 'Last 7 days'),
    h('option', { value: '30' }, 'Last 30 days'),
  ) as HTMLSelectElement;
  const refreshBtn = h('button', { class: 'ghost' }, 'Refresh');

  root.append(
    h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Time range'), daysSel, refreshBtn),
    body,
    err,
  );

  const reload = async (): Promise<void> => {
    err.textContent = '';
    clear(body);
    const days = Number(daysSel.value);

    const DEFAULT_RETENTION_BY_DIMENSION = RETENTION_BY_DIMENSION_LABELS[0]!.value;
    const [
      summary, evCounts, dau, funnel, regions, osDist, loginHour, retention, firstSession,
      levelFunnel, tutorialFunnel, sceneFunnel, featureGuideFunnel, browserDist, deviceTypeDist, webviewDist, geoDist, badgeDist,
      bootFunnel, loadTime, retentionBy, sessionDuration, churnScene,
    ] = await Promise.allSettled([
      api.analyticsSummary(),
      api.analyticsEvents('event_counts', days),
      api.analyticsEvents('dau', days),
      api.analyticsEvents('funnel', days),
      api.analyticsEvents('region_dist', days),
      api.analyticsEvents('os_dist', days),
      api.analyticsEvents('login_hour', days),
      api.analyticsEvents('retention', days),
      api.analyticsEvents('first_session', days),
      api.analyticsEvents('level_funnel', days),
      api.analyticsEvents('tutorial_funnel', days),
      api.analyticsEvents('scene_funnel', days),
      api.analyticsEvents('feature_guide_funnel', days),
      api.analyticsEvents('browser_dist', days),
      api.analyticsEvents('device_type_dist', days),
      api.analyticsEvents('webview_dist', days),
      api.analyticsEvents('geo_dist', days),
      api.analyticsEvents('badge_dist', days),
      api.analyticsEvents('boot_funnel', days),
      api.analyticsEvents('load_time', days),
      api.analyticsEvents('retention_by', days, undefined, undefined, DEFAULT_RETENTION_BY_DIMENSION),
      api.analyticsEvents('session_duration_dist', days),
      api.analyticsEvents('churn_scene_dist', days),
    ]);

    // Monitoring overview (self-collected metrics + tickets)
    if (summary.status === 'fulfilled') {
      const s = summary.value;
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Metric'), h('th', {}, '24h avg'), h('th', {}, '24h peak'), h('th', {}, 'Samples')));
      for (const m of metricRows(s.last24h)) {
        t.append(h('tr', {}, h('td', {}, m.key), h('td', {}, m.avg), h('td', {}, String(m.peak)), h('td', {}, String(m.samples))));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Self-collected metrics (last 24h)'), t));

      const tk = h('table', {}, h('tr', {}, h('th', {}, 'Ticket status'), h('th', {}, 'Count')));
      for (const [k, v] of Object.entries(s.tickets)) {
        tk.append(h('tr', {}, h('td', {}, pill(k, k)), h('td', {}, String(v))));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Compensation tickets overview'), tk));
    }

    // Analytics service unavailable notice (shown at most once)
    if (analyticsUnavailable(evCounts)) {
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Analytics service not configured (NW_ANALYTICS_BASE_URL)')));
      return;
    }

    // Launch funnel, load time and session-length cards: see analyticsCards.ts for the "why" behind
    // each (ANALYTICS_DESIGN §3.6b/§5.1b, RETENTION_LAUNCH_PLAN.md §2).
    const launches = bootFunnelRows(sectionRows(bootFunnel, (v) => v.boot_funnel));
    const launchCard = launchFunnelCard(launches, days);
    if (launchCard) body.append(launchCard);

    const loads = loadTimeRows(sectionRows(loadTime, (v) => v.load_time));
    const loadCard = loadTimeCard(loads, days);
    if (loadCard) body.append(loadCard);

    const durations = sectionRows(sessionDuration, (v) => v.session_duration_dist);
    const durationCard = sessionDurationCard(durations, days);
    if (durationCard) body.append(durationCard);

    // Churn last-scene distribution (RETENTION_LAUNCH_PLAN.md §2 supplementary query): where sessions
    // actually end. Counts churn_signal EVENTS, not devices — a scene can appear any number of times.
    const churnRows = churnSceneRows(sectionRows(churnScene, (v) => v.churn_scene_dist));
    if (churnRows.length) {
      body.append(shareCard(`Where sessions end (churn_signal, last ${days} days)`, 'Scene', 'Events', churnRows));
    }

    // DAU trend
    const dauPts = sectionRows(dau, (v) => v.dau);
    if (dauPts.length) {
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'DAU (daily active devices)')));
      for (const p of dauPts) t.append(h('tr', {}, h('td', {}, p.date), h('td', { style: 'text-align:right' }, String(p.dau))));
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `DAU trend (last ${days} days)`), sparkline(dauPts.map((p) => p.dau)), t));
    }

    // D1–D7 retention (RETENTION_LAUNCH_PLAN.md §1.2/§1.3: platform + new-user-cohort filters).
    // Own scoped fetch/re-render on filter change — re-running the whole page's Promise.allSettled
    // batch for a retention-only filter tweak would needlessly re-query every other card too.
    // Filters reset to "All platforms" / unchecked on every Refresh / days change (not persisted
    // across `reload()`), an intentional simplification for an internal ops tool.
    {
      const initialCohorts = retentionRows(sectionRows(retention, (v) => v.retention));
      const platformSel = h('select', {},
        h('option', { value: '' }, 'All platforms'),
        h('option', { value: 'web' }, 'web'),
        h('option', { value: 'wechat' }, 'wechat'),
        h('option', { value: 'crazygames' }, 'crazygames'),
      ) as HTMLSelectElement;
      const newCohortChk = h('input', { type: 'checkbox' }) as HTMLInputElement;
      const tableHost = h('div', {});
      const card = h('div', { class: 'card' },
        h('div', { class: 'muted' }, `Retention cohorts (last ${days} days, D1–D7 return, — = insufficient data)`),
        h('div', { class: 'row', style: 'margin:4px 0' },
          h('label', {}, 'Platform', platformSel),
          h('label', { style: 'margin-left:12px' }, newCohortChk, ' New users only (first-ever session_start that day)'),
        ),
        tableHost,
      );

      const renderTable = (cohorts: typeof initialCohorts): void => {
        clear(tableHost);
        if (cohorts.length === 0) { tableHost.append(h('div', { class: 'muted' }, 'No data')); return; }
        const t = h('table', {},
          h('tr', {},
            h('th', {}, 'Date'),
            h('th', { style: 'text-align:right' }, 'Cohort'),
            ...RETENTION_OFFSETS.map((n) => h('th', { style: 'text-align:right' }, `D${n}%`)),
          ),
        );
        for (const r of cohorts) {
          t.append(h('tr', {},
            h('td', {}, r.date),
            h('td', { style: 'text-align:right' }, String(r.cohort_size)),
            // Cell shows the rate; hover reveals the returning device count.
            ...RETENTION_OFFSETS.map((n) => {
              const c = retentionCell(r, n);
              return h('td', { style: 'text-align:right', title: c.title }, c.text);
            }),
          ));
        }
        tableHost.append(t);
      };

      const reloadRetentionCard = async (): Promise<void> => {
        const platform = platformSel.value || undefined;
        const res = await api.analyticsEvents('retention', days, platform, newCohortChk.checked);
        renderTable(retentionRows(res.retention ?? []));
      };
      platformSel.addEventListener('change', () => void reloadRetentionCard());
      newCohortChk.addEventListener('change', () => void reloadRetentionCard());

      // Same visibility gate as before this card grew filter controls: hidden entirely (not just
      // "no data") when analytics is unavailable or the unfiltered cohort has nothing — consistent
      // with every other card on this page, and avoids exposing filter controls that would just
      // never have anything to show.
      if (initialCohorts.length > 0) {
        renderTable(initialCohorts);
        body.append(card);
      }
    }

    // Grouped retention (RETENTION_LAUNCH_PLAN.md §2): the "why" card — D1–D7 of the new-user cohort
    // sliced by one property of their first session. Same scoped-fetch-on-change shape as the D1–D7
    // card above; the dimension dropdown replaces platform+newCohort since retention_by always scopes
    // to the new-user cohort (grouping only makes sense against a single, comparable cohort).
    {
      const initialGroups = retentionRows(sectionRows(retentionBy, (v) => v.retention_by));
      const dimensionSel = h('select', {},
        ...RETENTION_BY_DIMENSION_LABELS.map((d) => h('option', { value: d.value }, d.label)),
      ) as HTMLSelectElement;
      const tableHost = h('div', {});
      const card = h('div', { class: 'card' },
        h('div', { class: 'muted' }, `Retention by first-session property (new-user cohort, last ${days} days, D1–D7 return)`),
        h('div', { class: 'row', style: 'margin:4px 0' }, h('label', {}, 'Group by', dimensionSel)),
        tableHost,
      );

      const renderTable = (groups: typeof initialGroups): void => {
        clear(tableHost);
        if (groups.length === 0) { tableHost.append(h('div', { class: 'muted' }, 'No data')); return; }
        const t = h('table', {},
          h('tr', {},
            h('th', {}, 'Value'),
            h('th', { style: 'text-align:right' }, 'Cohort'),
            ...RETENTION_OFFSETS.map((n) => h('th', { style: 'text-align:right' }, `D${n}%`)),
          ),
        );
        for (const r of groups) {
          t.append(h('tr', {},
            h('td', {}, r.value),
            h('td', { style: 'text-align:right' }, String(r.cohort_size)),
            ...RETENTION_OFFSETS.map((n) => {
              const c = retentionCell(r, n);
              return h('td', { style: 'text-align:right', title: c.title }, c.text);
            }),
          ));
        }
        tableHost.append(t);
      };

      const reloadRetentionByCard = async (): Promise<void> => {
        const res = await api.analyticsEvents('retention_by', days, undefined, undefined, dimensionSel.value);
        renderTable(retentionRows(res.retention_by ?? []));
      };
      dimensionSel.addEventListener('change', () => void reloadRetentionByCard());

      if (initialGroups.length > 0) {
        renderTable(initialGroups);
        body.append(card);
      }
    }

    // First-session onboarding funnel + action breakdown (new users only)
    const fs = sectionValue(firstSession, (v) => v.first_session);
    if (fs && fs.cohort_size > 0) {
      body.append(stepFunnelCard(
        `Onboarding funnel — new users' first session (${fs.cohort_size} new devices, last ${days} days)`,
        stepFunnelRows(fs.funnel, fs.cohort_size, ONBOARDING_LABELS),
      ));

      // First-session action / scene breakdown
      if (fs.actions.length > 0) {
        const at = h('table', {},
          h('tr', {}, h('th', {}, 'Scene / action'), h('th', {}, 'Type'), h('th', { style: 'text-align:right' }, 'Users'), h('th', {}, 'Reach')),
        );
        for (const a of fs.actions) {
          at.append(h('tr', {},
            h('td', {}, a.key),
            h('td', {}, pill(a.kind, a.kind)),
            h('td', { style: 'text-align:right' }, String(a.devices)),
            h('td', {}, bar(barRatio(a.devices, fs.cohort_size))),
          ));
        }
        body.append(h('div', { class: 'card' },
          h('div', { class: 'muted' }, `First-session activity — which scenes & actions new users hit (share of ${fs.cohort_size} new devices; scene rows are screen_view-sampled, so under-counted)`),
          at,
        ));
      }
    }

    // Tutorial step-level funnel — where inside the tutorial new players quit (A9-9)
    const tf = sectionValue(tutorialFunnel, (v) => v.tutorial_funnel);
    if (tf && tf.cohort_size > 0) {
      body.append(stepFunnelCard(
        `Tutorial step funnel — where players quit inside the tutorial (${tf.cohort_size} sessions, last ${days} days)`,
        stepFunnelRows(tf.funnel, tf.cohort_size, TUTORIAL_LABELS),
      ));
    }

    // Scene/page-level funnel — login → intro/tutorial gate → lobby → pick level → prep → battle (A9-9)
    const sf = sectionValue(sceneFunnel, (v) => v.scene_funnel);
    if (sf && sf.cohort_size > 0) {
      body.append(stepFunnelCard(
        `Scene funnel — core new-user navigation path (${sf.cohort_size} sessions, last ${days} days)`,
        stepFunnelRows(sf.funnel, sf.cohort_size),
      ));
    }

    // Level funnel, feature-guide funnel and badge-distribution cards: see analyticsCards.ts
    // (A9-9 / design-doc-audit-2026-07 / ANALYTICS_DESIGN §5.8).
    const levels = levelFunnelRows(sectionRows(levelFunnel, (v) => v.level_funnel));
    const levelCard = levelFunnelCard(levels, days);
    if (levelCard) body.append(levelCard);

    const guides = sectionRows(featureGuideFunnel, (v) => v.feature_guide_funnel);
    const guideCard = featureGuideCard(guides, days);
    if (guideCard) body.append(guideCard);

    const badges = sectionRows(badgeDist, (v) => v.badge_dist);
    for (const card of badgeDistCards(badges, days)) body.append(card);

    // The five share tables. Locale is a language code, not a place — Geo below is the actual country,
    // server-derived from the request IP via geoip-lite (A9-9); raw IPs are never stored.
    const shareTables: [ShareRow[], string, string][] = [
      [distribution(sectionRows(regions, (v) => v.region_dist), 'locale'), 'Locale', `Locale distribution (last ${days} days)`],
      [distribution(sectionRows(geoDist, (v) => v.geo_dist), 'country'), 'Country', `Geo (country) distribution (last ${days} days, IP-derived)`],
      [distribution(sectionRows(osDist, (v) => v.os_dist), 'os'), 'OS', `OS distribution (last ${days} days, session_start)`],
      [distribution(sectionRows(browserDist, (v) => v.browser_dist), 'browser'), 'Browser', `Browser distribution (last ${days} days, session_start)`],
      [distribution(sectionRows(deviceTypeDist, (v) => v.device_type_dist), 'device_type'), 'Device type', `Device type distribution (last ${days} days, session_start)`],
      // Separate from Browser on purpose: an in-app WebView reports as the browser it embeds, so
      // until this table existed that whole population was invisible inside the Safari/Chrome rows.
      // It is worth watching on its own because those sessions run under much tighter memory limits
      // and get killed outright rather than shown an error. `none` is ordinary browser traffic.
      [distribution(sectionRows(webviewDist, (v) => v.webview_dist), 'webview'), 'In-app WebView', `In-app WebView distribution (last ${days} days, session_start)`],
    ];
    for (const [rows, header, caption] of shareTables) {
      if (rows.length) body.append(shareCard(caption, header, 'Devices', rows));
    }

    // Login time distribution (UTC) — same three columns, but each bar is scaled against the busiest
    // hour rather than the total, so this one is a shape and not a share.
    const hours = loginHourRows(sectionRows(loginHour, (v) => v.login_hour));
    if (hours.length) {
      body.append(shareCard(`Login hour distribution (last ${days} days, session_start)`, 'Hour (UTC)', 'Sessions', hours, 'Distribution', 'font-variant-numeric:tabular-nums'));
    }

    // Funnel conversion
    const funnelRows = sectionRows(funnel, (v) => v.funnel);
    for (const plat of funnelPlatforms(funnelRows)) {
      const { latestDate, cells } = funnelPivot(funnelRows, plat);
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Funnel step'), h('th', {}, 'Count'), h('th', {}, 'Conversion rate')));
      for (const c of cells) {
        t.append(h('tr', {},
          h('td', {}, c.step),
          h('td', { style: 'text-align:right' }, c.count !== undefined ? String(c.count) : '—'),
          h('td', { style: 'text-align:right' }, c.rate !== undefined ? pct(c.rate) : '—'),
        ));
      }
      body.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `Conversion funnel (${plat}, ${latestDate})`), t));
    }

    // Event count detail
    const evRows = sectionRows(evCounts, (v) => v.event_counts);
    if (evRows.length) {
      const { events, dates, grid } = eventCountGrid(evRows);
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Date'), ...events.map((e) => h('th', {}, e))));
      dates.forEach((date, di) => {
        t.append(h('tr', {}, h('td', {}, date), ...grid[di]!.map((n) => h('td', { style: 'text-align:right' }, String(n)))));
      });
      body.append(h('div', { class: 'card', style: 'overflow-x:auto' }, h('div', { class: 'muted' }, `Event counts (last ${days} days)`), t));
    }

    if (evCounts.status === 'rejected') showErr(err, evCounts.reason);
  };

  refreshBtn.addEventListener('click', () => void reload());
  daysSel.addEventListener('change', () => void reload());
  await reload();
}
