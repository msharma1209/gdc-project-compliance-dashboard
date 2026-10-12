/**
 * Informatica Practice – GDC Project Compliance Dashboard
 * Secure Node.js proxy server.
 *
 * Token update (no restart needed):
 *   Visit /admin  →  enter ADMIN_PASSWORD + new SF token  →  click Update
 *   The dashboard goes LIVE immediately, no Render dashboard access required.
 *
 * Environment variables:
 *   SF_TOKEN        — initial Salesforce session token
 *   SF_INSTANCE     — Salesforce instance URL (default: https://infa.my.salesforce.com)
 *   ADMIN_PASSWORD  — password to protect the /admin token-update page
 *   PORT            — local port (default: 3500)
 */

const http        = require('http');
const https       = require('https');
const fs          = require('fs');
const path        = require('path');
const { execFile } = require('child_process');

// ── Load .env (local dev only) ────────────────────────────────────────────────
(function loadEnv() {
  var envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(function (line) {
    line = line.trim();
    if (!line || line[0] === '#') return;
    var eq = line.indexOf('=');
    if (eq < 1) return;
    var key = line.slice(0, eq).trim();
    var val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  });
})();

var PORT           = Number(process.env.PORT) || 3500;
var SF_INSTANCE    = process.env.SF_INSTANCE    || 'https://infa.my.salesforce.com';
var SF_TOKEN       = process.env.SF_TOKEN       || '';
var ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'gdc-admin-2024';
var PUBLIC_DIR     = path.join(__dirname, 'public');

// ── In-memory token store ─────────────────────────────────────────────────────
var tokenCache = {
  accessToken: SF_TOKEN,
  instanceUrl: SF_INSTANCE,
};

// ── SOQL ──────────────────────────────────────────────────────────────────────
var DM_IDS = [
  '0033f000006Jdw8AAC', // Abhishek Kumar
  '0033f000006JdRWAA0', // Akhil Naik
  '003VM00000V6fl2YAB', // Aparna Kochukuttan
  '0033f000006JdmOAAS', // Arun Kumar
  '0036S00005dSp8jQAC', // Ayush Sharma
  '0033f000006JdoAAAS', // Chandrasekar K
  '0033f000006JdtTAAS', // Chinmayanand Jha
  '0033f000006JdoSAAS', // Devendar Yadav
  '0033f000006JdwoAAC', // Dhananjay Kumar Sinha
  '0033f000006JdVJAA0', // Edwin Sukumar
  '0033f00000Cd4ZVAAZ', // Hanumanth Kulkarni
  '0033f000006Je4iAAC', // Kamalesh Purushotham
  '003VM00000JsZylYAF', // Megha Sharma
  '0033f000006Jdz7AAC', // Muthukumar Somasundaram
  '0033f000006JdPeAAK', // Naveen Bendigeri
  '0036S00005eH6ZqQAK', // Nimisha Sarma
  '0033f000006JdsGAAS', // Rahul K
  '0033f000006JdJAAA0', // Shiladitya Biswas
  '0033f000006JeDYAA0', // Sowmya Shivashankar
  '0033f000006Jdm4AAC', // Suman Viswanathan
  '0036S00005dvoulQAA', // Upasana Barbaruah
];

