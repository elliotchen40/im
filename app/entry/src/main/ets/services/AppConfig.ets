/**
 * 本地配置与状态持久化（preferences）。
 *
 * 存三类东西：
 *   1) 服务端地址 + IM_APP_TOKEN —— 首次启动需在设置页填入
 *   2) sync cursor —— 长轮询游标，冷启动恢复后即可补齐离线期间的消息
 *   3) 个人资料 + 聊天背景 —— 显示名、头像路径、背景图路径
 */

import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

const STORE_NAME: string = 'im_config';
const KEY_BASE_URL: string = 'base_url';
const KEY_TOKEN: string = 'app_token';
const KEY_CURSOR: string = 'sync_cursor';
const KEY_DISPLAY_NAME: string = 'display_name';
const KEY_AVATAR_PATH: string = 'avatar_path';
const KEY_CHAT_BG_PATH: string = 'chat_bg_path';

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

  static isConfigured(): boolean {
    return AppConfig.baseUrl().length > 0 && AppConfig.token().length > 0;
  }

  // -------------------- 个人资料 / 聊天背景 --------------------

  /** 显示名（顶栏、设置里能看到；空字符串表示使用 APP_NAME） */
  static displayName(): string {
    return AppConfig.getString(KEY_DISPLAY_NAME, '');
  }

  static setDisplayName(value: string): void {
    AppConfig.setString(KEY_DISPLAY_NAME, value);
  }

  /** 用户头像绝对路径（空字符串表示未设置） */
  static avatarPath(): string {
    return AppConfig.getString(KEY_AVATAR_PATH, '');
  }

  static setAvatarPath(value: string): void {
    AppConfig.setString(KEY_AVATAR_PATH, value);
  }

  /** 聊天背景图绝对路径（空字符串表示纯色背景） */
  static chatBgPath(): string {
    return AppConfig.getString(KEY_CHAT_BG_PATH, '');
  }

  static setChatBgPath(value: string): void {
    AppConfig.setString(KEY_CHAT_BG_PATH, value);
  }
}
