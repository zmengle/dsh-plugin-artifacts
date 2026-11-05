/**
 * cos.js 的离线自测：起一个本地 node:http mock server，完全不联网。
 *
 * 关键设计：mock 端「独立复算」签名（不调用 cos.js 的 buildAuthorization），
 * 而是拿真实收到的请求行 + 请求头，按 COS 文档口径重新拼 httpString 再验签。
 * 这样能真正验证三件事：
 *   1) 签名拼接顺序 / 编码规则是对的（包括中文、空格、& 这类字符）；
 *   2) 实际发出的路径是「按 / 分段百分号编码」，而签名用的是解码后的路径；
 *   3) q-header-list 里列的头确实都发出去了，q-url-param-list 与实际 query 一致。
 *
 * 用法：node cos.selftest.mjs   （退出码 0=全过，1=有失败）
 */

import http from 'node:http';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createCosClient, CosError, __internals } from './cos.js';

/* ------------------------------------------------------------------ *
 * 固定配置
 * ------------------------------------------------------------------ */
const SECRET_ID = 'AKIDEXAMPLEforSELFTEST0000000000';
const SECRET_KEY = 'SECRETKEYEXAMPLEforSELFTEST0123456789';
const BUCKET = 'demo-1250000000';
const REGION = 'ap-guangzhou';
const COS_HOST = `${BUCKET}.cos.${REGION}.myqcloud.com`;
const PREFIX = 'dsh/';

/* ------------------------------------------------------------------ *
 * mock 端自己的编码 / 验签实现（刻意不复用 cos.js）
 * ------------------------------------------------------------------ */
function camEncode(value) {
  return encodeURIComponent(String(value === undefined || value === null ? '' : value))
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function decodePath(pathname) {
  return String(pathname)
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment; // 非法转义就原样返回，别让 mock 直接崩
      }
    })
    .join('/');
}

function md5Hex(buffer) {
  return createHash('md5').update(buffer).digest('hex');
}

function isSortedAsc(list) {
  for (let i = 1; i < list.length; i += 1) {
    if (list[i - 1] > list[i]) return false;
  }
  return true;
}

/**
 * 按 COS 文档口径验签。
 * @returns {{ok: boolean, reason?: string, headerNames?: string[], paramNames?: string[], decodedPath?: string}}
 */