// ── Shared SELECT fields (used in both queries) ───────────────────────────────
var SOQL_SELECT = [
  'SELECT Id, Name, pse__Stage__c, pse__Project_Status__c, pse__Start_Date__c,',
  'pse__End_Date__c, psa_pm_PercentComplete__c, pse__Planned_Hours__c,',
  'pse__Scheduled_Hours_Remaining__c, PSA_PM_Total_Billable_Hours_Remaining__c,',
  'pse__Financial_Status__c, pse__Schedule_Status__c, pse__Scope_Status__c,',
  'pse__Account__r.Name, psa_pm_At_Risk__c, PSA_PM_Resources__c,',
  'pse__Project_Manager__r.Name, pse__Project_Manager__c,',
  'psa_pm_Portfolio_Manager__r.Name, psa_Overall_Project_Status_Trend__c,',
  'PSA_PM_Last_Project_Status_Report_Week__c, pse__Billable_External_Hours__c,',
  'psa_pm_Project_Category__c, psa_pm_Engagement_Type__c,',
  'psa_tm_Last_Time_Entry_Date__c, PSA_Adoption_Event_Not_Required_Reason__c,',
  'pse_pm_Last_Customer_Survey_Created__c, PSA_Status_report_on_Project__c,',
  'psa_pm_Project_Sub_Type__c, pse__Practice__r.Name, pse__Region__r.Name,',
  'pse__Billing_Type__c, PSA_PM_Margin_Percent__c,',
  '(SELECT Id, PSA_PM_Adoption_Event_Status__c, PSA_PM_Adoption_Event_Date__c, PSA_PM_Start_Date__c FROM Adoption_Events__r),',
  '(SELECT Id, Name, pse__Target_Date__c, pse__Include_In_Financials__c FROM pse__Milestones__r ORDER BY pse__Target_Date__c ASC NULLS LAST LIMIT 50),',
  '(SELECT Id, psa_pm_Survey_Sent_Date__c, psa_pm_Survey_Response_Date__c FROM Customer_Surveys__r WHERE psa_pm_Survey_Sent_Date__c != null ORDER BY psa_pm_Survey_Sent_Date__c DESC LIMIT 1),',
  '(SELECT Id, PSA_PM_Status_Report_Week__c FROM Status_Reports__r ORDER BY PSA_PM_Status_Report_Week__c DESC LIMIT 1),',
  '(SELECT Id, pse__Resource__c, pse__Role__c FROM pse__Assignments__r WHERE pse__Role__c = \'Delivery Manager\')',
  'FROM pse__Proj__c',
].join(' ');

var SOQL_SUFFIX = "AND pse__Stage__c NOT IN ('Completed','Cancelled','Canceled','On Hold','Closed','Delivery Complete') ORDER BY pse__Project_Manager__r.Name, LastModifiedDate DESC LIMIT 500";
var DM_IN       = "(" + DM_IDS.map(function (id) { return "'" + id + "'"; }).join(',') + ")";

// Query 1: projects where DM is Project Manager
var SOQL_BY_PM  = SOQL_SELECT + " WHERE pse__Project_Manager__c IN " + DM_IN + " " + SOQL_SUFFIX;

// Query 2: projects where DM is assigned as Delivery Manager (semi-join at top level — SOQL requirement)
var SOQL_BY_DM  = SOQL_SELECT + " WHERE Id IN (SELECT pse__Project__c FROM pse__Assignment__c WHERE pse__Role__c = 'Delivery Manager' AND pse__Resource__c IN " + DM_IN + ") " + SOQL_SUFFIX;

// ── Run a single SOQL string, return parsed JSON via callback ─────────────────
function fetchSOQL(soql, accessToken, instanceUrl, callback) {
  var sfUrl  = instanceUrl + '/services/data/v59.0/query?q=' + encodeURIComponent(soql);
  var parsed = new URL(sfUrl);
  var options = {
    hostname: parsed.hostname,
    path:     parsed.pathname + parsed.search,
    method:   'GET',
    headers:  {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type':  'application/json',
    },
  };

  var sfReq = https.request(options, function (sfRes) {
    var chunks = [];
    sfRes.on('data', function (c) { chunks.push(c); });
    sfRes.on('end', function () {
      var body = Buffer.concat(chunks).toString('utf8');
      if (sfRes.statusCode === 401 || body.indexOf('INVALID_SESSION_ID') !== -1) {
        return callback(new Error('INVALID_SESSION_ID'));
      }
      try {
        callback(null, JSON.parse(body), sfRes.statusCode);
      } catch (e) {
        callback(new Error('JSON parse error: ' + e.message));
      }
    });
  });

  sfReq.on('error', function (err) { callback(err); });
  sfReq.end();
}

