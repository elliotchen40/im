/**
 * 本地配置与状态持久化（preferences）。
 *
 * 存两类东西：
 *   1) 服务端地址 + IM_APP_TOKEN —— 首次启动需在设置页填入
 *   2) sync cursor —— 长轮询游标，冷启动恢复后即可补齐离线期间的消息
 *      （见 docs/protocol/im-protocol.md §6 第 3 条）
 *
 * 用 preferences 的同步 API，避免页面首帧拿不到 cursor 而重复同步历史。
 */

import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

const STORE_NAME: string = 'im_config';
const KEY_BASE_URL: string = 'base_url';
const KEY_TOKEN: string = 'app_token';
const KEY_CURSOR: string = 'sync_cursor';

/** 默认服务端地址；真机调试请改为局域网 IP / 域名（生产必须 https） */
const DEFAULT_BASE_URL: string = 'http://127.0.0.1:8081';
const DEFAULT_TOKEN: string = '';

export class AppConfig {
  private static store: preferences.Preferences | null = null;

  static init(context: common.Context): void {
    if (AppConfig.store !== null) {
      return;
    }
    try {
      AppConfig.store = preferences.getPreferencesSync(context, { name: STORE_NAME });
    } catch (e) {
      console.warn('[AppConfig] 初始化 preferences 失败：' + (e as Error).message);
      AppConfig.store = null;
    }
  }

  private static getString(key: string, fallback: string): string {
    if (AppConfig.store === null) {
      return fallback;
    }
    try {
      const v = AppConfig.store.getSync(key, fallback);
      if (typeof v === 'string') {
        return v as string;
      }
    } catch (e) {
      console.warn('[AppConfig] 读取 ' + key + ' 失败：' + (e as Error).message);
    }
    return fallback;
  }

  private static setString(key: string, value: string): void {
    if (AppConfig.store === null) {
      return;
    }
    try {
      AppConfig.store.putSync(key, value);
      AppConfig.store.flush();
    } catch (e) {
      console.warn('[AppConfig] 写入 ' + key + ' 失败：' + (e as Error).message);
    }
  }

  static baseUrl(): string {
    return AppConfig.getString(KEY_BASE_URL, DEFAULT_BASE_URL);
  }

  static setBaseUrl(value: string): void {
    AppConfig.setString(KEY_BASE_URL, value);
  }

  static token(): string {
    return AppConfig.getString(KEY_TOKEN, DEFAULT_TOKEN);
  }

  static setToken(value: string): void {
    AppConfig.setString(KEY_TOKEN, value);
  }

  static cursor(): string {
    return AppConfig.getString(KEY_CURSOR, '');
  }

  static setCursor(value: string): void {
    AppConfig.setString(KEY_CURSOR, value);
  }

  /** 已配置且可用（地址与 token 都非空） */
  static isConfigured(): boolean {
    return AppConfig.baseUrl().length > 0 && AppConfig.token().length > 0;
  }
}