function verifySignature(req) {
  const rawAuth = req.headers.authorization || '';
  if (!rawAuth) return { ok: false, reason: '缺少 Authorization 请求头' };

  // Authorization 是 k=v&k=v 形式；只在第一个 '=' 处切分（签名值里没有 '=', 但不能假设）
  const fields = {};
  for (const part of rawAuth.split('&')) {
    const index = part.indexOf('=');
    if (index < 0) return { ok: false, reason: `Authorization 片段非法: ${part}` };
    fields[part.slice(0, index)] = part.slice(index + 1);
  }

  const required = [
    'q-sign-algorithm', 'q-ak', 'q-sign-time', 'q-key-time',
    'q-header-list', 'q-url-param-list', 'q-signature',
  ];
  for (const name of required) {
    if (!(name in fields)) return { ok: false, reason: `Authorization 缺少 ${name}` };
  }
  if (fields['q-sign-algorithm'] !== 'sha1') return { ok: false, reason: 'q-sign-algorithm 必须是 sha1' };
  if (fields['q-ak'] !== SECRET_ID) return { ok: false, reason: 'q-ak 与 secretId 不一致' };

  // keyTime 必须是 "start;end"，且当前时间落在窗口内（允许 60s 时钟偏移）
  const keyTime = fields['q-key-time'];
  const [startText, endText] = keyTime.split(';');
  const startSec = Number(startText);
  const endSec = Number(endText);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    return { ok: false, reason: `q-key-time 格式错误: ${keyTime}` };
  }
  if (fields['q-sign-time'] !== keyTime) {
    return { ok: false, reason: 'q-sign-time 与 q-key-time 不一致' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec < startSec - 60 || nowSec > endSec + 60) {
    return { ok: false, reason: `签名不在有效期内: ${keyTime}` };
  }

  const headerNames = fields['q-header-list'].split(';').filter(Boolean);
  const paramNames = fields['q-url-param-list'].split(';').filter(Boolean);

  if (!isSortedAsc(headerNames)) return { ok: false, reason: 'q-header-list 未按字典序排列' };
  if (!isSortedAsc(paramNames)) return { ok: false, reason: 'q-url-param-list 未按字典序排列' };
  if (headerNames.some((name) => name !== name.toLowerCase())) {
    return { ok: false, reason: 'q-header-list 里出现大写头名' };
  }
  if (!headerNames.includes('host')) return { ok: false, reason: 'q-header-list 必须包含 host' };

  // 参与签名的头必须真的发出去了（否则服务端算出来的 httpString 会和客户端不一致）
  const headerMap = new Map();
  for (const name of headerNames) {
    const value = req.headers[name];
    if (value === undefined) return { ok: false, reason: `q-header-list 里的 ${name} 没有真正发出` };
    headerMap.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }

  // query：URLSearchParams 会解码，这里再按 COS 规则重新编码，与服务端口径一致
  const url = new URL(req.url, 'http://mock.local');
  const queryMap = new Map();
  for (const [name, value] of url.searchParams) {
    queryMap.set(camEncode(name).toLowerCase(), value);
  }
  const missingParams = paramNames.filter((name) => !queryMap.has(name));
  const extraParams = [...queryMap.keys()].filter((name) => !paramNames.includes(name));
  if (missingParams.length || extraParams.length) {
    return {
      ok: false,
      reason: `q-url-param-list 与实际 query 不一致（缺少=[${missingParams}] 多出=[${extraParams}]）`,
    };
  }

  const decodedPath = decodePath(url.pathname);
  const paramString = paramNames.map((name) => `${name}=${camEncode(queryMap.get(name))}`).join('&');
  const headerString = headerNames.map((name) => `${name}=${camEncode(headerMap.get(name))}`).join('&');

  // method + \n + path + \n + params + \n + headers + \n
  const httpString = `${req.method.toLowerCase()}\n${decodedPath}\n${paramString}\n${headerString}\n`;
  const httpStringSha1 = createHash('sha1').update(httpString, 'utf8').digest('hex');
  const stringToSign = `sha1\n${keyTime}\n${httpStringSha1}\n`;
  const signKey = createHmac('sha1', SECRET_KEY).update(keyTime, 'utf8').digest('hex');
  const expected = createHmac('sha1', signKey).update(stringToSign, 'utf8').digest('hex');

  if (expected !== fields['q-signature']) {
    return {
      ok: false,
      reason: `签名不匹配：期望 ${expected}，收到 ${fields['q-signature']}\nhttpString=${JSON.stringify(httpString)}`,
    };
  }

  return { ok: true, headerNames, paramNames, decodedPath };
}

/* ------------------------------------------------------------------ *
 * mock 服务端
 * ------------------------------------------------------------------ */
const state = {
  store: new Map(), // key -> { body: Buffer, etag, contentType, meta: {}, lastModified }
  hits: new Map(),  // key -> 请求次数
  log: [],          // 每个请求一条 { method, url, auth, headers, verified }
};

function lastModifiedIso() {
  return '2026-01-02T03:04:05.000Z';
}

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sendXmlError(res, status, code, message, extraTags = '') {
  const body = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Error>\n'
    + `  <Code>${code}</Code>\n`
    + `  <Message>${xmlEscape(message)}</Message>\n`
    + '  <RequestId>mock-request-id-0001</RequestId>\n'
    + extraTags
    + '</Error>\n';
  res.writeHead(status, {
    'content-type': 'application/xml',
    'content-length': String(Buffer.byteLength(body)),
    'x-cos-request-id': 'mock-request-id-0001',
  });
  res.end(body); // HEAD 请求时 Node 会自动丢弃 body，只保留头
}

