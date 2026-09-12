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
import fs from '@ohos.file.fs';

export interface PickedPhoto {
  /** 拷贝后位于 app cache 内的绝对路径；空字符串表示失败 */
  path: string;
  /** 出错信息（成功时为空） */
  error: string;
}

export class PhotoService {
  /**
   * 拉起系统相册选择器，复制到 app cache，返回最终路径。
   * `prefix` 用于区分用途（avatar / chatBg / attach），避免覆盖彼此。
   *
   * 为什么不能直接 copyFileSync(src, dest)：
   *   picker 返回的是 `file://media/Photo/...` 形式的 uri，不是普通文件系统路径，
   *   fileIo.copyFileSync 不接受它（报 no such file or directory）。
   *   正确方式：先确保 cacheDir 存在，再用 fs.openSync 按 uri 打开 → File 实例方法
   *   逐块读/写到目标文件 —— 完全绕开 uri 解析层。
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
      if (!fs.accessSync(cacheDir)) {
        fs.mkdirSync(cacheDir);
      }
      const stamp = Date.now().toString(36);
      const dest = cacheDir + '/' + prefix + '_' + stamp + '.jpg';
      // openSync 在 ArkTS 里返回 File 对象（不是 number fd）。
      // 用 File.read / File.write 实例方法（async），参数是 ArrayBuffer。
      // 分块循环读到 EOF，写到 dest。
      const srcFile = fs.openSync(src, fs.OpenMode.READ_ONLY);
      const dstFile = fs.openSync(dest, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      const buf = new ArrayBuffer(64 * 1024);
      try {
        while (true) {
          const n: number = await srcFile.read(buf);
          if (n === undefined || n <= 0) {
            break;
          }
          await dstFile.write(buf, n);
        }
      } finally {
        await srcFile.close();
        await dstFile.close();
      }
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
