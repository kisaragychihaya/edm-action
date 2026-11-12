#!/usr/bin/env node
// edm-token — 阿里云盘企业版(CDE/EDM) token 获取 CLI
// 流程逆向自"企业文件管理" Electron 客户端(壳) + pds-auth-ui 0.43.0。
// 零依赖,Node >= 18。
//
// 用法:
//   node edm-token.mjs login sms --domain <domain_id> --phone 13800138000
//   node edm-token.mjs login browser --domain <domain_id>
//   node edm-token.mjs refresh [--domain <domain_id>] [--refresh-token xxx]
//   node edm-token.mjs from-client
//   node edm-token.mjs whoami
//
// 全局参数: --state <path> (默认 ~/.edm-token.json), --json (只输出 JSON)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

// ---------- 常量 ----------
const DEFAULT_CLIENT_ID = 'EdmpX4opdRNI9feB';           // pds-auth-ui / EDM 公共 client
const DEFAULT_REDIRECT_URI = 'https://web-sv.aliyunpds.com/aliyunfile_callback';
const SV_ENDPOINT = 'https://web-sv.aliyunpds.com';      // 用于 endpoint 发现
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) edm-token-cli/1.0';

// ---------- 小工具 ----------
function die(msg, code = 1) { console.error(`错误: ${msg}`); process.exit(code); }
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) args[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[a.slice(2)] = argv[++i];
      else args[a.slice(2)] = true;
    } else args._.push(a);
  }
  return args;
}
function statePath(args) {
  return args.state || path.join(os.homedir(), '.edm-token.json');
}
function loadState(args) {
  try { return JSON.parse(fs.readFileSync(statePath(args), 'utf8')); } catch { return null; }
}
function saveState(args, token) {
  const p = statePath(args);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(token, null, 2), { mode: 0o600 });
  console.error(`已保存: ${p}`);
}
async function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const v = await new Promise((res) => rl.question(q, res));
  rl.close();
  return v.trim();
}

// ---------- HTTP ----------
async function http(method, url, { body, form, headers = {}, cookies } = {}) {
  const h = { 'User-Agent': UA, ...headers };
  if (cookies) h.Cookie = cookies;
  let payload;
  if (form) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers: h, body: payload, redirect: 'manual' });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html etc. */ }
  return { status: res.status, json, text, cookies: setCookie.map((c) => c.split(';')[0]).join('; ') };
}

// ---------- 端点发现 ----------
async function discoverEndpoints(domainId) {
  const res = await http('POST', `${SV_ENDPOINT}/endpoint/get_endpoints`, { body: { domain_id: domainId, is_vpc: false } });
  const d = res.json;
  if (!d || !d.api_endpoint) die(`endpoint 发现失败(domain=${domainId}): ${res.text.slice(0, 200)}`);
  return d; // { auth_endpoint, api_endpoint, ui_endpoint, client_id, redirect_uri }
}

// ---------- OAuth ----------
// 授权码换 token — 与 Web 端一致走 web-sv 网关 (抓包自 pds-home-ui 0.41.0)
async function exchangeCode(ep, code, domainId) {
  const res = await http('POST', `${SV_ENDPOINT}/get_token`, {
    body: {
      product_type: 'edm',
      code,
      domain_id: domainId,
      client_id: ep.client_id || DEFAULT_CLIENT_ID,
      redirect_uri: ep.redirect_uri || DEFAULT_REDIRECT_URI,
    },
  });
  if (!res.json || !res.json.access_token) die(`换 token 失败: ${res.text.slice(0, 300)}`);
  return res.json;
}

async function refreshToken(ep, refreshToken) {
  // 抓包实证: 刷新走 {auth_endpoint}/v2/account/token (JSON), 且 refresh_token 每次轮换
  const res = await http('POST', `${ep.auth_endpoint}/v2/account/token`, {
    body: { app_id: ep.client_id || DEFAULT_CLIENT_ID, refresh_token: refreshToken, grant_type: 'refresh_token' },
  });
  if (!res.json || !res.json.access_token) die(`刷新失败(refresh_token 可能已失效): ${res.text.slice(0, 300)}`);
  return res.json;
}

function normalizeToken(t, domainId) {
  const expMs = t.expire_time ? Date.parse(t.expire_time) : Date.now() + (t.expires_in || 7200) * 1000;
  return {
    domain_id: t.domain_id || domainId,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    token_type: t.token_type || 'Bearer',
    expires_in: t.expires_in || 7200,
    expire_time: new Date(expMs).toISOString(),
    user_id: t.user_id,
    user_name: t.user_name,
    nick_name: t.nick_name,
    role: t.role,
    device_id: t.device_id,
  };
}

