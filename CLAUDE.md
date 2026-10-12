# GDC Informatica Practice – Compliance Dashboard

A Node.js dashboard deployed on Render that reads live Salesforce PSA data and shows project compliance KPIs for the GDC Informatica practice team.

**Repo:** https://github.com/msharma1209/gdc-project-compliance-dashboard  
**Live URL:** (Render – auto-deploys from `master` branch)

---

## Architecture

| File | Purpose |
|------|---------|
| `server.js` | Node.js HTTP server — proxies all Salesforce SOQL queries, serves static files |
| `public/index.html` | Main dashboard — all UI, charts, KPI logic in one file |
| `public/canvas.html` | Canvas export page — password-gated, generates rich report from live SF data |

No build step. No framework. Plain HTML/CSS/JS + Chart.js on the front end.

---

## Salesforce Connection

- **Instance:** `https://infa.my.salesforce.com`
- **Auth:** Session token (`SF_TOKEN` env var on Render). Tokens expire — update at `/admin`.
- **Admin password:** `ADMIN_PASSWORD` env var (default `gdc-admin-2024`).
- **Canvas password:** `CANVAS_PASSWORD` env var (gates `/canvas` behind a login page).

### Critical SOQL rules for PSA (pse__) objects

1. **Never put `RecordTypeId` or `RecordType.Name` in a sub-query SELECT** — PSA silently returns 0 records with no error. Only works in top-level queries on `pse__Milestone__c`.
2. **`records.length === 0` is valid** — do NOT throw or fall back to cache on empty results; a DM may simply have no active projects.
3. Sub-queries on projects use relationships: `pse__Milestones__r`, `Adoption_Events__r`, `Customer_Surveys__r`, `Status_Reports__r`, `pse__Assignments__r`.

### DM list

The dashboard tracks ~21 Delivery Managers by Salesforce Contact ID in `DM_IDS` array in `server.js`. Two SOQL queries run in parallel and merge results:
- `SOQL_BY_PM` — projects where the DM is Project Manager (`pse__Project_Manager__c`)
- `SOQL_BY_DM` — projects where DM is assigned as Delivery Manager role via `pse__Assignment__c`

---

## Key client-side helpers (`index.html`)

```js
isInternal(p)         // true if project is internal/non-billable/completed
hasRecentTimecard(p)  // true if last time entry within 90 days
isBillingMilestone(m) // checks recordTypeName contains "billing" (case-insensitive), falls back to includeInFinancials
hasBillableMilestoneDueSoon(p) // checks state.billingMilestones for matching projectId
```

Active billable projects = `!isInternal(p) && hasRecentTimecard(p)`.

---

## KPI tiles

Defined in `KPI_DEFS` array. Each has: `id`, `label`, `icon`, `border` (green/yellow/red), `match(p)` function, optional `comingSoon: true` to grey out.

| KPI | What it checks |
|-----|---------------|
| Total Active Projects | `!isInternal(p)` |
| No Status Updated | `!pse__Project_Status__c` |
| Missing Status Reports | Last report > 14 days ago |
| Red Status | `pse__Project_Status__c === 'Red'` or trend Red |
| Past End Date | End date in the past |
| Timecard Late | Last time entry > 30 days ago |
| Low Margin | `PSA_PM_Margin_Percent__c < 50` |
| Zero Planned Hours | `pse__Planned_Hours__c === 0` |
| Over Budget | `PSA_PM_Total_Billable_Hours_Remaining__c < 0` |
| Missing CSAT | No survey sent or last survey > 90 days |
| Missing Adoption Event | No adoption event AND no exemption reason |
| Milestones Due (30d) | **comingSoon: true** — greyed out pending fix |

---

## Milestones Due KPI (known issue)

- Dedicated `/api/milestones` endpoint runs a **top-level** query on `pse__Milestone__c`.
- Returns flat array with `recordTypeName` — client filters with `isBillingMilestone()`.
- Tile is currently greyed out as "Going Live Soon" until RecordType name in org is confirmed.
- To diagnose: check browser console for `Milestones loaded: X records | RecordType names found: ...`
- Debug endpoint: `/api/debug-milestones` returns raw records with RecordType names.

---

## Tab persistence

Active tab stored in `localStorage` key `gdc_active_tab`. `switchTab(tabName)` helper updates both UI and storage.

---

## Canvas page (`/canvas`)

- Password-gated: `CANVAS_PASSWORD` env var → redirects to `/canvas-login` if not authenticated.
- Session cookie `canvas_session` — 24-hour HttpOnly cookie.
- Calls `/api/projects` directly (same as dashboard) and computes all KPIs client-side.
- Has "Generate from Live Data" button and "Save as PDF / Print" button.
- Sign out link calls `/api/canvas-logout`.

---

## Deployment

- **Platform:** Render (free tier, auto-deploy from GitHub `master`)
- **Env vars to set on Render:**
  - `SF_TOKEN` — Salesforce session token
  - `SF_INSTANCE` — `https://infa.my.salesforce.com`
  - `ADMIN_PASSWORD` — token update page password
  - `CANVAS_PASSWORD` — canvas access password
- **Token refresh:** Visit `/admin` on the live URL, enter admin password + new SF token → live immediately, no restart.

---

## Common fixes / gotchas

| Problem | Cause | Fix |
|---------|-------|-----|
| Dashboard always shows cached/old data | `SF_TOKEN` expired | Visit `/admin` and paste new token |
| 0 records returned from SOQL | `RecordTypeId` in sub-query SELECT | Remove it — PSA silently breaks |
| Milestones KPI shows 0 | RecordType name mismatch | Check `/api/debug-milestones` for actual names |
| Canvas shows 0 records | Route missing or auth issue | Check `/canvas` route in server.js, check token |
| Status drill-down shows wrong colour | Hardcoded icon in chart click handler | Map label → emoji in `statusIcons` object |
