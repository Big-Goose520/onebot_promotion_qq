const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ==================== Load config ====================
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config;

try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (e) {
  console.error('Config read failed:', e.message);
  process.exit(1);
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    console.error('Config save failed:', e.message);
  }
}

// ==================== State ====================
const state = {
  running: false,
  groups: [],
  wsConn: null,
  echoSeq: 0,
  timer: null,
  roundMsgsLeft: 0,
  logs: [],
};

function addLog(type, msg) {
  const time = new Date().toLocaleTimeString('zh-CN');
  const line = '[' + time + '] [' + type + '] ' + msg;
  state.logs.push(line);
  if (state.logs.length > 200) state.logs.shift();
  console.log(line);
}

// ==================== OneBot API ====================
function callApi(action, params) {
  params = params || {};
  return new Promise(function (resolve, reject) {
    if (!state.wsConn || state.wsConn.readyState !== WebSocket.OPEN) {
      return reject(new Error('OneBot WS not connected'));
    }
    var echo = String(++state.echoSeq);
    var payload = JSON.stringify({ action: action, params: params, echo: echo });

    var timeout = setTimeout(function () {
      state.wsConn.off('message', handler);
      reject(new Error('API timeout: ' + action));
    }, 15000);

    var handler = function (raw) {
      try {
        var data = JSON.parse(raw.toString());
        if (data.echo === echo) {
          clearTimeout(timeout);
          state.wsConn.off('message', handler);
          if (data.status === 'ok') {
            resolve(data.data);
          } else {
            reject(new Error(action + ' failed: ' + JSON.stringify(data)));
          }
        }
      } catch (_) {}
    };

    state.wsConn.on('message', handler);
    state.wsConn.send(payload);
  });
}

async function getGroupList() {
  var data = await callApi('get_group_list');
  state.groups = data || [];
  return state.groups;
}

async function sendGroupMsg(groupId, message) {
  await callApi('send_group_msg', { group_id: Number(groupId), message: message });
  addLog('SEND', 'Group ' + groupId + ': ' + message);
}

async function leaveGroup(groupId) {
  await callApi('set_group_leave', { group_id: Number(groupId) });
  addLog('LEAVE', 'Left group ' + groupId);
}

async function joinGroup(groupId) {
  var apis = [
    { action: 'set_group_add', desc: 'set_group_add' },
    { action: 'join_group', desc: 'join_group' },
    { action: 'set_group_join', desc: 'set_group_join' },
    { action: 'group_join', desc: 'group_join' },
  ];

  for (var i = 0; i < apis.length; i++) {
    var item = apis[i];
    try {
      addLog('JOIN', 'Trying ' + item.desc + ' for group ' + groupId + '...');
      await callApi(item.action, { group_id: Number(groupId) });
      addLog('JOIN', 'SUCCESS via ' + item.desc + ' -> group ' + groupId);
      return true;
    } catch (e) {
      addLog('JOIN', item.desc + ' failed: ' + (e.message || '').substring(0, 80));
    }
  }

  addLog('ERROR', 'All join APIs failed! Group ' + groupId);
  return false;
}

// ==================== Spam loop ====================
async function spamRound() {
  if (!state.running) return;

  var cfg = config.bot;
  var gid = cfg.target_group_id;
  if (!gid) {
    addLog('ERROR', 'No target group selected');
    stopSpam();
    return;
  }

  var times = Math.floor(Math.random() * (cfg.max_times - cfg.min_times + 1)) + cfg.min_times;
  state.roundMsgsLeft = times;
  addLog('ROUND', 'Sending ' + times + ' msgs to group ' + gid);

  return new Promise(function (resolve) {
    state.timer = setInterval(async function () {
      if (!state.running || state.roundMsgsLeft <= 0) {
        clearInterval(state.timer);
        state.timer = null;
        if (!state.running) return resolve();

        if (config.bot.leave_rejoin) {
          // Mode A: leave + rejoin
          try { await leaveGroup(gid); } catch (e) { addLog('ERROR', 'Leave: ' + e.message); }

          setTimeout(async function () {
            if (!state.running) return resolve();
            var joined = await joinGroup(gid).catch(function () { return false; });
            if (!joined) {
              addLog('ERROR', 'Cannot rejoin, stopping. Turn off Leave & Rejoin mode.');
              stopSpam();
              return resolve();
            }
            setTimeout(function () {
              if (state.running) spamRound();
              resolve();
            }, 3000);
          }, 3000);
        } else {
          // Mode B: pause, stay in group
          var pauseSec = Math.floor(Math.random() * 5) + 3;
          addLog('PAUSE', 'Waiting ' + pauseSec + 's...');
          setTimeout(function () {
            if (state.running) spamRound();
            resolve();
          }, pauseSec * 1000);
        }
        return;
      }

      try {
        await sendGroupMsg(gid, cfg.message);
      } catch (e) {
        addLog('ERROR', 'Send: ' + e.message);
      }
      state.roundMsgsLeft--;
    }, cfg.interval_ms);
  });
}