// ---------- 登录:短信验证码 ----------
async function loginSms(args) {
  // 抓包结论: 短信/邮箱直登接口(login.aliyunfile.com/v2/account/send_sms|signin)强制要求
  // 阿里云验证码 2.0 的 captcha_param(服务端报 InvalidParameterMissing.NvcParam), 纯 CLI 无法通过。
  // 但浏览器登录页里仍是"手机号+短信验证码", 用户操作一样, 只是验证码环节在浏览器里完成。
  console.error('说明: 短信直登接口强制要求阿里云滑块验证码(nvc_param/captcha_param), CLI 无法自动通过。');
  console.error('      请在接下来打开的浏览器页面里完成滑块+短信验证(与网页版登录相同)。\n');
  return loginBrowser(args);
}

// ---------- 登录:浏览器 ----------
// 自动模式: CLI 以远程调试端口拉起独立浏览器实例, 用户完成登录后,
// 通过 CDP 直接在网盘页面 localStorage 里读取 token(与客户端同一套 Web 应用)。
// 找不到浏览器或失败时回退到手动粘贴。
import { spawn, execSync } from 'node:child_process';

const LOGIN_URL = `https://login.aliyunfile.com/v2/oauth/authorize?client_id=${DEFAULT_CLIENT_ID}&response_type=code&state=&hide_consent=true`;

function findBrowser() {
  const candidates = [
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['ProgramFiles'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['ProgramFiles'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

// 从任意跳转中的 URL 提取 code (含 login_callback 里嵌套编码的 url)
function extractCode(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const direct = u.searchParams.get('code');
    if (direct) return { code: direct, domain_id: u.searchParams.get('domain_id') };
    const nested = u.searchParams.get('url');
    if (nested) return extractCode(nested); // login_callback?url=<编码后的token页URL>
  } catch { /* ignore */ }
  return null;
}

// 通过 CDP websocket 在页面里执行 JS (Node >= 21 内置 WebSocket)
async function cdpEval(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP eval 超时')), 15000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        if (msg.id === 1) { clearTimeout(timer); resolve(msg); }
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP websocket 错误')); };
    });
  } finally { try { ws.close(); } catch { /* ignore */ } }
}

// 登录完成后, 网盘页面 localStorage 里必有 token(与客户端同一套 Web 应用)
const LS_SCAN = `(() => {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const v = localStorage.getItem(k);
    if (v && v.includes('access_token')) return v;
  }
  return null;
})()`;

async function cdpWaitToken(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { headers: { Host: 'localhost' } });
      const targets = await res.json();
      for (const t of targets) {
        if (t.type !== 'page' || !t.url) continue;
        // 只关心企业网盘域的页面(登录完成后落地的页面)
        if (!/apps\.aliyunfile\.com|aliyunpds\.com/.test(t.url)) continue;
        const r = await cdpEval(t.webSocketDebuggerUrl, LS_SCAN);
        const v = r?.result?.result?.value;
        if (v) {
          const token = JSON.parse(v);
          if (token.access_token) return token;
        }
      }
    } catch { /* 页面还没就绪 */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('等待超时(5 分钟), 未完成登录或页面里没有 token');
}

// Edge/Chrome 的启动器进程会立即退出, 不能靠 proc.kill 关浏览器;
// 按临时 profile 目录名在命令行里匹配, 结束整棵进程树
function killBrowserTree(profileDir) {
  const marker = path.basename(profileDir);
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
      { stdio: 'ignore', timeout: 15000 },
    );
  } catch { /* 关不掉就留着, 用户手动关 */ }
}

async function loginBrowser(args) {
  console.error('登录链接(自动模式):\n');
  console.log(LOGIN_URL);
  const browser = findBrowser();
  let token = null;
  const port = 9222 + Math.floor(Math.random() * 500);
  const profile = path.join(os.tmpdir(), `edm-login-profile-${Date.now()}`);
  if (browser && !args.manual) {
    console.error('\n正在拉起浏览器, 请在弹出的窗口里完成登录(滑块+短信)。\n登录成功后 CLI 会自动从页面读取 token, 无需复制 URL。');
    try {
      const proc = spawn(browser, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check',
        LOGIN_URL,
      ], { stdio: 'ignore' });
      proc.on('error', () => { /* 拉起失败会在超时后回退 */ });
      const raw = await cdpWaitToken(port, 5 * 60 * 1000);
      token = normalizeToken(raw, raw.domain_id);
    } catch (e) {
      console.error(`自动获取失败(${e.message}), 请改用手动模式`);
      token = null;
    } finally {
      killBrowserTree(profile);
    }
  } else {
    console.error('\n未找到 Chrome/Edge, 或指定了 --manual。');
  }
  if (!token) {
    console.error('请手动在浏览器打开上面的链接完成登录, 在地址栏跳转过程中按 Esc 暂停, 复制带 code= 的 URL');
    const pasted = await prompt('\n粘贴带 code 的完整 URL: ');
    const hit = extractCode(pasted);
    if (!hit?.code) die('URL 里没有 code 参数');
    const domain = args.domain || hit.domain_id;
    if (!domain) die('没有 domain_id, 请用 --domain 指定(如 <domain_id>)');
    const raw = await exchangeCode({}, hit.code, domain);
    token = normalizeToken(raw, domain);
  }
  return token;
}

