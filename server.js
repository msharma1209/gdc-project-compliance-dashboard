/**
 * Informatica Practice – GDC Project Compliance Dashboard
 * Secure Node.js proxy server — SF token stays on the server, never sent to browser.
 *
 * Local:      node server.js        (reads .env automatically)
 * Production: set SF_TOKEN env var in Render dashboard, then deploy.
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
var SF_TOKEN    = process.env.SF_TOKEN    || '';
var PUBLIC_DIR  = path.join(__dirname, 'public');

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

// ── SOQL query (DM IDs are not secrets) ──────────────────────────────────────
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
  'psa_pm_Project_Sub_Type__c,',
  // Adoption Events sub-query — Status + Due Date for each event on the project
  '(SELECT Id, pse__Status__c, pse__Due_Date__c FROM pse__Adoption_Events__r),',
  // Milestones sub-query — only billable milestones
  '(SELECT Id, Name, pse__Due_Date__c, pse__Billable__c FROM pse__Milestones__r WHERE pse__Billable__c = true)',
  'FROM pse__Proj__c',
  "WHERE pse__Project_Manager__c IN (" + DM_IDS.map(function (id) { return "'" + id + "'"; }).join(',') + ")",
  "AND pse__Stage__c = 'In Progress'",
  'ORDER BY pse__Project_Manager__r.Name, LastModifiedDate DESC LIMIT 200',
].join(' ');

// ── /api/projects — server-side proxy to Salesforce ──────────────────────────
function handleApiProjects(res) {
  if (!SF_TOKEN) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'SF_TOKEN environment variable is not set on the server.' }));
    return;
  }

  var sfUrl   = SF_INSTANCE + '/services/data/v59.0/query?q=' + encodeURIComponent(SOQL);
  var parsed  = url.parse(sfUrl);
  var options = {
    hostname: parsed.hostname,
    path:     parsed.path,
    method:   'GET',
    headers:  {
      'Authorization': 'Bearer ' + SF_TOKEN,
      'Content-Type':  'application/json',
    },
  };

  var sfReq = https.request(options, function (sfRes) {
    var chunks = [];
    sfRes.on('data', function (c) { chunks.push(c); });
    sfRes.on('end', function () {
      var body = Buffer.concat(chunks).toString('utf8');
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
  if (!SF_TOKEN) {
    console.log('  ⚠️   WARNING: SF_TOKEN is not set — live data will not load.');
    console.log('       Create a .env file with: SF_TOKEN=<your_salesforce_token>');
    console.log('');
  }
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
