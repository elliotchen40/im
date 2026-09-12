/**
 * P29: 主动关怀静默规则（guard）
 *
 * 规则清单：
 *   1. 静默窗口 02:00-06:00 wall-clock（用户睡觉时间）
 *   2. 24h 频控：每天最多主动 1 条
 *   3. 7-day dedup：同 event_signature 7 天内不重复
 *   4. 拒收计数：累计 ≥3 次拒收 → 永久禁主动
 *   5. 恢复主动通知关键词 → 重置拒收计数
 */

import type { MemoryDB } from "../memory/db.js";

const QUIET_HOUR_START = 2; // 02:00
const QUIET_HOUR_END = 6; // 06:00 (exclusive)
const DAILY_LIMIT_MS = 24 * 60 * 60 * 1000;
const DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const REJECTION_THRESHOLD = 3;

export interface CareGuard {
  isQuietHours(): boolean;
  isWithinDailyLimit(userId: number): boolean;
  isDuplicateEvent(userId: number, signature: string): boolean;
  getRejectionCount(userId: number): number;
  incrementRejection(userId: number): number;
  resetRejections(userId: number): void;
  isPermanentlyDisabled(userId: number): boolean;
  shouldPermanentlyDisable(userId: number): boolean; // 拒收累计到阈值 → 自动永久禁
}

export function createCareGuard(db: MemoryDB): CareGuard {
  return {
    isQuietHours() {
      const h = new Date().getHours();
      return h >= QUIET_HOUR_START && h < QUIET_HOUR_END;
    },

    isWithinDailyLimit(userId) {
      const sinceMs = Date.now() - DAILY_LIMIT_MS;
      return db.countCareLogInWindow(userId, sinceMs) > 0;
    },

    isDuplicateEvent(userId, signature) {
      const sinceMs = Date.now() - DEDUP_WINDOW_MS;
      return db.countDuplicateSignature(userId, signature, sinceMs) > 0;
    },

    getRejectionCount(userId) {
      return db.getRejectionCount(userId);
    },

    incrementRejection(userId) {
      const newCount = db.incrementRejection(userId);
      if (newCount >= REJECTION_THRESHOLD) {
        db.setPermanentlyDisabled(userId, true);
      }
      return newCount;
    },

    resetRejections(userId) {
      db.resetRejection(userId);
      db.setPermanentlyDisabled(userId, false);
    },

    isPermanentlyDisabled(userId) {
      return db.isPermanentlyDisabled(userId);
    },

    shouldPermanentlyDisable(userId) {
      return this.getRejectionCount(userId) >= REJECTION_THRESHOLD;
    },
  };
}

/** 计算 event_signature 用于 7 天 dedup（hash of eventType + summary） */
export function hashSignature(eventType: string, eventSummary: string): string {
  // 简单 hash（不要求密码学强度，仅用于 dedup 匹配）
  const s = `${eventType}:${eventSummary}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return `${eventType}:${h.toString(36)}`;
}