// ---------- 刷新 ----------
async function doRefresh(args) {
  const st = loadState(args);
  const refresh = args['refresh-token'] || st?.refresh_token;
  if (!refresh) die('没有 refresh_token(先 login, 或用 --refresh-token 指定)');
  const domain = args.domain || st?.domain_id || (await prompt('企业代码 domain_id: '));
  const ep = await discoverEndpoints(domain);
  const raw = await refreshToken(ep, refresh);
  return normalizeToken(raw, domain);
}

// ---------- 从本机客户端提取 ----------
async function fromClient(args) {
  const logFile = path.join(process.env.APPDATA || '', 'edm', 'Local Storage', 'leveldb', '000003.log');
  if (!fs.existsSync(logFile)) die(`未找到客户端 localStorage: ${logFile}`);
  const b = fs.readFileSync(logFile);
  const needle = Buffer.from('eyJhbGciOi', 'utf16le');
  const idx = b.indexOf(needle);
  if (idx === -1) die('localStorage 里没找到 token(客户端未登录?)');
  const open = Buffer.from('{"', 'utf16le');
  let js = -1;
  for (let i = idx; i > 0; i -= 2) if (b.slice(i, i + 4).equals(open)) { js = i; break; }
  const raw = b.slice(js).toString('utf16le');
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  const t = JSON.parse(raw.slice(0, end));
  if (!t.access_token) die('解析出的 JSON 里没有 access_token');
  console.error('提示: 此 token 与桌面客户端会话共享, 刷新 refresh_token 可能导致客户端被登出; 建议优先用 login 独立获取。');
  return normalizeToken(t, t.domain_id);
}

// ---------- whoami ----------
async function whoami(args) {
  const st = loadState(args);
  if (!st?.access_token) die('没有已保存的 token');
  const p = JSON.parse(Buffer.from(st.access_token.split('.')[1], 'base64url').toString());
  const exp = new Date(p.exp * 1000);
  const left = Math.round((exp - Date.now()) / 1000);
  const out = { domain_id: st.domain_id, user_id: p.userId, user_name: st.user_name, expire_time: exp.toISOString(), expired: left <= 0, seconds_left: left };
  console.log(args.json ? JSON.stringify(out) : `domain: ${out.domain_id}\nuser:   ${out.user_name || out.user_id}\n过期:   ${out.expire_time} (${left > 0 ? `剩 ${left}s` : '已过期'})`);
}

// ---------- main ----------
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  let token = null;

  if (cmd === 'login') {
    const mode = args._[0] || 'sms';
    token = mode === 'browser' ? await loginBrowser(args) : await loginSms(args);
    saveState(args, token);
  } else if (cmd === 'refresh') {
    token = await doRefresh(args);
    saveState(args, token);
    console.error('注意: refresh_token 每次刷新都会轮换, GitHub Secret 里的旧值已作废, 请更新!');
  } else if (cmd === 'from-client') {
    token = await fromClient(args);
    saveState(args, token);
  } else if (cmd === 'whoami') {
    await whoami(args);
    return;
  } else {
    console.log(`用法:
  node edm-token.mjs login [sms]            手机号+短信验证码登录(浏览器里完成滑块+短信, 推荐)
  node edm-token.mjs login browser          同上, 直接走浏览器流程
  node edm-token.mjs refresh [--refresh-token <rt>]   刷新 token(会轮换 refresh_token!)
  node edm-token.mjs from-client            从本机 EDM 客户端提取当前 token
  node edm-token.mjs whoami                 查看已存 token 状态
通用: --state <path> 指定存储路径(默认 ~/.edm-token.json), login browser 支持 --domain`);
    process.exit(cmd ? 1 : 0);
  }

  if (token) {
    console.log(args.json ? JSON.stringify(token) : JSON.stringify(token, null, 2));
    console.error('\n下一步: 把 refresh_token(或整个 JSON)存到 GitHub Secret, 例如:\n  gh secret set EDM_TOKEN --repo <owner>/<repo>   # 粘贴上面 JSON 后按 Ctrl+D\nAction 里: token: ${{ secrets.EDM_TOKEN }}');
  }
}

main().catch((e) => die(e.stack || String(e)));