function startSpam() {
  if (state.running) return;
  state.running = true;
  addLog('SYS', '===== STARTED =====');
  spamRound();
}

function stopSpam() {
  state.running = false;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  state.roundMsgsLeft = 0;
  addLog('SYS', '===== STOPPED =====');
}

// ==================== WebUI ====================
function sendJSON(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHTML(res, code, html) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  var pathname = req.url.split('?')[0];

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  // API: state
  if (pathname === '/api/state') {
    return sendJSON(res, 200, {
      running: state.running,
      groups: state.groups,
      config: config.bot,
      wsConnected: !!(state.wsConn && state.wsConn.readyState === WebSocket.OPEN),
      wsPort: config.ws.port,
      webuiPort: config.webui.port,
    });
  }

  // API: logs
  if (pathname === '/api/logs') {
    return sendJSON(res, 200, { logs: state.logs.slice(-100) });
  }

  // API: groups
  if (pathname === '/api/groups' && req.method === 'GET') {
    if (!state.wsConn || state.wsConn.readyState !== WebSocket.OPEN) {
      return sendJSON(res, 503, { error: 'OneBot not connected' });
    }
    getGroupList()
      .then(function (groups) { sendJSON(res, 200, { groups: groups }); })
      .catch(function (e) { sendJSON(res, 500, { error: e.message }); });
    return;
  }

  // API: start
  if (pathname === '/api/start' && req.method === 'POST') {
    if (!config.bot.target_group_id) {
      return sendJSON(res, 400, { error: 'No target group selected' });
    }
    startSpam();
    return sendJSON(res, 200, { ok: true });
  }

  // API: stop
  if (pathname === '/api/stop' && req.method === 'POST') {
    stopSpam();
    return sendJSON(res, 200, { ok: true });
  }

  // API: config
  if (pathname === '/api/config' && req.method === 'POST') {
    var body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      try {
        var d = JSON.parse(body);
        if (d.message !== undefined) config.bot.message = d.message;
        if (d.target_group_id !== undefined) config.bot.target_group_id = d.target_group_id;
        if (d.interval_ms !== undefined) config.bot.interval_ms = Number(d.interval_ms);
        if (d.min_times !== undefined) config.bot.min_times = Number(d.min_times);
        if (d.max_times !== undefined) config.bot.max_times = Number(d.max_times);
        if (d.leave_rejoin !== undefined) config.bot.leave_rejoin = !!d.leave_rejoin;
        if (d.wsPort !== undefined) config.ws.port = Number(d.wsPort);
        if (d.webuiPort !== undefined) config.webui.port = Number(d.webuiPort);
        saveConfig();
        sendJSON(res, 200, { ok: true });
      } catch (e) {
        sendJSON(res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // API: save ports
  if (pathname === '/api/save-config' && req.method === 'POST') {
    var b2 = '';
    req.on('data', function (c) { b2 += c; });
    req.on('end', function () {
      try {
        var d = JSON.parse(b2);
        if (d.wsPort) config.ws.port = Number(d.wsPort);
        if (d.webuiPort) config.webui.port = Number(d.webuiPort);
        saveConfig();
        sendJSON(res, 200, { ok: true, msg: 'Saved, restart to apply' });
      } catch (e) {
        sendJSON(res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // Default: serve HTML
  sendHTML(res, 200, PAGE_HTML);
}

function startWebUI() {
  var host = config.webui.host;
  var port = config.webui.port;
  var server = http.createServer(handleRequest);

  server.on('error', function (err) {
    console.error('WebUI error:', err.message);
  });

  server.listen(port, host, function () {
    addLog('WEBUI', 'Panel: http://' + host + ':' + port);
  });
}

// ==================== OneBot WS ====================
function setupWs(ws) {
  state.wsConn = ws;
  addLog('WS', 'OneBot connected (' + config.ws.mode + ' mode)');

  // 连上后自动获取群列表
  getGroupList().then(function (groups) {
    addLog('WS', 'Loaded ' + groups.length + ' groups');
  }).catch(function (e) {
    addLog('ERROR', 'Failed to load groups: ' + e.message);
  });

  ws.on('message', function (raw) {
    try { JSON.parse(raw.toString()); } catch (_) {}
  });

  ws.on('close', function () {
    addLog('WS', 'OneBot disconnected');
    if (state.wsConn === ws) state.wsConn = null;
    stopSpam();

    // Forward mode: auto-reconnect
    if (config.ws.mode === 'forward') {
      addLog('WS', 'Reconnecting in 3s...');
      setTimeout(startWsClient, 3000);
    }
  });

  ws.on('error', function (err) {
    addLog('ERROR', 'WS: ' + err.message);
  });
}

// Forward mode: connect to OneBot server
function startWsClient() {
  var url = config.ws.forward_url || 'ws://127.0.0.1:8099';
  addLog('WS', 'Connecting to ' + url + '...');

  var ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    addLog('ERROR', 'WS connect failed: ' + e.message);
    setTimeout(startWsClient, 5000);
    return;
  }

  ws.on('open', function () {
    setupWs(ws);
  });

  ws.on('error', function (err) {
    addLog('ERROR', 'WS connect error: ' + err.message);
  });

  ws.on('close', function () {
    // handled in setupWs
  });
}

// Reverse mode: wait for OneBot to connect to us
function startWsServer() {
  var wss = new WebSocket.Server({
    host: config.ws.host,
    port: config.ws.port,
  });

  wss.on('listening', function () {
    addLog('WS', 'Listening on ' + config.ws.host + ':' + config.ws.port);
    addLog('INFO', 'OneBot should connect to ws://127.0.0.1:' + config.ws.port + '/');
  });

  wss.on('error', function (err) {
    console.error('WS error:', err.message);
  });

  wss.on('connection', function (ws, req) {
    try {
      if (config.ws.access_token) {
        try {
          var u = new URL(req.url || '', 'http://localhost');
          var t = u.searchParams.get('access_token') || '';
          if (t !== config.ws.access_token) {
            addLog('WS', 'Auth failed');
            ws.close(4001, 'Auth failed');
            return;
          }
        } catch (_) {}
      }
      setupWs(ws);
    } catch (err) {
      addLog('ERROR', 'Connection setup error: ' + err.message);
      console.log(err.stack);
    }
  });
}

// ==================== HTML ====================
var PAGE_HTML = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>OneBot Spam Console</title>\n<style>\n*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}\nbody{font-family:"Microsoft YaHei",sans-serif;background:#1a1a2e;color:#eee;min-height:100vh}\n.header{background:#16213e;padding:16px 24px;border-bottom:2px solid #0f3460;display:flex;justify-content:space-between;align-items:center}\n.header h1{font-size:20px;color:#e94560}\n.status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}\n.on{background:#4ade80}.off{background:#ef4444}\n.container{max-width:960px;margin:0 auto;padding:20px}\n.card{background:#16213e;border-radius:10px;padding:20px;margin-bottom:16px;border:1px solid #0f3460}\n.card h3{font-size:16px;color:#e94560;margin-bottom:14px}\n.row{display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap;align-items:center}\n.row label{min-width:70px;line-height:36px;color:#aaa;font-size:13px}\ninput,select,textarea{background:#0f3460;border:1px solid #1a1a4e;color:#eee;padding:8px 12px;border-radius:6px;font-size:13px;outline:none}\ninput:focus,select:focus,textarea:focus{border-color:#e94560}\ntextarea{width:100%;resize:vertical;min-height:50px}\n.btn{padding:8px 20px;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:bold;transition:.2s}\n.btn:disabled{opacity:.4;cursor:not-allowed}\n.btn-start{background:#16a34a;color:#fff}.btn-start:hover:not(:disabled){background:#22c55e}\n.btn-stop{background:#dc2626;color:#fff}.btn-stop:hover:not(:disabled){background:#ef4444}\n.btn-info{background:#2563eb;color:#fff}.btn-info:hover:not(:disabled){background:#3b82f6}\n.btn-group{display:flex;gap:10px;margin-top:10px}\n.log-area{background:#0a0a1a;border-radius:6px;padding:12px;height:300px;overflow-y:auto;font-size:12px;font-family:Consolas,monospace;line-height:1.8;border:1px solid #0f3460;white-space:nowrap}\n.log-error{color:#ef4444}.log-warn{color:#f59e0b}.log-ok{color:#4ade80}\n.port-row{display:flex;gap:12px;align-items:end}\n.port-row label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#aaa}\n.port-row input{width:100px}\n</style>\n</head>\n<body>\n<div class="header">\n  <h1>OneBot v11 Spam Console</h1>\n  <div>\n    <span>WS:</span><span class="status-dot off" id="wsDot"></span>\n    <span id="wsStatus" style="font-size:13px">Not Connected</span>\n  </div>\n</div>\n<div class="container">\n  <div class="card">\n    <h3>Send Settings</h3>\n    <div class="row">\n      <label>Target Group:</label>\n      <select id="groupSelect" style="min-width:200px">\n        <option value="">-- Connect OneBot first --</option>\n      </select>\n      <button class="btn btn-info" onclick="refreshGroups()">Refresh</button>\n    </div>\n    <div class="row">\n      <label>Message:</label>\n      <textarea id="msgInput" placeholder="Enter message content"></textarea>\n    </div>\n    <div class="row">\n      <label>Interval(ms):</label>\n      <input id="intervalInput" type="number" value="1000" min="500" style="width:100px">\n      <label>Min:</label>\n      <input id="minTimesInput" type="number" value="1" min="1" style="width:80px">\n      <label>Max:</label>\n      <input id="maxTimesInput" type="number" value="5" min="1" style="width:80px">\n      <label style="margin-left:12px">\n        <input id="leaveRejoinInput" type="checkbox"> Leave & Rejoin\n      </label>\n    </div>\n    <div class="btn-group">\n      <button class="btn btn-start" id="btnStart" onclick="doStart()" disabled>Start</button>\n      <button class="btn btn-stop" id="btnStop" onclick="doStop()" disabled>Stop</button>\n      <button class="btn btn-info" onclick="saveSettings()">Save Settings</button>\n    </div>\n  </div>\n\n  <div class="card">\n    <h3>Port Config (restart to apply)</h3>\n    <div class="port-row">\n      <label>WebUI Port:<input id="webuiPortInput" type="number" value="3000"></label>\n      <label>WS Port:<input id="wsPortInput" type="number" value="3001"></label>\n      <button class="btn btn-info" onclick="savePorts()">Save Ports</button>\n    </div>\n  </div>\n\n  <div class="card">\n    <h3>Logs</h3>\n    <div class="log-area" id="logArea">Waiting for connection...</div>\n  </div>\n</div>\n\n<script>\nvar _pollTimer = null;\nfunction E(id){return document.getElementById(id)}\n\nasync function refreshGroups(){\n  try{\n    var r=await fetch("/api/groups");\n    var d=await r.json();\n    if(d.error){alert(d.error);return}\n    var sel=E("groupSelect");\n    sel.innerHTML=\'<option value="">-- Select Group --</option>\';\n    d.groups.forEach(function(g){\n      sel.innerHTML+=\'<option value="\'+g.group_id+\'">\'+g.group_name+\' (\'+g.group_id+\')</option>\';\n    });\n    var st=await (await fetch("/api/state")).json();\n    if(st.config.target_group_id) sel.value=st.config.target_group_id;\n  }catch(e){alert("Failed: "+e.message)}\n}\n\nasync function saveSettings(){\n  var body={\n    message: E("msgInput").value,\n    target_group_id: E("groupSelect").value,\n    interval_ms: Number(E("intervalInput").value),\n    min_times: Number(E("minTimesInput").value),\n    max_times: Number(E("maxTimesInput").value),\n    leave_rejoin: E("leaveRejoinInput").checked\n  };\n  await fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});\n}\n\nasync function savePorts(){\n  await fetch("/api/save-config",{method:"POST",headers:{"Content-Type":"application/json"},\n    body:JSON.stringify({wsPort:Number(E("wsPortInput").value),webuiPort:Number(E("webuiPortInput").value)})});\n  alert("Saved, restart to apply.");\n}\n\nasync function doStart(){\n  await saveSettings();\n  var r=await fetch("/api/start",{method:"POST"});\n  var d=await r.json();\n  if(d.error){alert(d.error);return}\n  E("btnStart").disabled=true;\n  E("btnStop").disabled=false;\n}\n\nasync function doStop(){\n  await fetch("/api/stop",{method:"POST"});\n  E("btnStart").disabled=false;\n  E("btnStop").disabled=true;\n}\n\nfunction buildLogHTML(logs){\n  var html="";\n  for(var i=0;i<logs.length;i++){\n    var l=logs[i];\n    var cls="";\n    if(l.indexOf("[ERROR]")>=0) cls="log-error";\n    else if(l.indexOf("[SYS]")>=0||l.indexOf("[ROUND]")>=0) cls="log-warn";\n    else if(l.indexOf("[SEND]")>=0||l.indexOf("[WS]")>=0||l.indexOf("[WEBUI]")>=0||l.indexOf("[PAUSE]")>=0) cls="log-ok";\n    html+=\'<span class="\'+cls+\'">\'+l.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")+\'</span><br>\';\n  }\n  return html||"Waiting...";\n}\n\nvar _firstPoll=true;\n\nasync function poll(){\n  try{\n    var st=await (await fetch("/api/state")).json();\n    E("wsDot").className="status-dot "+(st.wsConnected?"on":"off");\n    E("wsStatus").textContent=st.wsConnected?"Connected":"Not Connected";\n    E("btnStart").disabled=st.running||!st.wsConnected;\n    E("btnStop").disabled=!st.running;\n    E("msgInput").value=st.config.message||"";\n    if(st.config.target_group_id) E("groupSelect").value=st.config.target_group_id;\n    E("intervalInput").value=st.config.interval_ms||1000;\n    E("minTimesInput").value=st.config.min_times||1;\n    E("maxTimesInput").value=st.config.max_times||5;\n    if(_firstPoll){ E("leaveRejoinInput").checked=!!st.config.leave_rejoin; _firstPoll=false; }\n    E("webuiPortInput").value=st.webuiPort||3000;\n    E("wsPortInput").value=st.wsPort||3001;\n    if(st.groups.length>0 && E("groupSelect").options.length<=1){\n      var sel=E("groupSelect");\n      sel.innerHTML=\'<option value="">-- Select Group --</option>\';\n      st.groups.forEach(function(g){\n        sel.innerHTML+=\'<option value="\'+g.group_id+\'">\'+g.group_name+\' (\'+g.group_id+\')</option>\';\n      });\n      if(st.config.target_group_id) sel.value=st.config.target_group_id;\n    }\n    var logData=await (await fetch("/api/logs")).json();\n    var logArea=E("logArea");\n    logArea.innerHTML=buildLogHTML(logData.logs);\n    logArea.scrollTop=logArea.scrollHeight;\n  }catch(e){console.error(e)}\n}\n\n_pollTimer=setInterval(poll,1500);\npoll();\n</script>\n</body>\n</html>';

// ==================== Start ====================
// Global error handlers
process.on('uncaughtException', function (err) {
  console.log('[FATAL]', err.message);
  console.log(err.stack);
});
process.on('unhandledRejection', function (reason) {
  console.log('[REJECTION]', reason);
});

console.log('========================================');
console.log('  OneBot v11 Spam Bot v1.0');
console.log('  QQ / NapCat / LLOneBot');
console.log('========================================');
console.log('');

startWebUI();

if (config.ws.mode === 'forward') {
  startWsClient();
} else {
  startWsServer();
}

process.on('SIGINT', function () {
  stopSpam();
  console.log('Exited.');
  process.exit(0);
});
