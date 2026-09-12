/**
 * PhotoService —— 把相册里选的图片拷到 app 自己的缓存目录，再返回绝对路径。
 *
 * 设计要点：
 * - picker 拿到的 PhotoAccessHelper URI 在 app 重启后**不一定还能直接打开**，
 *   所以落盘到 `context.cacheDir` 下，Glimmer 重启也能继续显示（头像 / 背景图）。
 * - 同一个文件复用之前 copy 的：用一个固定文件名 `pick_<hash>.jpg`，让用户重复选
 *   同一张图时不会膨胀。
 * - 文件操作都在 try/catch 里，失败返回空字符串（调用方决定怎么降级）。
 */

import { common } from '@kit.AbilityKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { fileIo } from '@kit.CoreFileKit';

export interface PickedPhoto {
  /** 拷贝后位于 app cache 内的绝对路径；空字符串表示失败 */
  path: string;
  /** 出错信息（成功时为空） */
  error: string;
}

export class PhotoService {
  /**
   * 拉起系统相册选择器，复制到 app cache，返回最终路径。
   * `prefix` 用于区分用途（avatar / chatBg），避免头像和背景覆盖彼此。
   */
  static async pickAndCache(context: common.Context, prefix: string): Promise<PickedPhoto> {
    try {
      const opts = new photoAccessHelper.PhotoSelectOptions();
      opts.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
      opts.maxSelectNumber = 1;
      const picker = new photoAccessHelper.PhotoViewPicker();
      const result = await picker.select(opts);
      const uris = result.photoUris;
      if (uris === undefined || uris.length === 0) {
        return { path: '', error: '用户取消选择' };
      }
      const src = uris[0];
      const cacheDir = context.cacheDir;
      const stamp = Date.now().toString(36);
      const dest = cacheDir + '/' + prefix + '_' + stamp + '.jpg';
      fileIo.copyFileSync(src, dest);
      return { path: dest, error: '' };
    } catch (e) {
      return { path: '', error: (e as Error).message };
    }
  }

  /**
   * 删除某个 app cache 里的旧文件（best-effort：失败仅 warning）。
   * 主要用来在替换头像 / 背景时清理上一份。
   */
  static tryDelete(path: string): void {
    if (path.length === 0) {
      return;
    }
    try {
      fileIo.unlinkSync(path);
    } catch (e) {
      // 旧文件可能已经被清理，忽略
      console.warn('[PhotoService] 删除失败：' + (e as Error).message);
    }
  }
}