/** 分页列表：每次最多 2 条，还有剩余时给 NextMarker（marker 里带 & 以覆盖实体还原） */
function buildListXml(prefix, marker) {
  const allKeys = [...state.store.keys()].filter((key) => key.startsWith(prefix)).sort();
  const candidates = marker ? allKeys.filter((key) => key > marker) : allKeys;
  const pageSize = 2;
  const page = candidates.slice(0, pageSize);
  const hasMore = candidates.length > pageSize;

  const contents = page.map((key) => {
    const item = state.store.get(key);
    return '  <Contents>\n'
      + `    <Key>${xmlEscape(key)}</Key>\n`
      + `    <LastModified>${item.lastModified}</LastModified>\n`
      + `    <ETag>${xmlEscape(`"${item.etag}"`)}</ETag>\n`
      + `    <Size>${item.body.length}</Size>\n`
      + '    <StorageClass>STANDARD</StorageClass>\n'
      + '  </Contents>\n';
  }).join('');

  const nextMarker = hasMore ? page[page.length - 1] : undefined;
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<ListBucketResult>\n'
    + '  <Name>demo-1250000000</Name>\n'
    + `  <Prefix>${xmlEscape(prefix)}</Prefix>\n`
    + `  <Marker>${xmlEscape(marker || '')}</Marker>\n`
    + `  <MaxKeys>${pageSize}</MaxKeys>\n`
    + (hasMore ? '  <IsTruncated>true</IsTruncated>\n' : '  <IsTruncated>false</IsTruncated>\n')
    + contents
    + (nextMarker ? `  <NextMarker>${xmlEscape(nextMarker)}</NextMarker>\n` : '')
    + '</ListBucketResult>\n';
}

function handleRequest(req, res, body) {
  const entry = { method: req.method, url: req.url, auth: req.headers.authorization || '', headers: req.headers };
  state.log.push(entry);

  const verification = verifySignature(req);
  entry.verified = verification.ok;
  if (!verification.ok) {
    entry.verifyError = verification.reason;
    console.log(`   [mock] 验签失败 ${req.method} ${req.url}: ${verification.reason}`);
    sendXmlError(res, 403, 'SignatureDoesNotMatch', verification.reason);
    return;
  }

  const url = new URL(req.url, 'http://mock.local');
  const decodedPath = decodePath(url.pathname);
  const objectKey = decodedPath.replace(/^\/+/, '');
  if (objectKey) state.hits.set(objectKey, (state.hits.get(objectKey) || 0) + 1);

  // 故障注入路由（先于正常逻辑，标题里写清楚用途）
  if (objectKey === 'dsh/__403') {
    sendXmlError(res, 403, 'AccessDenied', 'Access Denied.', `  <Resource>${COS_HOST}</Resource>\n`);
    return;
  }
  if (objectKey === 'dsh/__500') {
    sendXmlError(res, 500, 'InternalError', 'We encountered an internal error. Please try again.');
    return;
  }
  if (objectKey === 'dsh/__flaky') {
    // 前两次故意 500，第三次成功 —— 用来验证"5xx 自动重试 2 次"
    if ((state.hits.get(objectKey) || 0) <= 2) {
      sendXmlError(res, 500, 'InternalError', 'flaky upstream');
      return;
    }
  }
  if (objectKey === 'dsh/__timeout') {
    return; // 故意不响应，让客户端超时
  }

  const isBucketLevel = objectKey === '';

  if (isBucketLevel) {
    if (req.method === 'HEAD') {
      // headBucket：200 + 空体
      res.writeHead(200, { 'x-cos-request-id': 'mock-request-id-0001' });
      res.end();
      return;
    }
    if (req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') || '';
      const marker = url.searchParams.get('marker') || '';
      const xml = buildListXml(prefix, marker);
      res.writeHead(200, {
        'content-type': 'application/xml',
        'content-length': String(Buffer.byteLength(xml)),
        'x-cos-request-id': 'mock-request-id-0001',
      });
      res.end(xml);
      return;
    }
    sendXmlError(res, 405, 'MethodNotAllowed', `unsupported method ${req.method}`);
    return;
  }

  const existing = state.store.get(objectKey);

  if (req.method === 'PUT') {
    const contentType = req.headers['content-type'] || 'application/octet-stream';
    const meta = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.toLowerCase().startsWith('x-cos-meta-')) {
        meta[name.toLowerCase().slice('x-cos-meta-'.length)] = String(value);
      }
    }
    const etag = md5Hex(body);
    state.store.set(objectKey, { body, etag, contentType, meta, lastModified: lastModifiedIso() });
    res.writeHead(200, {
      ETag: `"${etag}"`,
      'x-cos-request-id': 'mock-request-id-0001',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!existing) {
      sendXmlError(res, 404, 'NoSuchKey', 'The specified key does not exist.',
        `  <Key>${xmlEscape(objectKey)}</Key>\n  <Resource>${COS_HOST}/${xmlEscape(objectKey)}</Resource>\n`);
      return;
    }
    const headers = {
      ETag: `"${existing.etag}"`,
      'content-type': existing.contentType,
      'content-length': String(existing.body.length),
      'last-modified': 'Fri, 02 Jan 2026 03:04:05 GMT',
      'x-cos-request-id': 'mock-request-id-0001',
    };
    for (const [name, value] of Object.entries(existing.meta)) {
      headers[`x-cos-meta-${name}`] = value;
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : existing.body);
    return;
  }

  if (req.method === 'DELETE') {
    state.store.delete(objectKey);
    res.writeHead(204, { 'x-cos-request-id': 'mock-request-id-0001' });
    res.end();
    return;
  }

  sendXmlError(res, 405, 'MethodNotAllowed', `unsupported method ${req.method}`);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  req.on('end', () => handleRequest(req, res, Buffer.concat(chunks)));
});

