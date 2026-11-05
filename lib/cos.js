/**
 * 腾讯云 COS（Cloud Object Storage）最小客户端 —— 零第三方依赖。
 *
 * 设计要点（为什么这么写）：
 * 1. 只用 node: 内置模块（crypto / https / http），不引入任何 SDK，方便在受限环境里直接复制使用。
 * 2. 自己实现 COS V5 签名（HMAC-SHA1），算法照官方文档
 *    https://cloud.tencent.com/document/product/436/7778 ，
 *    并与官方 SDK 的 getAuth 实现逐行对齐（Node/Python 两个 SDK 的 httpString 拼法一致）。
 * 3. 所有对象 key 都按 "/" 分段编码，分隔符本身保留；签名用的 pathname 用「未编码」形式，
 *    因为 COS 服务端验签时会先对请求行里的路径做 URL 解码（官方 SDK 也是拿裸 key 签的）。
 * 4. 错误统一成 CosError，带上 code / status / detail，便于上层按 code 走不同提示。
 */

'use strict';
// 说明：ESM 模块天然运行在严格模式下；这里显式写出指令，是为了让"严格模式"这个约束
// 不依赖读者对模块系统的记忆（写不写行为都一样）。

import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** 默认超时：20s，够慢速移动网络传一个中小对象。 */
const DEFAULT_TIMEOUT_MS = 20000;
/** 签名有效期（秒）。COS 允许给一个时间窗，窗内重复使用同一份签名都合法。 */
const SIGN_EXPIRE_SEC = 3600;
/** 5xx 的退避毫秒表：长度即最大重试次数（需求：最多重试 2 次，400ms / 900ms）。 */
const RETRY_DELAYS_MS = Object.freeze([400, 900]);
/** COS 用户自定义元数据在响应头里的前缀。 */
const META_HEADER_PREFIX = 'x-cos-meta-';

/** 休眠，用于重试退避。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * 错误类型
 * ------------------------------------------------------------------ */

/**
 * 统一的 COS 错误。
 * code 取值：
 *   E_CLOUD_AUTH     401/403，密钥或权限问题
 *   E_NOT_FOUND      404
 *   E_CLOUD_NETWORK  网络层失败 / 超时 / ECONNRESET
 *   E_CLOUD_FAILED   5xx（已重试）或其它非 2xx
 *   E_CLOUD_CONFIG   客户端配置缺失（构造时）
 *   E_INVALID_ARG    调用参数非法（例如空 key）
 */
