/**
 * PhotoService —— 拉起相册选择器，返回图片的 file:// uri；读字节 → base64。
 *
 * 职责：
 *   - pick()：拉起系统相册，返回 uri（头像 / 背景 / 附件通用）。
 *   - readBase64()：把 picker 给的 uri 读成 base64 字节，用于 /im/send 的 images
 *     （协议 §3.2：images[].dataBase64，≤8MiB）。
 *
 * 读 uri 的官方路径（photoAccessHelper.getReadOnlyFd 已废弃，@useinstead
 * @ohos.file.fs:fileIo.open）：
 *   fs.openSync(uri, READ_ONLY) → File（.fd 是 number）→ fs.readSync(fd, buf) 循环
 *   → fs.closeSync(fd) → util.Base64Helper.encodeToStringSync(Uint8Array)。
 */

import { common } from '@kit.AbilityKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

export interface PickedPhoto {
  /** picker 返回的图片 uri（file://media/Photo/...），可直接传给 Image；空串表示取消 */
  uri: string;
  /** 出错信息（成功时为空） */
  error: string;
}

/** 读出的图片字节 + mime */
export interface PickedImageData {
  /** base64 编码的图片字节（可直接放进 /im/send 的 images[].dataBase64） */
  dataBase64: string;
  /** mime 类型，如 image/jpeg */
  mime: string;
  /** 出错信息（成功时为空） */
  error: string;
}

export class PhotoService {
  /**
   * 拉起系统相册选择器，返回所选图片的 uri。
   * `prefix` 仅用于日志区分（avatar / chatBg / attach），不再影响路径生成。
   */
  static async pick(context: common.Context, prefix: string): Promise<PickedPhoto> {
    try {
      const opts = new photoAccessHelper.PhotoSelectOptions();
      opts.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
      opts.maxSelectNumber = 1;
      const picker = new photoAccessHelper.PhotoViewPicker();
      const result = await picker.select(opts);
      const uris = result.photoUris;
      if (uris === undefined || uris.length === 0) {
        return { uri: '', error: '用户取消选择' };
      }
      console.info('[PhotoService] selected ' + prefix + ': ' + uris[0]);
      return { uri: uris[0], error: '' };
    } catch (e) {
      return { uri: '', error: (e as Error).message };
    }
  }

  /**
   * 把 picker 给的 uri 读成 base64 字节（用于 /im/send 的 images）。
   *
   * 官方推荐（@ohos.file.photoAccessHelper 里 getReadOnlyFd 已废弃，@useinstead
   * @ohos.file.fs:fileIo.open）：
   *   1. fs.openSync(uri, READ_ONLY) → File 对象（File.fd 是 number fd）
   *   2. fs.readSync(fd, buf) 循环读到 EOF（返回 <=0 结束）
   *   3. fs.closeSync(fd)
   * 然后用 util.Base64Helper.encodeToStringSync 把 Uint8Array 编码成 base64。
   */
  static async readBase64(uri: string): Promise<PickedImageData> {
    const empty: PickedImageData = { dataBase64: '', mime: 'image/jpeg', error: '' };
    if (uri.length === 0) {
      return { ...empty, error: 'uri 为空' };
    }
    try {
      const file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      const fd: number = file.fd;
      const chunks: ArrayBuffer[] = [];
      const buf = new ArrayBuffer(64 * 1024);
      let total = 0;
      try {
        while (true) {
          const n: number = fs.readSync(fd, buf);
          if (n <= 0) {
            break;
          }
          // 只取前 n 字节（buf 是复用 buffer）
          const piece = buf.slice(0, n);
          chunks.push(piece);
          total += n;
        }
      } finally {
        fs.closeSync(fd);
      }
      // 合并成一个大 ArrayBuffer
      const merged = new ArrayBuffer(total);
      const mergedView = new Uint8Array(merged);
      let off = 0;
      for (let i = 0; i < chunks.length; i++) {
        const pieceView = new Uint8Array(chunks[i]);
        mergedView.set(pieceView, off);
        off += pieceView.length;
      }
      // base64 编码
      const b64: string = util.Base64Helper.encodeToStringSync(mergedView);
      console.info('[PhotoService] readBase64 OK, size=' + total + 'B, b64len=' + b64.length);
      return { dataBase64: b64, mime: 'image/jpeg', error: '' };
    } catch (e) {
      console.warn('[PhotoService] readBase64 失败：' + (e as Error).message);
      return { ...empty, error: (e as Error).message };
    }
  }

  /** noop 保留：旧调用方可能仍传入 cache 路径，删除幂等返回成功 */
  static tryDelete(path: string): void {
    // 之前是删 cache 文件；现在不拷贝、无文件，保留接口但 noop
    void path;
  }
}