// ── Run both queries, merge + deduplicate, respond ───────────────────────────
function runQuery(accessToken, instanceUrl, res) {
  var results = {};
  var pending = 2;
  var failed  = null;

  function done(err, data) {
    if (failed) return;  // already responded with error
    if (err) {
      failed = true;
      // Token expired — clear and signal caller to retry
      if (err.message === 'INVALID_SESSION_ID') {
        return res.__tokenExpired();
      }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    if (data) {
      (data.records || []).forEach(function (r) { results[r.Id] = r; });
    }
    pending--;
    if (pending === 0) {
      var merged = Object.keys(results).map(function (k) { return results[k]; });
      var out = JSON.stringify({ totalSize: merged.length, done: true, records: merged });
      res.writeHead(200, {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(out);
    }
  }

  fetchSOQL(SOQL_BY_PM,  accessToken, instanceUrl, done);
  fetchSOQL(SOQL_BY_DM,  accessToken, instanceUrl, done);
}

// ── /api/projects ─────────────────────────────────────────────────────────────
function handleApiProjects(res) {
  if (!tokenCache.accessToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No SF token set. Visit /admin to update the token.' }));
    return;
  }

  // Attach a helper so runQuery can signal token expiry
  res.__tokenExpired = function () {
    console.log('  ⚠️  Token expired — clearing cache. Visit /admin to update token.');
    tokenCache.accessToken = '';
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'INVALID_SESSION_ID' }));
  };

  runQuery(tokenCache.accessToken, tokenCache.instanceUrl, res);
}