/* ------------------------------------------------------------------ *
 * 测试框架（手搓，避免引第三方）
 * ------------------------------------------------------------------ */
const results = { pass: 0, fail: 0 };

async function check(name, fn) {
  try {
    const extra = await fn();
    results.pass += 1;
    console.log(`  [ok]   ${name}${typeof extra === 'string' && extra ? `  (${extra})` : ''}`);
  } catch (err) {
    results.fail += 1;
    console.log(`  [FAIL] ${name}`);
    const text = err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n         ') : String(err);
    console.log(`         ${text}`);
  }
}

/** 断言某次调用抛出指定 code 的 CosError，并把错误交给回调做进一步检查。 */
async function expectCosError(fn, expectedCode) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof CosError, `期望 CosError，实际是 ${err && err.constructor && err.constructor.name}`);
    assert.equal(err.code, expectedCode, `期望 code=${expectedCode}，实际 ${err.code}：${err.message}`);
    return err;
  }
  throw new Error(`期望抛出 ${expectedCode}，但调用成功了`);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`mock COS server: http://127.0.0.1:${port}  (Host 头仍为 ${COS_HOST})\n`);

  const client = createCosClient({
    secretId: SECRET_ID,
    secretKey: SECRET_KEY,
    bucket: BUCKET,
    region: REGION,
    prefix: PREFIX,
    timeoutMs: 1500,
    connectHost: '127.0.0.1',
    connectPort: port,
    protocol: 'http',
  });

  // ---------- 1. 纯函数：编码规则 ----------
  console.log('编码 / 签名拼接（单元级）');

  await check('cosEncode 按 COS 口径转义 ! \' ( ) * ，空格 → %20，~ 保留', () => {
    assert.equal(__internals.cosEncode("a b/c!d'e(f)g*h~中"), 'a%20b%2Fc%21d%27e%28f%29g%2Ah~%E4%B8%AD');
    assert.equal(__internals.cosEncode('text/plain'), 'text%2Fplain');
    assert.equal(__internals.cosEncode('a+b'), 'a%2Bb'); // '+' 也必须编码，否则服务端会当空格
  });

  await check('encodeKeyPath 保留 / 作为层级分隔符，逐段编码', () => {
    assert.equal(__internals.encodeKeyPath('dsh/测试 文件/报告 v1.md'), 'dsh/%E6%B5%8B%E8%AF%95%20%E6%96%87%E4%BB%B6/%E6%8A%A5%E5%91%8A%20v1.md');
    assert.equal(__internals.encodeKeyPath('a/b'), 'a/b'); // 斜杠本身不动
    assert.equal(__internals.encodeKeyPath('/dsh/x'), 'dsh/x'); // 前导 / 被归一化掉
  });

  await check('buildAuthorization 的 httpString 是「四段 + 结尾换行」，且头/参数字典序', () => {
    const auth = __internals.buildAuthorization({
      secretId: SECRET_ID,
      secretKey: SECRET_KEY,
      method: 'put',
      pathname: '/dsh/测试 文件/报告 v1.md',
      query: { prefix: 'dsh/', B: '2', a: '1' },
      headers: { host: COS_HOST, 'content-type': 'text/plain', 'content-length': '3' },
      nowMs: 1767225600000,
    });
    const lines = auth.httpString.split('\n');
    assert.equal(lines.length, 5, 'httpString 应为 5 段（最后一段为空）');
    assert.ok(auth.httpString.endsWith('\n'), 'httpString 必须以换行结尾');
    assert.equal(lines[0], 'put');
    assert.equal(lines[1], '/dsh/测试 文件/报告 v1.md'); // 路径不参与百分号编码
    assert.equal(lines[2], 'a=1&b=2&prefix=dsh%2F'); // 参数名小写 + 值编码 + 字典序
    assert.equal(lines[3], 'content-length=3&content-type=text%2Fplain&host=' + COS_HOST);
    assert.equal(auth.keyTime, '1767225600;1767229200'); // now;now+3600
    assert.equal(auth.paramList, 'a;b;prefix');
    assert.equal(auth.headerList, 'content-length;content-type;host');
  });

  // ---------- 2. test() ----------
  console.log('\n基础 CRUD');

  await check('test(): headBucket → put → head → delete，并返回桶信息', async () => {
    const info = await client.test();
    assert.equal(info.bucket, BUCKET);
    assert.equal(info.region, REGION);
    assert.equal(typeof info.elapsedMs, 'number');
    assert.ok(info.elapsedMs >= 0 && info.elapsedMs < 60000, `elapsedMs 异常: ${info.elapsedMs}`);
    assert.equal(state.store.has(`${PREFIX}_probe`), false, '探针对象应被清理');
    return `${info.elapsedMs}ms`;
  });

  await check('put/get/head：字符串上传 → 读回、size/etag 正确', async () => {
    const content = 'hello cos 你好\n第二行';
    const putResult = await client.put('dsh/plain.txt', content, { contentType: 'text/plain; charset=utf-8' });
    assert.equal(putResult.size, Buffer.byteLength(content, 'utf8'));
    assert.match(putResult.etag, /^[0-9a-f]{32}$/, `etag 应是 md5 十六进制: ${putResult.etag}`);

    const buffer = await client.get('dsh/plain.txt');
    assert.ok(Buffer.isBuffer(buffer), 'get 必须返回 Buffer');
    assert.equal(buffer.toString('utf8'), content);

    const info = await client.head('dsh/plain.txt');
    assert.ok(info, 'head 不应返回 null');
    assert.equal(info.size, Buffer.byteLength(content, 'utf8'));
    assert.equal(info.etag, putResult.etag);
    assert.deepEqual(info.meta, {});
    return `etag=${putResult.etag.slice(0, 8)}…`;
  });

  await check('put(Buffer) + sha256 元数据 → head 能读回 x-cos-meta-sha256，且该头进了签名', async () => {
    const payload = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f]);
    const sha = createHash('sha256').update(payload).digest('hex');
    const putResult = await client.put('dsh/binary.bin', payload, {
      contentType: 'application/octet-stream',
      sha256: sha,
    });
    assert.equal(putResult.size, 5);

    const info = await client.head('dsh/binary.bin');
    assert.ok(info);
    assert.equal(info.size, 5);
    assert.equal(info.meta.sha256, sha);

    // 该请求的 q-header-list 应含 x-cos-meta-sha256
    const entry = [...state.log].reverse().find((item) => item.method === 'PUT' && item.verified);
    const headerList = entry.auth.match(/q-header-list=([^&]*)/)[1];
    assert.ok(headerList.split(';').includes('x-cos-meta-sha256'), `header-list=${headerList}`);
    // 且它确实被发出去了（验签逻辑里已检查，这里再确认一次）
    assert.equal(entry.headers['x-cos-meta-sha256'], sha);
    return headerList;
  });

  // ---------- 3. 中文 / 空格 / 特殊字符 key ----------
  console.log('\n特殊字符 key');

  const trickyKey = 'dsh/测试 文件/报告 v1.md';
  await check('中文 + 空格 key：put/get/head/remove 全链路', async () => {
    const content = '# 报告\n正文 with space';
    await client.put(trickyKey, content, { contentType: 'text/markdown' });
    assert.equal((await client.get(trickyKey)).toString('utf8'), content);

    const info = await client.head(trickyKey);
    assert.ok(info);
    assert.equal(info.size, Buffer.byteLength(content, 'utf8'));

    await client.remove(trickyKey);
    assert.equal(await client.head(trickyKey), null);
  });

  await check('线上路径是分段百分号编码（中文/空格不裸奔），且能被解码回原 key', async () => {
    await client.put(trickyKey, 'x');
    const entry = [...state.log].reverse().find((item) => item.method === 'PUT');
    assert.ok(entry.url.includes('/dsh/%E6%B5%8B%E8%AF%95%20%E6%96%87%E4%BB%B6/'), `实际 url=${entry.url}`);
    assert.ok(!entry.url.includes('测试'), 'HTTP 请求行里不能出现未编码的中文');
    assert.equal(decodePath(new URL(entry.url, 'http://x').pathname), `/${trickyKey}`);
    assert.ok(entry.verified, '该请求必须通过 mock 的独立验签');
    await client.remove(trickyKey);
  });

  await check('含 & 与 % 的 key 不破坏签名/列表（& 会在 XML 里被转义再还原）', async () => {
    const key = 'dsh/a&b c%d.txt';
    await client.put(key, 'amp');
    assert.equal((await client.get(key)).toString('utf8'), 'amp');
    await client.remove(key);
  });

  // ---------- 4. 404 语义 ----------
  console.log('\n404 语义');

  await check('head(不存在的 key) → null（不抛错）', async () => {
    const info = await client.head('dsh/definitely-missing.md');
    assert.equal(info, null);
  });

  await check('get(不存在的 key) → E_NOT_FOUND，detail 里带 NoSuchKey', async () => {
    const err = await expectCosError(() => client.get('dsh/definitely-missing.md'), 'E_NOT_FOUND');
    assert.equal(err.status, 404);
    assert.equal(err.detail.code, 'NoSuchKey');
    assert.match(err.message, /不存在/);
  });

  // ---------- 5. 列表分页 ----------
  console.log('\n列表 / 分页');

  await check('list 分页：走完 NextMarker 拿到全部 key，XML 实体被还原', async () => {
    const seeds = [
      ['dsh/list/01.txt', 'a'],
      ['dsh/list/02.txt', 'b'],
      ['dsh/list/03.txt', 'c'],
      ['dsh/list/a&b.txt', 'd'],
      ['dsh/list/z-last.txt', 'e'],
    ];
    for (const [key, content] of seeds) {
      await client.put(key, content);
    }

    const collected = [];
    let marker;
    let pages = 0;
    do {
      const page = await client.list('dsh/list/', marker);
      pages += 1;
      assert.ok(pages <= 10, '分页次数异常，可能 nextMarker 没推进');
      for (const item of page.keys) collected.push(item.key);
      marker = page.nextMarker;
    } while (marker);

    assert.deepEqual(
      collected.sort(),
      seeds.map(([key]) => key).sort(),
      `分页结果不完整: ${JSON.stringify(collected)}`,
    );
    assert.ok(pages >= 2, `应至少分 2 页，实际 ${pages} 页`);
    assert.ok(collected.includes('dsh/list/a&b.txt'), '& 必须被还原成字面量 &');

    // 最后再验一次：列表项里的 size/etag/lastModified 字段都在
    const first = await client.list('dsh/list/');
    assert.equal(first.keys.length, 2);
    assert.equal(first.keys[0].size, 1);
    assert.match(first.keys[0].etag, /^[0-9a-f]{32}$/);
    assert.equal(first.keys[0].lastModified, '2026-01-02T03:04:05.000Z');
    return `${pages} 页 / ${collected.length} 个 key`;
  });

  await check('list 的 q-url-param-list 与实际 query 参数完全一致', async () => {
    const entry = [...state.log].reverse().find((item) => item.method === 'GET' && item.url.includes('prefix='));
    assert.ok(entry, '没找到 list 请求');
    const paramList = entry.auth.match(/q-url-param-list=([^&]*)/)[1];
    const actual = [...new Set([...new URL(entry.url, 'http://x').searchParams.keys()])]
      .map((name) => camEncode(name).toLowerCase())
      .sort();
    assert.deepEqual(paramList.split(';').filter(Boolean), actual, `param-list=${paramList} 实际=${actual}`);

    // 翻页那次必须带 marker
    const paged = state.log.find((item) => item.url.includes('marker='));
    assert.ok(paged, '没有带 marker 的请求，分页没生效');
    assert.ok(paged.auth.includes('q-url-param-list=marker;prefix'), `param-list=${paged.auth}`);
  });

  // ---------- 6. remove ----------
  console.log('\n删除');

  await check('remove 后 head → null，且桶里确实没了', async () => {
    await client.put('dsh/to-delete.md', 'bye');
    assert.ok(await client.head('dsh/to-delete.md'));
    await client.remove('dsh/to-delete.md');
    assert.equal(await client.head('dsh/to-delete.md'), null);
    assert.equal(state.store.has('dsh/to-delete.md'), false);
  });

  await check('remove 不存在的 key 不报错（COS DELETE 幂等）', async () => {
    await client.remove('dsh/never-existed.md');
  });

  // ---------- 7. 错误映射 ----------
  console.log('\n错误映射');

  await check('403 → CosError(E_CLOUD_AUTH)，带 status/Code/Message', async () => {
    const err = await expectCosError(() => client.get('dsh/__403'), 'E_CLOUD_AUTH');
    assert.equal(err.status, 403);
    assert.equal(err.detail.code, 'AccessDenied');
    assert.match(err.message, /鉴权失败/);
    assert.match(err.message, /AccessDenied/);
    assert.match(err.message, /HTTP 403/);
    return 'status=403 Code=AccessDenied';
  });

  await check('超时 → CosError(E_CLOUD_NETWORK)，detail.timeout=true', async () => {
    const fastClient = createCosClient({
      secretId: SECRET_ID,
      secretKey: SECRET_KEY,
      bucket: BUCKET,
      region: REGION,
      timeoutMs: 250,
      connectHost: '127.0.0.1',
      connectPort: port,
      protocol: 'http',
    });
    const startedAt = Date.now();
    const err = await expectCosError(() => fastClient.get('dsh/__timeout'), 'E_CLOUD_NETWORK');
    const elapsed = Date.now() - startedAt;
    assert.equal(err.detail.timeout, true);
    assert.match(err.message, /超时/);
    assert.ok(elapsed >= 200 && elapsed < 3000, `超时耗时异常: ${elapsed}ms`);
    return `${elapsed}ms`;
  });

  await check('5xx 自动重试：前两次 500、第三次 200 → 最终成功且共请求 3 次', async () => {
    state.hits.delete('dsh/__flaky');
    const startedAt = Date.now();
    await client.put('dsh/__flaky', 'retry-me');
    const elapsed = Date.now() - startedAt;
    assert.equal(state.hits.get('dsh/__flaky'), 3, `应请求 3 次（1 次 + 2 次重试），实际 ${state.hits.get('dsh/__flaky')}`);
    assert.ok(elapsed >= 1200, `退避总时长应 ≥ 1300ms（400+900），实际 ${elapsed}ms`);
    return `3 次请求 / ${elapsed}ms`;
  });

  await check('5xx 重试耗尽 → CosError(E_CLOUD_FAILED)，detail.retried=2', async () => {
    state.hits.delete('dsh/__500');
    const err = await expectCosError(() => client.get('dsh/__500'), 'E_CLOUD_FAILED');
    assert.equal(err.status, 500);
    assert.equal(err.detail.retried, 2);
    assert.equal(state.hits.get('dsh/__500'), 3, '应是 1 次请求 + 2 次重试');
    assert.match(err.message, /已自动重试 2 次/);
    assert.equal(err.detail.code, 'InternalError');
  });

  await check('4xx 不重试：403 只打一次', async () => {
    const before = state.hits.get('dsh/__403') || 0;
    await expectCosError(() => client.get('dsh/__403'), 'E_CLOUD_AUTH');
    const after = state.hits.get('dsh/__403') || 0;
    assert.equal(after - before, 1, `403 不该重试，实际新增 ${after - before} 次`);
  });

  // ---------- 8. 全局签名断言 ----------
  console.log('\n签名一致性（对 mock 收到的全部请求）');

  await check('所有请求都通过了 mock 的独立验签', () => {
    const failed = state.log.filter((item) => !item.verified);
    assert.equal(failed.length, 0, `有 ${failed.length} 个请求验签失败: ${JSON.stringify(failed.map((f) => f.verifyError))}`);
    return `${state.log.length} 个请求全部通过`;
  });

  await check('每条 Authorization 的 q-header-list 都含 host，且头名小写有序', () => {
    for (const item of state.log) {
      const headerList = item.auth.match(/q-header-list=([^&]*)/)[1];
      const names = headerList.split(';').filter(Boolean);
      assert.ok(names.includes('host'), `缺少 host: ${headerList}`);
      assert.deepEqual(names, [...names].sort(), `未排序: ${headerList}`);
      assert.ok(names.every((name) => name === name.toLowerCase()), `存在大写: ${headerList}`);
      assert.equal(item.headers.host, COS_HOST, `Host 头必须是真实 COS 域名: ${item.headers.host}`);
    }
    return `共检查 ${state.log.length} 条`;
  });

  await check('PUT 的 q-header-list 恰好是 content-length;content-type;host（+ 可选 x-cos-meta-sha256）', () => {
    const puts = state.log.filter((item) => item.method === 'PUT');
    assert.ok(puts.length > 0);
    for (const item of puts) {
      const headerList = item.auth.match(/q-header-list=([^&]*)/)[1];
      const hasMeta = headerList.includes('x-cos-meta-sha256');
      const expected = hasMeta
        ? 'content-length;content-type;host;x-cos-meta-sha256'
        : 'content-length;content-type;host';
      assert.equal(headerList, expected, `实际=${headerList}`);
    }
    return `${puts.length} 个 PUT`;
  });

  await check('HEAD / 的 q-url-param-list 为空串（桶级操作无 query）', () => {
    const headBucket = state.log.find((item) => item.method === 'HEAD' && decodePath(new URL(item.url, 'http://x').pathname) === '/');
    assert.ok(headBucket, '没有 HEAD / 请求');
    assert.ok(headBucket.auth.includes('q-url-param-list=&'), `param-list 应为空: ${headBucket.auth}`);
  });
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */
let exitCode = 0;
try {
  await main();
} catch (err) {
  results.fail += 1;
  console.log(`\n[FATAL] 测试流程异常中断：\n${err && err.stack ? err.stack : err}`);
} finally {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
}

const total = results.pass + results.fail;
console.log(`\n${'-'.repeat(60)}`);
console.log(`checks: ${results.pass}/${total} passed, ${results.fail} failed`);
if (results.fail > 0) {
  console.log('SOME CHECKS FAILED');
  exitCode = 1;
} else {
  console.log('ALL CHECKS PASSED');
}
process.exitCode = exitCode;
