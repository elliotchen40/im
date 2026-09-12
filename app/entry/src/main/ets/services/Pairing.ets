/**
 * 扫码登录 —— 扫服务端 `npm run pair` 输出的二维码，自动换回地址与 token 并落盘。
 *
 * 与 docs/protocol/im-protocol.md 的 /im/pair 端点配套：
 *   二维码载荷：im://pair?u=<公网地址>&c=<一次性配对码>
 *   换 token：  POST {公网地址}/im/pair { code }  →  { baseUrl, token, userId }
 *
 * 注意 ScanKit 的默认扫码界面由系统提供，**不需要** app 自己申请相机权限
 * （若某些 SDK 版本报权限错误，再在 module.json5 加 ohos.permission.CAMERA）。
 */

import { scanBarcode, scanCore } from '@kit.ScanKit';
import { http } from '@kit.NetworkKit';
import { common } from '@kit.AbilityKit';
import { AppConfig } from './AppConfig';

/** 二维码载荷 */
export interface PairPayload {
  publicUrl: string;
  code: string;
}

/** 配对结果 */
export interface PairResult {
  ok: boolean;
  baseUrl: string;
  message: string;
}

/** 服务端 /im/pair 响应 */
interface PairResp {
  ret: number;
  baseUrl: string;
  token: string;
  userId: string;
  errmsg?: string;
}

/** 解析二维码载荷；不是 im 配对码则返回 null */
export function parsePairPayload(text: string): PairPayload | null {
  const t: string = text.trim();
  const prefix: string = 'im://pair';
  if (!t.startsWith(prefix)) {
    return null;
  }
  const q: number = t.indexOf('?');
  if (q < 0) {
    return null;
  }
  // 不用 URLSearchParams：ArkTS 运行时不保证提供这个 Web API，手写解析更稳
  let u: string = '';
  let c: string = '';
  for (const pair of t.substring(q + 1).split('&')) {
    const eq: number = pair.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const key: string = pair.substring(0, eq);
    const val: string = pair.substring(eq + 1);
    if (key === 'u') {
      u = decodeURIComponent(val);
    } else if (key === 'c') {
      c = decodeURIComponent(val);
    }
  }
  if (u.length === 0 || c.length === 0) {
    return null;
  }
  const payload: PairPayload = { publicUrl: u, code: c };
  return payload;
}

/**
 * 拉起系统扫码界面。
 * 返回二维码文本；用户取消或失败返回 null。
 */
export async function scanOnce(context: common.UIAbilityContext): Promise<string | null> {
  try {
    const options: scanBarcode.ScanOptions = {
      scanTypes: [scanCore.ScanType.ALL],
      enableMultiMode: true,
      enableAlbum: true
    };
    const result = await scanBarcode.startScanForResult(context, options);
    const value: string = result.originalValue;
    if (value === undefined || value === null || value.length === 0) {
      return null;
    }
    return value;
  } catch (e) {
    // 用户取消也会走到这里，不当作错误
    return null;
  }
}

/** 用配对码换取地址与 token；成功后写入 preferences */
export async function pairWithServer(publicUrl: string, code: string): Promise<PairResult> {
  let base: string = publicUrl.trim();
  while (base.endsWith('/')) {
    base = base.substring(0, base.length - 1);
  }

  const body: Record<string, string> = { code: code };
  const client = http.createHttp();
  try {
    const options: http.HttpRequestOptions = {
      method: http.RequestMethod.POST,
      header: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      extraData: JSON.stringify(body),
      connectTimeout: 10000,
      readTimeout: 15000,
      expectDataType: http.HttpDataType.STRING
    };
    const resp = await client.request(base + '/im/pair', options);
    if (resp.responseCode !== 200) {
      const fail: PairResult = { ok: false, baseUrl: base, message: '服务端拒绝配对（HTTP ' + resp.responseCode + '）' };
      return fail;
    }
    const parsed = JSON.parse(resp.result as string) as PairResp;
    if (parsed.ret !== 0) {
      const fail: PairResult = { ok: false, baseUrl: base, message: '配对被拒：' + (parsed.errmsg ?? '未知原因') };
      return fail;
    }
    // 以服务端返回的 baseUrl 为准（它知道自己的公网地址）
    const finalUrl: string = parsed.baseUrl !== undefined && parsed.baseUrl.length > 0 ? parsed.baseUrl : base;
    AppConfig.setBaseUrl(finalUrl);
    AppConfig.setToken(parsed.token);
    // 换了服务端就等于换了消息流，游标要清空
    AppConfig.setCursor('');
    const ok: PairResult = { ok: true, baseUrl: finalUrl, message: '配对成功' };
    return ok;
  } catch (e) {
    const fail: PairResult = { ok: false, baseUrl: base, message: '连不上服务端，检查隧道/网络' };
    return fail;
  } finally {
    client.destroy();
  }
}
