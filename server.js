/**
 * Informatica Practice – GDC Project Compliance Dashboard
 * Secure Node.js proxy server.
 *
 * Authentication strategy (in priority order):
 *   1. SF_USERNAME + SF_PASSWORD env vars → auto-login via SOAP, token never expires
 *   2. SF_TOKEN env var (legacy) → static token, will expire eventually
 *
 * SF_PASSWORD should be: your Salesforce password + your Security Token
 * (e.g. "MyPassword123ABcDeFgH" where ABcDeFgH is the SF security token)
 *
 * Local dev:   add SF_USERNAME / SF_PASSWORD to .env
 * Render:      add SF_USERNAME / SF_PASSWORD in Environment tab — never touch again
 */

const http        = require('http');
const https       = require('https');
const fs          = require('fs');
const path        = require('path');
const url         = require('url');
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

var PORT        = Number(process.env.PORT) || 3500;
var SF_INSTANCE = process.env.SF_INSTANCE || 'https://infa.my.salesforce.com';
var SF_USERNAME = process.env.SF_USERNAME || '';
var SF_PASSWORD = process.env.SF_PASSWORD || '';   // password + security token concatenated
var SF_TOKEN    = process.env.SF_TOKEN    || '';   // fallback static token (legacy)
var PUBLIC_DIR  = path.join(__dirname, 'public');

// ── In-memory token cache (refreshed automatically) ──────────────────────────
var tokenCache = {
  accessToken:  SF_TOKEN,   // seed with static token if provided
  instanceUrl:  SF_INSTANCE,
  refreshing:   false,
  waitQueue:    [],          // callbacks waiting for a fresh token
};

// ── Salesforce SOAP login ─────────────────────────────────────────────────────
function soapLogin(callback) {
  if (!SF_USERNAME || !SF_PASSWORD) {
    return callback(new Error('SF_USERNAME / SF_PASSWORD not set — cannot auto-login.'));
  }

  var body = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
    '  xmlns:urn="urn:partner.soap.sforce.com">',
    '  <soapenv:Body>',
    '    <urn:login>',
    '      <urn:username>' + SF_USERNAME + '</urn:username>',
    '      <urn:password>' + SF_PASSWORD + '</urn:password>',
    '    </urn:login>',
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');

  // Use the org's own domain — required for SSO-enforced orgs (e.g. infa.my.salesforce.com)
  var loginHost = url.parse(SF_INSTANCE).hostname || 'login.salesforce.com';
  var loginPath = '/services/Soap/u/59.0';
  var options = {
    hostname: loginHost,
    path:     loginPath,
    method:   'POST',
    headers:  {
      'Content-Type':   'text/xml; charset=UTF-8',
      'SOAPAction':     '"login"',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  var req = https.request(options, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      var xml = Buffer.concat(chunks).toString('utf8');

      // Check for fault
      if (xml.indexOf('<faultstring>') !== -1) {
        var faultMatch = xml.match(/<faultstring>([\s\S]*?)<\/faultstring>/);
        return callback(new Error('SF login failed: ' + (faultMatch ? faultMatch[1] : 'unknown')));
      }

      // Extract sessionId and serverUrl
      var sessionMatch = xml.match(/<sessionId>([\s\S]*?)<\/sessionId>/);
      var serverMatch  = xml.match(/<serverUrl>([\s\S]*?)<\/serverUrl>/);
      if (!sessionMatch || !serverMatch) {
        return callback(new Error('SF login: could not parse sessionId/serverUrl from response.'));
      }

      var sessionId   = sessionMatch[1].trim();
      var serverUrl   = serverMatch[1].trim();
      // Derive instance URL from serverUrl (e.g. https://infa.my.salesforce.com/services/...)
      var instanceUrl = serverUrl.replace(/\/services\/.*$/, '');

      callback(null, sessionId, instanceUrl);
    });
  });

  req.on('error', function (err) { callback(err); });
  req.write(body);
  req.end();
}

// ── Get a valid token — auto-refresh if needed ────────────────────────────────
function getToken(callback) {
  // If we have a cached token, use it immediately
  if (tokenCache.accessToken) {
    return callback(null, tokenCache.accessToken, tokenCache.instanceUrl);
  }
  // Queue callbacks if a refresh is already in progress
  if (tokenCache.refreshing) {
    tokenCache.waitQueue.push(callback);
    return;
  }
  refreshToken(callback);
}