// ── /admin  GET — token update page ──────────────────────────────────────────
var ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GDC Dashboard – Update Token</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:#0f1117;color:#e2e8f0;min-height:100vh;display:flex;
       align-items:center;justify-content:center;padding:24px}
  .card{background:#1a1d2e;border:1px solid #2d3148;border-radius:16px;
        padding:40px;width:100%;max-width:540px;box-shadow:0 8px 32px rgba(0,0,0,.4)}
  h1{font-size:1.3rem;font-weight:700;margin-bottom:6px;color:#fff}
  p{font-size:.85rem;color:#94a3b8;margin-bottom:28px;line-height:1.5}
  label{display:block;font-size:.8rem;font-weight:600;color:#94a3b8;
        text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
  input,textarea{width:100%;background:#0f1117;border:1px solid #2d3148;
                 border-radius:8px;padding:10px 14px;color:#e2e8f0;
                 font-size:.9rem;outline:none;transition:border .2s}
  input:focus,textarea:focus{border-color:#6366f1}
  textarea{font-family:monospace;font-size:.78rem;resize:vertical;min-height:90px}
  .field{margin-bottom:20px}
  button{width:100%;padding:12px;background:#6366f1;color:#fff;border:none;
         border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer;
         transition:background .2s;margin-top:4px}
  button:hover{background:#4f46e5}
  #msg{margin-top:18px;padding:12px 16px;border-radius:8px;font-size:.88rem;
       display:none;text-align:center}
  .ok{background:#064e3b;color:#6ee7b7;border:1px solid #065f46}
  .err{background:#450a0a;color:#fca5a5;border:1px solid #7f1d1d}
  .hint{font-size:.75rem;color:#64748b;margin-top:5px}
  a{color:#6366f1;text-decoration:none}
  a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="card">
  <h1>🔑 Update Salesforce Token</h1>
  <p>Paste a fresh token here and the dashboard goes <strong>LIVE instantly</strong> — no server restart needed.</p>

  <div class="field">
    <label>Admin Password</label>
    <input type="password" id="pwd" placeholder="Enter admin password" autocomplete="current-password">
  </div>

  <div class="field">
    <label>Salesforce Session Token</label>
    <textarea id="token" placeholder="00D41000000dqX7!AQEA…"></textarea>
    <div class="hint">
      Get it from Salesforce → Setup → Quick Find: <strong>Session Management</strong>, or copy from browser DevTools
      (Network tab → any API call → Authorization header, remove "Bearer ")
    </div>
  </div>

  <button onclick="updateToken()">Update Token &amp; Go Live</button>
  <div id="msg"></div>

  <p style="margin-top:24px;text-align:center">
    <a href="/">← Back to Dashboard</a>
  </p>
</div>
<script>
function updateToken() {
  var pwd   = document.getElementById('pwd').value.trim();
  var token = document.getElementById('token').value.trim();
  var msg   = document.getElementById('msg');
  msg.style.display = 'none';

  if (!pwd || !token) {
    msg.className='err'; msg.textContent='Please fill in both fields.';
    msg.style.display='block'; return;
  }

  fetch('/api/update-token', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({password: pwd, token: token})
  })
  .then(function(r){ return r.json(); })
  .then(function(data) {
    if (data.ok) {
      msg.className='ok';
      msg.textContent='✅ Token updated! Dashboard is now LIVE. Redirecting…';
      msg.style.display='block';
      setTimeout(function(){ window.location='/'; }, 2000);
    } else {
      msg.className='err';
      msg.textContent='❌ ' + (data.error || 'Unknown error');
      msg.style.display='block';
    }
  })
  .catch(function(e){
    msg.className='err'; msg.textContent='Network error: ' + e.message;
    msg.style.display='block';
  });
}
document.addEventListener('keydown', function(e){
  if (e.key==='Enter') updateToken();
});
</script>
</body>
</html>`;

// ── /api/update-token  POST — update token in memory ─────────────────────────
function handleUpdateToken(req, res) {
  var chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () {
    var body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      return;
    }

    if (!body.password || body.password !== ADMIN_PASSWORD) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Wrong admin password.' }));
      return;
    }

    var newToken = (body.token || '').trim();
    if (!newToken) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Token cannot be empty.' }));
      return;
    }

    tokenCache.accessToken = newToken;
    console.log('  ✅  SF token updated via /admin at', new Date().toISOString());

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}

// ── /api/lookup-dms — find Contact IDs for known DM names ───────────────────
var DM_NAMES_TO_FIND = [
  'Megha Sharma','Hanumanth Kulkarni','Upasana Barbaruah','Suman Viswanathan',
  'Aparna Kochukuttan','Akhil Naik','Shiladitya Biswas','Edwin Sukumar',
  'Arun Kumar','Ramesh Dasaranna Mattehunta','Naveen Bendigeri','Kamalesh Purushotham',
  'Chandrasekar K','Abhishek Kumar','Rahul K','Sowmya Shivashankar',
  'Ayush Sharma','Devendar Yadav','Chinmayanand Jha','Nimisha Sarma',
  'Dhananjay Kumar Sinha','Muthukumar Somasundaram','Hemanth'
];

function handleLookupDMs(res) {
  if (!tokenCache.accessToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No SF token set. Visit /admin to update the token.' }));
    return;
  }
  // Query 1: Contacts who are PM on any active project
  var pmSoql = "SELECT Id, Name FROM Contact WHERE Id IN (SELECT pse__Project_Manager__c FROM pse__Proj__c WHERE pse__Project_Manager__r.Name IN (" +
    DM_NAMES_TO_FIND.map(function(n){ return "'"+n+"'"; }).join(',') + ")) ORDER BY Name";
  // Query 2: Contacts assigned as Delivery Manager role
  var dmSoql = "SELECT Id, Name FROM Contact WHERE Id IN (SELECT pse__Resource__c FROM pse__Assignment__c WHERE pse__Role__c = 'Delivery Manager' AND pse__Resource__r.Name IN (" +
    DM_NAMES_TO_FIND.map(function(n){ return "'"+n+"'"; }).join(',') + ")) ORDER BY Name";

  var combined = {};
  var pending = 2;
  function done(err, data) {
    if (err) { res.writeHead(502, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:err.message})); return; }
    (data.records||[]).forEach(function(r){ combined[r.Id] = r.Name; });
    pending--;
    if (pending === 0) {
      var out = Object.keys(combined).map(function(id){ return {id:id, name:combined[id]}; });
      out.sort(function(a,b){ return a.name.localeCompare(b.name); });
      res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify(out, null, 2));
    }
  }
  fetchSOQL(pmSoql, tokenCache.accessToken, tokenCache.instanceUrl, done);
  fetchSOQL(dmSoql, tokenCache.accessToken, tokenCache.instanceUrl, done);
}

// ── /api/milestones ───────────────────────────────────────────────────────────
// Top-level query on pse__Milestone__c (RecordType.Name works here, not in sub-queries).
// Returns flat array of billing milestones due in next 30 days, with practice info.
function handleMilestones(res) {
  if (!tokenCache.accessToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No SF token set.' }));
    return;
  }

  var today = new Date();
  var in30  = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }

  // Fetch ALL milestones due in next 30 days with RecordType.Name included in SELECT.
  // Do NOT filter by RecordType.Name in WHERE — the exact name varies per org.
  // Server returns RecordType.Name + pse__Include_In_Financials__c so the client
  // can apply a "contains billing" check and see what's actually there.
  var soql =
    "SELECT Id, Name, pse__Status__c, pse__Target_Date__c, " +
    "RecordType.Name, pse__Include_In_Financials__c, " +
    "pse__Project__c, pse__Project__r.Name, " +
    "pse__Project__r.pse__Practice__r.Name " +
    "FROM pse__Milestone__c " +
    "WHERE pse__Status__c != 'Complete' " +
    "AND pse__Target_Date__c >= " + fmtDate(today) + " " +
    "AND pse__Target_Date__c <= " + fmtDate(in30) + " " +
    "AND pse__Project__r.pse__Stage__c NOT IN " +
      "('Completed','Cancelled','Canceled','On Hold','Closed','Delivery Complete') " +
    "ORDER BY pse__Target_Date__c ASC LIMIT 500";

  fetchSOQL(soql, tokenCache.accessToken, tokenCache.instanceUrl, function(err, data) {
    if (err) {
      if (err.message === 'INVALID_SESSION_ID') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INVALID_SESSION_ID' }));
        return;
      }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    // Return flat list — include recordTypeName so client can filter "contains billing"
    var records = (data.records || []).map(function(m) {
      return {
        id:                  m.Id,
        name:                m.Name,
        date:                m.pse__Target_Date__c,
        status:              m.pse__Status__c,
        recordTypeName:      m.RecordType ? m.RecordType.Name : null,
        includeInFinancials: !!m.pse__Include_In_Financials__c,
        projectId:           m.pse__Project__c,
        projectName:         m.pse__Project__r ? m.pse__Project__r.Name : null,
        practice:            (m.pse__Project__r && m.pse__Project__r.pse__Practice__r)
                               ? m.pse__Project__r.pse__Practice__r.Name
                               : 'Unassigned'
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(records));
  });
}

// ── /api/record-types — fetch RecordType IDs for pse__Milestone__c ──────────
function handleRecordTypes(res) {
  if (!tokenCache.accessToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No SF token set.' }));
    return;
  }
  var soql = "SELECT Id, Name FROM RecordType WHERE SObjectType = 'pse__Milestone__c' ORDER BY Name";
  fetchSOQL(soql, tokenCache.accessToken, tokenCache.instanceUrl, function(err, data) {
    if (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data.records || []));
  });
}

// ── /api/debug-milestones — raw query for diagnosis ──────────────────────────
// Runs: pse__Milestone__c where Status != Complete AND TargetDate in next 30 days
// Returns full raw records so we can see RecordType.Name, Practice, Status etc.
function handleDebugMilestones(res) {
  if (!tokenCache.accessToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No SF token set.' }));
    return;
  }
  var today = new Date();
  var in30  = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }

  // Your exact query + extra fields so we can see what's there
  var soql =
    "SELECT Id, Name, pse__Status__c, pse__Target_Date__c, RecordType.Name, RecordTypeId, " +
    "pse__Include_In_Financials__c, " +
    "pse__Project__r.Name, pse__Project__r.pse__Practice__r.Name " +
    "FROM pse__Milestone__c " +
    "WHERE pse__Status__c != 'Complete' " +
    "AND pse__Target_Date__c >= " + fmtDate(today) + " " +
    "AND pse__Target_Date__c <= " + fmtDate(in30) + " " +
    "AND pse__Project__r.pse__Practice__r.Name = 'Consulting Services' " +
    "ORDER BY pse__Target_Date__c ASC LIMIT 200";

  fetchSOQL(soql, tokenCache.accessToken, tokenCache.instanceUrl, function(err, data) {
    if (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, soql: soql }));
      return;
    }
    // Return pretty JSON with the SOQL used, total count, and all records
    var out = {
      soql: soql,
      totalSize: (data.records || []).length,
      records: (data.records || []).map(function(m) {
        return {
          Id:                        m.Id,
          Name:                      m.Name,
          Status:                    m.pse__Status__c,
          TargetDate:                m.pse__Target_Date__c,
          RecordTypeName:            m.RecordType ? m.RecordType.Name : null,
          RecordTypeId:              m.RecordTypeId,
          IncludeInFinancials:       m.pse__Include_In_Financials__c,
          ProjectName:               m.pse__Project__r ? m.pse__Project__r.Name : null,
          Practice:                  m.pse__Project__r && m.pse__Project__r.pse__Practice__r
                                       ? m.pse__Project__r.pse__Practice__r.Name : null
        };
      })
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(out, null, 2));
  });
}

// ── /api/canvas-data — compute all KPI numbers server-side for canvas export ─
function handleCanvasData(res) {
  if (!tokenCache.accessToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No SF token set.' }));
    return;
  }

  var results = {};
  var pending = 2;
  var failed  = false;

  function done(err, data) {
    if (failed) return;
    if (err) {
      failed = true;
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    (data.records || []).forEach(function(r) { results[r.Id] = r; });
    pending--;
    if (pending !== 0) return;

    var projects = Object.keys(results).map(function(k) { return results[k]; });
    var today = new Date();

    function pad(n){ return n<10?'0'+n:''+n; }
    function parseDate(s){
      if(!s) return null;
      var p=s.split('-'); if(p.length!==3) return null;
      return new Date(Date.UTC(+p[0],+p[1]-1,+p[2]));
    }
    function daysDiff(a,b){ return Math.floor((a-b)/(1000*60*60*24)); }

    function isInternal(p) {
      var badStages=['completed','cancelled','canceled','on hold','closed','delivery complete'];
      if(badStages.indexOf((p.pse__Stage__c||'').toLowerCase())!==-1) return true;
      var prac=(p.pse__Practice__r&&p.pse__Practice__r.Name)?p.pse__Practice__r.Name.toLowerCase():'';
      if(prac==='internal') return true;
      var cat=(p.psa_pm_Project_Category__c||'').toLowerCase();
      return cat==='productive non - billable'||cat==='internal';
    }
    function hasRecentTimecard(p){
      if(!p.psa_tm_Last_Time_Entry_Date__c) return false;
      var d=parseDate(p.psa_tm_Last_Time_Entry_Date__c);
      return d&&daysDiff(today,d)<=90;
    }

    // Active billable projects
    var active = projects.filter(function(p){ return !isInternal(p) && hasRecentTimecard(p); });
    var total  = active.length;
    if (!total) { res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify({total:0,kpis:[],practices:{},dms:{},reds:[]})); return; }

    // KPI counts
    function count(fn){ return active.filter(fn).length; }

    var noStatus       = count(function(p){ return !p.pse__Project_Status__c; });
    var missingReports = count(function(p){
      if(!p.PSA_PM_Last_Project_Status_Report_Week__c) return true;
      var d=parseDate(p.PSA_PM_Last_Project_Status_Report_Week__c); return d&&daysDiff(today,d)>14;
    });
    var redStatus      = count(function(p){ return p.pse__Project_Status__c==='Red'||p.psa_Overall_Project_Status_Trend__c==='Red'; });
    var pastEnd        = count(function(p){ var d=parseDate(p.pse__End_Date__c); return d&&d<today; });
    var lowMargin      = count(function(p){ return p.PSA_PM_Margin_Percent__c!==null&&p.PSA_PM_Margin_Percent__c!==undefined&&p.PSA_PM_Margin_Percent__c<50; });
    var timecardLate   = count(function(p){
      if(!p.psa_tm_Last_Time_Entry_Date__c) return true;
      var d=parseDate(p.psa_tm_Last_Time_Entry_Date__c); return d&&daysDiff(today,d)>30;
    });
    var zeroHours      = count(function(p){ return !p.pse__Planned_Hours__c||p.pse__Planned_Hours__c===0; });
    var overBudget     = count(function(p){ return p.PSA_PM_Total_Billable_Hours_Remaining__c!==null&&p.PSA_PM_Total_Billable_Hours_Remaining__c<0; });
    var missingCSAT    = count(function(p){
      var surveys=p.Customer_Surveys__r&&p.Customer_Surveys__r.records;
      if(!surveys||!surveys.length) return true;
      var sent=surveys[0].psa_pm_Survey_Sent_Date__c;
      if(!sent) return true;
      var d=parseDate(sent); return d&&daysDiff(today,d)>90;
    });
    var missingAE      = count(function(p){
      var aes=p.Adoption_Events__r&&p.Adoption_Events__r.records;
      if(aes&&aes.length) return false;
      return !p.PSA_Adoption_Event_Not_Required_Reason__c;
    });

    function pct(compliant,tot){ return tot?Math.round((compliant/tot)*100):0; }

    var kpis = [
      { label:'Status Updated',         compliant:total-noStatus,       total:total, pct:pct(total-noStatus,total),       icon:'📋' },
      { label:'Status Reports Filed',   compliant:total-missingReports, total:total, pct:pct(total-missingReports,total), icon:'📄' },
      { label:'Not Red Status',         compliant:total-redStatus,      total:total, pct:pct(total-redStatus,total),      icon:'🔴' },
      { label:'Within End Date',        compliant:total-pastEnd,        total:total, pct:pct(total-pastEnd,total),        icon:'📅' },
      { label:'Healthy Margin (≥50%)',  compliant:total-lowMargin,      total:total, pct:pct(total-lowMargin,total),      icon:'💰' },
      { label:'Timecard Up to Date',    compliant:total-timecardLate,   total:total, pct:pct(total-timecardLate,total),   icon:'🕐' },
      { label:'Planned Hours Entered',  compliant:total-zeroHours,      total:total, pct:pct(total-zeroHours,total),      icon:'⏱️' },
      { label:'Hours Within Budget',    compliant:total-overBudget,     total:total, pct:pct(total-overBudget,total),     icon:'⚠️' },
      { label:'CSAT Survey Sent',       compliant:total-missingCSAT,    total:total, pct:pct(total-missingCSAT,total),    icon:'⭐' },
      { label:'Adoption Events Covered',compliant:total-missingAE,      total:total, pct:pct(total-missingAE,total),     icon:'🎯' },
    ];

    // Practice breakdown
    var practices = {};
    active.forEach(function(p){
      var prac=(p.pse__Practice__r&&p.pse__Practice__r.Name)||'Unassigned';
      practices[prac]=(practices[prac]||0)+1;
    });

    // DM breakdown
    var dms = {};
    active.forEach(function(p){
      var dm=(p.pse__Project_Manager__r&&p.pse__Project_Manager__r.Name)||(p.psa_pm_Portfolio_Manager__r&&p.psa_pm_Portfolio_Manager__r.Name)||'Unassigned';
      dms[dm]=(dms[dm]||0)+1;
    });

    // Red/At-risk projects
    var reds = active.filter(function(p){ return p.pse__Project_Status__c==='Red'||p.psa_pm_At_Risk__c; })
      .map(function(p){ return { name:p.Name, account:(p.pse__Account__r&&p.pse__Account__r.Name)||'', status:p.pse__Project_Status__c||'', atRisk:!!p.psa_pm_At_Risk__c }; });

    // Ending in Oct 2026
    var endingOct = count(function(p){ var d=parseDate(p.pse__End_Date__c); var oct=new Date(Date.UTC(2026,9,31,12,0,0)); return d&&d>=today&&d<=oct; });

    var dateStr = today.toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'});

    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify({ date:dateStr, total:total, kpis:kpis, practices:practices, dms:dms, reds:reds, endingOct:endingOct }));
  }

  fetchSOQL(SOQL_BY_PM, tokenCache.accessToken, tokenCache.instanceUrl, done);
  fetchSOQL(SOQL_BY_DM, tokenCache.accessToken, tokenCache.instanceUrl, done);
}

// ── Static file serving from public/ ─────────────────────────────────────────
function handleStatic(reqPath, res) {
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

  var safePath = path.normalize(path.join(PUBLIC_DIR, reqPath));
  if (!safePath.startsWith(PUBLIC_DIR + path.sep) && safePath !== PUBLIC_DIR) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(safePath, function (err, stat) {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    var ext  = path.extname(safePath).toLowerCase();
    var mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    fs.createReadStream(safePath).pipe(res);
  });
}

// ── Mime types ────────────────────────────────────────────────────────────────
var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

// ── HTTP server ───────────────────────────────────────────────────────────────
var server = http.createServer(function (req, res) {
  var reqPath = req.url.split('?')[0].split('#')[0];
  try { reqPath = decodeURIComponent(reqPath); } catch (e) { reqPath = '/'; }

  // POST routes
  if (req.method === 'POST') {
    if (reqPath === '/api/update-token') {
      handleUpdateToken(req, res);
    } else {
      res.writeHead(405); res.end('Method Not Allowed');
    }
    return;
  }

  // GET routes
  if (req.method !== 'GET') {
    res.writeHead(405); res.end('Method Not Allowed'); return;
  }

  if (reqPath === '/api/canvas-data') {
    handleCanvasData(res);
  } else if (reqPath === '/api/projects') {
    handleApiProjects(res);
  } else if (reqPath === '/api/milestones') {
    handleMilestones(res);
  } else if (reqPath === '/api/debug-milestones') {
    handleDebugMilestones(res);
  } else if (reqPath === '/api/record-types') {
    handleRecordTypes(res);
  } else if (reqPath === '/api/lookup-dms') {
    handleLookupDMs(res);
  } else if (reqPath === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(ADMIN_HTML);
  } else if (reqPath === '/canvas') {
    // Serve canvas.html explicitly (no extension in URL)
    var canvasPath = path.join(PUBLIC_DIR, 'canvas.html');
    fs.stat(canvasPath, function(err, stat) {
      if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      fs.createReadStream(canvasPath).pipe(res);
    });
  } else {
    handleStatic(reqPath, res);
  }
});

server.listen(PORT, function () {
  console.log('');
  console.log('  ✅  Dashboard is live at:');
  console.log('');
  console.log('       http://localhost:' + PORT);
  console.log('');
  if (SF_TOKEN) {
    console.log('  🔑  Auth mode: static SF_TOKEN (update at /admin when it expires).');
  } else {
    console.log('  ⚠️   No SF token set — visit /admin to add one.');
  }
  console.log('  🔐  Token update page: http://localhost:' + PORT + '/admin');
  console.log('       Admin password is set via ADMIN_PASSWORD env var.');
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  if (process.platform === 'win32') {
    execFile('cmd.exe', ['/c', 'start', '', 'http://localhost:' + PORT], function () {});
  }
});

server.on('error', function (err) {
  if (err.code === 'EADDRINUSE') {
    console.error('\n  Port ' + PORT + ' is already in use.');
    console.error('  Open http://localhost:' + PORT + ' in your browser, or set PORT=<other> in .env.\n');
  } else {
    console.error(err);
  }
  process.exit(1);
});