export class CosError extends Error {
  /**
   * @param {string} code 上面的错误码
   * @param {string} message 面向人的中文说明（含服务端 Code/Message）
   * @param {object} [extra] 附加细节：{ status, code, message, requestId, ... }
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'CosError';
    this.code = code;
    // status 单独提升成一级字段，方便调用方 `if (err.status === 403)` 直接判断
    this.status = typeof extra.status === 'number' ? extra.status : 0;
    // detail 保留完整原始信息（含 status），便于日志打点
    this.detail = { status: this.status, ...extra };
    if (Error.captureStackTrace) Error.captureStackTrace(this, CosError);
  }
}

/* ------------------------------------------------------------------ *
 * 编码
 * ------------------------------------------------------------------ */

/**
 * COS（与 AWS SigV4 同源）要求的 RFC3986 百分号编码。
 * encodeURIComponent 会放过 ! ' ( ) * 这 5 个字符，但 COS 服务端在算 httpString 时
 * 会把它们也编码，所以必须补刀；否则 key 或头值里出现这几个字符就一定 SignatureDoesNotMatch。
 * 反向确认：官方 SDK 的 camSafeUrlEncode（Node）和 quote(x, '-_.~')（Python）都做同样处理。
 */
function cosEncode(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return encodeURIComponent(text)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

/** COS 的 object key 不含前导 "/"（官方 SDK 也会强制去掉），这里统一归一化。 */
function normalizeKey(key) {
  return String(key === undefined || key === null ? '' : key).replace(/^\/+/, '');
}

/**
 * 请求行里的路径：key 按 "/" 分段分别编码，分隔符本身保留。
 * 不能整体 encodeURIComponent —— 那样 "/" 会变成 %2F，COS 会把它当成一个没有层级的 key。
 */
function encodeKeyPath(key) {
  return normalizeKey(key).split('/').map(cosEncode).join('/');
}

/** 把 query 对象拼成真正发出去的查询串（编码规则与签名时用的完全一致）。 */
function buildQueryString(query) {
  const names = Object.keys(query || {});
  if (!names.length) return '';
  return names.map((name) => `${cosEncode(name)}=${cosEncode(query[name])}`).join('&');
}

/* ------------------------------------------------------------------ *
 * 签名（COS V5 / HMAC-SHA1）
 * ------------------------------------------------------------------ */

function sha1Hex(input) {
  return createHash('sha1').update(input, 'utf8').digest('hex');
}

/**
 * HMAC-SHA1，返回十六进制字符串。
 * 注意：Node 的 createHmac 对字符串 key 默认按 UTF-8 取字节，这里传进来的 signKey
 * 是「十六进制字符串」而不是它的原始字节 —— 官方 SDK 用的就是这个字符串，必须一致。
 */
function hmacSha1Hex(key, input) {
  return createHmac('sha1', key).update(input, 'utf8').digest('hex');
}

/**
 * 把 { 名称: 值 } 规范化为签名用的条目数组：
 *   名称先 cosEncode 再转小写 → 按「编码后的小写名」做字典序排序；值同样 cosEncode。
 * 顺序必须与服务端的字典序一致，这是 COS 签名最容易踩坑的地方。
 */
function canonicalEntries(map) {
  return Object.keys(map || {})
    .map((name) => ({
      name: cosEncode(name).toLowerCase(),
      value: cosEncode(map[name]),
    }))
    .sort((a, b) => (a.name === b.name ? 0 : a.name > b.name ? 1 : -1));
}

/** 拼成 name=value&name=value 形式（值已编码）。 */
function joinEntries(entries) {
  return entries.map((entry) => `${entry.name}=${entry.value}`).join('&');
}

/** 拼成 name;name 形式，用于 q-header-list / q-url-param-list。 */
function joinNames(entries) {
  return entries.map((entry) => entry.name).join(';');
}

/**
 * 计算 COS V5 签名并返回 Authorization 头。
 *
 * 拼接顺序（务必别改）：
 *   HttpString   = method + "\n" + pathname + "\n" + 参数串 + "\n" + 头串 + "\n"
 *   StringToSign = "sha1" + "\n" + KeyTime + "\n" + SHA1(HttpString) + "\n"
 *   Signature    = HMAC-SHA1(SignKey, StringToSign)
 *   SignKey      = HMAC-SHA1(SecretKey, KeyTime)
 * 即：先 method 再 path，然后「已排序的参数」，最后「已排序的头」，四段之间三个 \n，
 * 末尾再补一个 \n（所以整串以 \n 结束）。
 *
 * @param {object} opts
 * @param {string} opts.secretId
 * @param {string} opts.secretKey
 * @param {string} opts.method   HTTP 方法
 * @param {string} opts.pathname 参与签名的路径（未编码的 key 路径，桶级操作就是 "/"）
 * @param {object} [opts.query]  查询参数（原始值，内部负责编码）
 * @param {object} [opts.headers] 参与签名的头（必须含 host；名称小写）
 * @param {number} [opts.nowMs] 便于测试注入时间
 * @param {number} [opts.expiresSec]
 */
function buildAuthorization(opts) {
  const {
    secretId,
    secretKey,
    method,
    pathname,
    query = {},
    headers = {},
    nowMs = Date.now(),
    expiresSec = SIGN_EXPIRE_SEC,
  } = opts;

  const startSec = Math.floor(nowMs / 1000);
  const keyTime = `${startSec};${startSec + expiresSec}`;

  // 步骤一：SignKey = HMAC-SHA1(SecretKey, KeyTime) 的十六进制串
  const signKey = hmacSha1Hex(secretKey, keyTime);

  const headerEntries = canonicalEntries(headers);
  const paramEntries = canonicalEntries(query);

  // 步骤二：HttpString。注意注释里说的「四段 + 末尾换行」，
  // 直接数 \n 是 4 个分隔 + 收尾 1 个 = 5 个。
  const httpString = [
    String(method).toLowerCase(),
    pathname,
    joinEntries(paramEntries),
    joinEntries(headerEntries),
  ].join('\n') + '\n';

  // 步骤三：StringToSign。HttpString 逐字节按 UTF-8 参与 SHA1（中文 key 必须 UTF-8）。
  const stringToSign = `sha1\n${keyTime}\n${sha1Hex(httpString)}\n`;

  // 步骤四：Signature = HMAC-SHA1(SignKey, StringToSign)
  const signature = hmacSha1Hex(signKey, stringToSign);

  const authorization = [
    'q-sign-algorithm=sha1',
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${joinNames(headerEntries)}`,
    `q-url-param-list=${joinNames(paramEntries)}`,
    `q-signature=${signature}`,
  ].join('&');

  return {
    authorization,
    keyTime,
    headerList: joinNames(headerEntries),
    paramList: joinNames(paramEntries),
    httpString,
    stringToSign,
    signKey,
    signature,
  };
}

/* ------------------------------------------------------------------ *
 * XML 解析（只用正则，不引 XML 库）
 * ------------------------------------------------------------------ */

/** 还原 XML 实体（&amp; &lt; &gt; &quot; &apos; 以及数字实体）。 */
function xmlDecode(text) {
  if (typeof text !== 'string' || text.indexOf('&') === -1) return text;
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (match, entity) => {
    switch (entity) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const codePoint = entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
      }
    }
  });
}

/** 取某个标签的文本内容（第一个匹配），并还原实体；找不到返回 undefined。 */
function tagText(xml, tagName) {
  if (typeof xml !== 'string' || !xml) return undefined;
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(pattern);
  return match ? xmlDecode(match[1]) : undefined;
}

/** 去掉 ETag 两侧的双引号（COS 返回的 ETag 形如 "\"d41d8...\""）。 */
function stripQuotes(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.replace(/^"(.*)"$/s, '$1');
}

/** 响应头可能是数组（同名头多次出现），统一成字符串。 */
function headerString(value) {
  if (Array.isArray(value)) return value.join(', ');
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 从错误响应体里抠出 Code / Message / RequestId 等。
 * 非 XML（例如网关返回 HTML）时给出截断片段，方便排查。
 */
function parseXmlError(body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  const code = tagText(text, 'Code');
  const message = tagText(text, 'Message');
  const requestId = tagText(text, 'RequestId') || tagText(text, 'RequestID');
  const resource = tagText(text, 'Resource');
  const key = tagText(text, 'Key');
  const snippet = code ? '' : text.replace(/\s+/g, ' ').trim().slice(0, 200);
  return { code, message, requestId, resource, key, snippet };
}

/**
 * 解析 ListBucketResult（v1）：取出所有 <Contents> 与顶层 <NextMarker>。
 * 用非贪婪正则逐块匹配，避免把整个 XML 建成树；<Contents> 上可能有属性，所以 \b[^>]*。
 */
function parseListXml(xml) {
  const text = typeof xml === 'string' ? xml : String(xml || '');
  const keys = [];
  const contentsPattern = /<Contents(?:\s[^>]*)?>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = contentsPattern.exec(text)) !== null) {
    const block = match[1];
    const key = tagText(block, 'Key');
    if (!key) continue; // 没有 Key 的块没有意义，直接丢弃
    const sizeRaw = tagText(block, 'Size');
    keys.push({
      key,
      size: Number.parseInt(sizeRaw || '0', 10) || 0,
      etag: stripQuotes(tagText(block, 'ETag') || ''),
      lastModified: tagText(block, 'LastModified') || '',
    });
  }
  const nextMarkerRaw = tagText(text, 'NextMarker');
  const nextMarker = nextMarkerRaw ? nextMarkerRaw : undefined;
  const isTruncated = (tagText(text, 'IsTruncated') || '').toLowerCase() === 'true';
  return { keys, nextMarker, isTruncated };
}

/* ------------------------------------------------------------------ *
 * 客户端
 * ------------------------------------------------------------------ */

/**
 * 创建 COS 客户端。
 *
 * @param {object} options
 * @param {string} options.secretId
 * @param {string} options.secretKey
 * @param {string} options.bucket  形如 "mybucket-1250000000"
 * @param {string} options.region  形如 "ap-guangzhou"
 * @param {string} [options.prefix='dsh/']
 * @param {number} [options.timeoutMs=20000]
 * @param {string} [options.connectHost] @internal 仅测试用：把连接目标指向别处（Host 头仍是真实 COS 域名）
 * @param {number} [options.connectPort] @internal 仅测试用
 * @param {'http'|'http:'|'https'} [options.protocol] @internal 仅测试用
 */
export function createCosClient(options = {}) {
  const secretId = options.secretId ? String(options.secretId) : '';
  const secretKey = options.secretKey ? String(options.secretKey) : '';
  const bucket = options.bucket ? String(options.bucket) : '';
  const region = options.region ? String(options.region) : '';

  if (!secretId || !secretKey) {
    throw new CosError(
      'E_CLOUD_CONFIG',
      'COS 客户端缺少 secretId / secretKey：请在配置里提供腾讯云 API 密钥。',
      { status: 0 },
    );
  }
  if (!bucket || !region) {
    throw new CosError(
      'E_CLOUD_CONFIG',
      'COS 客户端缺少 bucket / region：bucket 形如 "mybucket-1250000000"，region 形如 "ap-guangzhou"。',
      { status: 0 },
    );
  }

  const prefix = options.prefix === undefined || options.prefix === null ? 'dsh/' : String(options.prefix);
  const parsedTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;

  // 真实请求的域名：bucket 走虚拟主机风格，签名里的 host 就是它（必须参与签名，防跨桶重放）
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  const isHttp = options.protocol === 'http' || options.protocol === 'http:';
  const connectHost = options.connectHost ? String(options.connectHost) : host;
  const connectPort = Number(options.connectPort) > 0 ? Number(options.connectPort) : (isHttp ? 80 : 443);
  const doRequest = isHttp ? httpRequest : httpsRequest;

  /** 网络层异常统一包成 E_CLOUD_NETWORK（超时要能区分出来，便于上层提示"调大 timeoutMs"）。 */
  function toNetworkError(err, timedOut) {
    const cause = err instanceof Error ? err : new Error(String(err));
    const code = String(cause.code || cause.name || 'UNKNOWN');
    if (timedOut || code === 'ABORT_ERR' || cause.name === 'AbortError') {
      return new CosError(
        'E_CLOUD_NETWORK',
        `请求腾讯云 COS 超时（超过 ${timeoutMs}ms 未完成）：请检查网络/代理，或调大 timeoutMs。原始错误：${code}`,
        { status: 0, timeout: true, cause: code },
      );
    }
    return new CosError(
      'E_CLOUD_NETWORK',
      `请求腾讯云 COS 失败（网络层）：${code} ${cause.message || ''}`.trim(),
      { status: 0, timeout: false, cause: code },
    );
  }

  /**
   * 发一次 HTTP 请求，拿到完整响应。
   * 这里不判断状态码（4xx/5xx 都正常 resolve），由上层统一映射成 CosError，
   * 这样重试逻辑只关心 status，不关心语义。
   */
  function sendOnce({ method, sendPath, query, body, headers }) {
    return new Promise((resolve, reject) => {
      const queryString = buildQueryString(query);
      const fullPath = queryString ? `${sendPath}?${queryString}` : sendPath;

      let req = null;
      let settled = false;
      let timedOut = false;
      const controller = new AbortController();

      // 超时：AbortController 负责让请求立刻失败，destroy 负责确保 socket 被释放（双保险）。
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        if (req) req.destroy(new Error(`COS 请求超时（>${timeoutMs}ms）`));
      }, timeoutMs);

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      try {
        req = doRequest({
          method,
          host: connectHost,
          port: connectPort,
          path: fullPath,
          headers,
          // 一次请求一个 socket：COS 调用较稀疏，且避免 keep-alive 残留连接把进程吊住
          agent: false,
          signal: controller.signal,
        }, (res) => {
          // 响应体按 Buffer 拼接，不能转成字符串（对象内容可能是二进制）
          const chunks = [];
          res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on('end', () => settle(resolve, {
            status: res.statusCode || 0,
            headers: res.headers || {},
            body: Buffer.concat(chunks),
          }));
          res.on('error', (err) => settle(reject, toNetworkError(err, timedOut)));
        });

        req.on('error', (err) => settle(reject, toNetworkError(err, timedOut)));
        if (body && body.length) req.write(body);
        req.end();
      } catch (err) {
        settle(reject, toNetworkError(err, timedOut));
      }
    });
  }

  /**
   * 带重试的请求：5xx 和网络层异常重试（ECONNRESET / 超时都是瞬时故障，
   * 我们所有方法天然幂等：PUT/GET/HEAD/DELETE 重放都安全）；4xx 是确定性的，不重试。
   * 最多重试 RETRY_DELAYS_MS.length 次，退避 400ms / 900ms。
   * 每次尝试都重新签名：keyTime 跟当前时间走，长退避后也不会过期。
   */
  async function executeWithRetry({ method, signPath, sendPath, query, body, signedHeaders }) {
    let lastResponse = null;
    let lastError = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const { authorization } = buildAuthorization({
        secretId,
        secretKey,
        method,
        pathname: signPath,
        query,
        headers: signedHeaders,
      });

      // 实际发出的头 = 参与签名的头（一个不多一个不少）+ Authorization
      const outboundHeaders = { ...signedHeaders, authorization };

      try {
        const response = await sendOnce({ method, sendPath, query, body, headers: outboundHeaders });
        lastError = null;
        if (response.status < 500) return response;
        lastResponse = response;
      } catch (error) {
        // 只有网络层异常值得重放；签名/参数/认证类错误重试也没用
        if (error?.code !== 'E_CLOUD_NETWORK') throw error;
        lastError = error;
        lastResponse = null;
      }

      if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
    }
    if (lastError !== null) throw lastError;
    return lastResponse;
  }

  /** 非 2xx 一律转成 CosError，并带上服务端 Code/Message。 */
  function ensureSuccess(response, action) {
    const status = response.status;
    if (status >= 200 && status < 300) return response;

    const info = parseXmlError(response.body);
    const detail = {
      status,
      action,
      code: info.code,
      message: info.message,
      requestId: info.requestId,
      resource: info.resource,
      bodySnippet: info.snippet,
    };
    const serverText = `服务端返回 Code=${info.code || '未知'}，Message=${info.message || '（无）'}`;

    if (status === 401 || status === 403) {
      throw new CosError(
        'E_CLOUD_AUTH',
        `COS 鉴权失败（HTTP ${status}）：请检查 secretId/secretKey 是否正确、Bucket 与 Region 是否匹配、`
          + `以及该密钥是否具备该 Bucket 的读写权限；也可能是参与签名的请求头与实际发出的不一致。`
          + `${serverText}（bucket=${bucket}, region=${region}）`,
        detail,
      );
    }
    if (status === 404) {
      throw new CosError(
        'E_NOT_FOUND',
        `COS 资源不存在（HTTP 404）：${action} 找不到目标。${serverText}`,
        detail,
      );
    }
    if (status >= 500) {
      throw new CosError(
        'E_CLOUD_FAILED',
        `COS 服务端错误（HTTP ${status}）：已自动重试 ${RETRY_DELAYS_MS.length} 次仍失败，`
          + `通常是 COS 侧抖动或限流，请稍后再试。${serverText}`,
        { ...detail, retried: RETRY_DELAYS_MS.length },
      );
    }
    throw new CosError(
      'E_CLOUD_FAILED',
      `COS 请求失败（HTTP ${status}）：${action} 被拒绝。${serverText}`,
      detail,
    );
  }

  /** 拿到非空 key，否则是调用方写错了（属于编程错误，不该重试）。 */
  function requireKey(key, action) {
    const objectKey = normalizeKey(key);
    if (!objectKey) {
      throw new CosError(
        'E_INVALID_ARG',
        `COS ${action} 需要非空的对象 key（收到 ${JSON.stringify(key)}）。`,
        { status: 0 },
      );
    }
    return objectKey;
  }

  /**
   * 所有请求的唯一入口。
   * key === null 表示桶级操作（HEAD /、GET / 列表），路径就是 "/"。
   */
  async function call({ method, key = null, query = {}, body = null, headers = {} }) {
    const isBucketLevel = key === null;

    // 用于签名的 pathname：未编码的 key 路径（服务端验签时会对请求行里的路径做解码）
    const signPath = isBucketLevel ? '/' : `/${normalizeKey(key)}`;
    // 实际发送的 pathname：百分号编码、保留 "/" 作为层级分隔符
    const sendPath = isBucketLevel ? '/' : `/${encodeKeyPath(key)}`;

    // host 必须参与签名（COS 用它防跨桶重放）；其余头由各方法按需补充。
    const signedHeaders = { host, ...headers };

    const response = await executeWithRetry({ method, signPath, sendPath, query, body, signedHeaders });
    return ensureSuccess(response, `${method} ${isBucketLevel ? '/' : key}`);
  }

  /* ---------------- 对外方法 ---------------- */

  /**
   * 连通性 + 权限自检：
   *   HEAD /（headBucket 确认桶存在且可访问）
   *   → PUT 一个 ${prefix}_probe → HEAD 确认能读回 → DELETE 清掉。
   * 任何一步失败都会抛 CosError，调用方可以据此判断"这套密钥/桶配置到底能不能用"。
   */
  async function test() {
    const startedAt = Date.now();
    const probeKey = `${prefix}_probe`;

    await call({ method: 'HEAD', key: null });

    await put(probeKey, 'ok', { contentType: 'text/plain' });

    const info = await head(probeKey);
    if (!info) {
      throw new CosError(
        'E_CLOUD_FAILED',
        `COS 自检失败：刚写入的探针对象 ${probeKey} 读不回来（HEAD 返回 404），请检查是否开了版本控制/生命周期或写入到了别的桶。`,
        { status: 404, action: `HEAD ${probeKey}` },
      );
    }

    await remove(probeKey);

    return { bucket, region, elapsedMs: Date.now() - startedAt };
  }

  /**
   * 上传对象。
   * @param {string} key
   * @param {Buffer|string} body
   * @param {{contentType?: string, sha256?: string}} [meta]
   *   sha256 会写进 x-cos-meta-sha256（自定义头以 x-cos- 开头，COS 会把它纳入签名）
   * @returns {Promise<{etag: string, size: number}>}
   */
  async function put(key, body, meta = {}) {
    const objectKey = requireKey(key, 'put');
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body === undefined || body === null ? '' : body), 'utf8');

    const headers = {
      'content-type': meta.contentType ? String(meta.contentType) : 'application/octet-stream',
      // 显式给 content-length：COS 要求 PUT 必须能确定长度，而它也会进签名
      'content-length': String(payload.length),
    };
    if (meta.sha256) headers['x-cos-meta-sha256'] = String(meta.sha256);

    const response = await call({ method: 'PUT', key: objectKey, body: payload, headers });

    return {
      etag: stripQuotes(headerString(response.headers.etag)),
      size: payload.length,
    };
  }

  /** 下载对象，返回原始 Buffer（不猜编码）。 */
  async function get(key) {
    const objectKey = requireKey(key, 'get');
    const response = await call({ method: 'GET', key: objectKey });
    return response.body;
  }

  /**
   * 取对象元信息；对象不存在时返回 null（不抛错），方便调用方做存在性判断。
   * @returns {Promise<{size: number, etag: string, meta: Record<string,string>} | null>}
   */
  async function head(key) {
    const objectKey = requireKey(key, 'head');
    try {
      const response = await call({ method: 'HEAD', key: objectKey });

      // x-cos-meta-* 是用户自定义元数据，去掉前缀后作为 meta 返回
      const meta = {};
      for (const [name, value] of Object.entries(response.headers)) {
        const lowerName = name.toLowerCase();
        if (lowerName.startsWith(META_HEADER_PREFIX)) {
          meta[lowerName.slice(META_HEADER_PREFIX.length)] = headerString(value);
        }
      }

      return {
        size: Number.parseInt(headerString(response.headers['content-length']) || '0', 10) || 0,
        etag: stripQuotes(headerString(response.headers.etag)),
        meta,
      };
    } catch (err) {
      if (err instanceof CosError && (err.code === 'E_NOT_FOUND' || err.status === 404)) return null;
      throw err;
    }
  }

  /**
   * 列举对象（COS v1 接口：GET /?prefix=&marker=）。
   * @param {string} prefix 前缀
   * @param {string} [marker] 上次返回的 nextMarker，用于翻页
   * @returns {Promise<{keys: Array<{key: string, size: number, etag: string, lastModified: string}>, nextMarker: string|undefined}>}
   */
  async function list(prefix, marker) {
    const query = { prefix: prefix === undefined || prefix === null ? '' : String(prefix) };
    // 只有真的有 marker 才带上：多了个空 marker 会让 q-url-param-list 出现无意义的项
    if (marker) query.marker = String(marker);

    const response = await call({ method: 'GET', key: null, query });
    const parsed = parseListXml(response.body.toString('utf8'));
    return { keys: parsed.keys, nextMarker: parsed.nextMarker };
  }

  /** 删除对象。COS 的 DELETE 是幂等的：删不存在的 key 也返回 204。 */
  async function remove(key) {
    const objectKey = requireKey(key, 'remove');
    await call({ method: 'DELETE', key: objectKey });
  }

  return { test, put, get, head, list, remove };
}

/* ------------------------------------------------------------------ *
 * 自测用内部导出（生产代码不要依赖）
 * ------------------------------------------------------------------ */
export const __internals = Object.freeze({
  cosEncode,
  normalizeKey,
  encodeKeyPath,
  buildQueryString,
  buildAuthorization,
  sha1Hex,
  hmacSha1Hex,
  canonicalEntries,
  parseXmlError,
  parseListXml,
  stripQuotes,
  xmlDecode,
  tagText,
  RETRY_DELAYS_MS,
  DEFAULT_TIMEOUT_MS,
  SIGN_EXPIRE_SEC,
});