function refreshToken(callback) {
  tokenCache.refreshing = true;
  console.log('  🔄  Refreshing Salesforce token via SOAP login…');

  soapLogin(function (err, sessionId, instanceUrl) {
    tokenCache.refreshing = false;
    if (err) {
      console.error('  ❌  SF login error:', err.message);
      // Drain the queue with the error
      var q = tokenCache.waitQueue.splice(0);
      q.forEach(function (cb) { cb(err); });
      if (callback) callback(err);
      return;
    }

    tokenCache.accessToken = sessionId;
    tokenCache.instanceUrl = instanceUrl;
    console.log('  ✅  Salesforce token refreshed. Instance:', instanceUrl);

    // Drain the queue
    var q = tokenCache.waitQueue.splice(0);
    q.forEach(function (cb) { cb(null, sessionId, instanceUrl); });
    if (callback) callback(null, sessionId, instanceUrl);
  });
}

// ── SOQL query ────────────────────────────────────────────────────────────────
var DM_IDS = [
  '003VM00000JsZylYAF', // Megha Sharma
  '0033f00000Cd4ZVAAZ', // Hanumanth Kulkarni
  '003VM00000V6fl2YAB', // Aparna Kochukuttan
  '0033f000006Jdm4AAC', // Suman Viswanathan
  '0036S00005dvoulQAA', // Upasana Barbaruah
];

var SOQL = [
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
  // Adoption Events sub-query
  '(SELECT Id, PSA_PM_Adoption_Event_Status__c, PSA_PM_Adoption_Event_Date__c FROM Adoption_Events__r),',
  // Milestones sub-query — billable milestones with a target date
  '(SELECT Id, Name, pse__Target_Date__c, pse__Include_In_Financials__c FROM pse__Milestones__r WHERE pse__Include_In_Financials__c = true),',
  // CSAT surveys sub-query
  '(SELECT Id, psa_pm_Survey_Response_Date__c FROM Customer_Surveys__r ORDER BY psa_pm_Survey_Response_Date__c DESC LIMIT 1)',
  'FROM pse__Proj__c',
  "WHERE pse__Project_Manager__c IN (" + DM_IDS.map(function (id) { return "'" + id + "'"; }).join(',') + ")",
  "AND pse__Stage__c = 'In Progress'",
  'ORDER BY pse__Project_Manager__r.Name, LastModifiedDate DESC LIMIT 200',
].join(' ');

// ── Run SOQL query with a given token ─────────────────────────────────────────
function runQuery(accessToken, instanceUrl, res) {
  var sfUrl  = instanceUrl + '/services/data/v59.0/query?q=' + encodeURIComponent(SOQL);
  var parsed = url.parse(sfUrl);
  var options = {
    hostname: parsed.hostname,
    path:     parsed.path,
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

      // Detect expired/invalid session — auto-refresh and retry once
      if (sfRes.statusCode === 401 || body.indexOf('INVALID_SESSION_ID') !== -1) {
        console.log('  ⚠️  Token expired mid-request — clearing cache and retrying…');
        tokenCache.accessToken = '';  // force re-login on next getToken call
        refreshToken(function (err, newToken, newInstance) {
          if (err) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Could not refresh Salesforce token: ' + err.message }));
            return;
          }
          runQuery(newToken, newInstance, res);  // single retry
        });
        return;
      }

      res.writeHead(sfRes.statusCode, {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
    });
  });

  sfReq.on('error', function (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upstream Salesforce error: ' + err.message }));
  });

  sfReq.end();
}

// ── /api/projects ─────────────────────────────────────────────────────────────
function handleApiProjects(res) {
  getToken(function (err, accessToken, instanceUrl) {
    if (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    runQuery(accessToken, instanceUrl, res);
  });
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
  if (req.method !== 'GET') {
    res.writeHead(405); res.end('Method Not Allowed'); return;
  }

  var reqPath = req.url.split('?')[0].split('#')[0];
  try { reqPath = decodeURIComponent(reqPath); } catch (e) { reqPath = '/'; }

  if (reqPath === '/api/projects') {
    handleApiProjects(res);
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

  if (SF_USERNAME && SF_PASSWORD) {
    console.log('  🔐  Auth mode: auto-login (SF_USERNAME + SF_PASSWORD) — token refreshes automatically.');
    // Eagerly fetch a fresh token on startup
    refreshToken(function (err) {
      if (err) console.error('  ❌  Initial SF login failed:', err.message);
    });
  } else if (SF_TOKEN) {
    console.log('  🔑  Auth mode: static SF_TOKEN (will expire — consider switching to SF_USERNAME + SF_PASSWORD).');
  } else {
    console.log('  ⚠️   WARNING: No SF credentials set — live data will not load.');
    console.log('       Add SF_USERNAME and SF_PASSWORD to .env or Render environment.');
  }

  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  // Auto-open browser on Windows
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
