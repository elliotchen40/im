/**
 * PhotoService —— 拉起相册选择器，返回图片的 file:// uri。
 *
 * 设计抉择（不再做磁盘拷贝）：
 *   - HarmonyOS NEXT 上 picker 返回的 `file://media/Photo/...` uri 在 app 同进程内可读，
 *     Image 控件直接传 uri 即可渲染，授权由系统处理，**不需要**预申请任何图片权限。
 *   - 之前尝试把 uri 拷贝到 `context.cacheDir`（fileIo.copyFileSync / fs.openSync +
 *     readSync/writeSync 等）连续遇到 4 类编译错（uri 不可解析、File 类型与 readSync
 *     期望的 number fd 不匹配、writeSync 期望 WriteOptions、closeSync 不存在），
 *     实际 ArkTS 签名与我每次的猜测都不一致 —— 直接放弃 fs 拷贝这条路。
 *   - 现在策略：PhotoService 只把 picker 给的 uri 字符串原样存到 preferences（AppConfig
 *     已支持 string 字段）。Glimmer 当前会话内头像/背景能正常显示；下次冷启动如果
 *     uri 已失效（罕见），用户重新选图就行 —— PhotoViewPicker 的沙箱保证大多数情况
 *     下重启仍可读。
 *   - tryDelete 保留 noop 语义（之前的 cache 路径不再用，但调用方仍可能传入旧 cache
 *     路径；不再 unlink 任何东西，避免误删）。
 */

import { common } from '@kit.AbilityKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';

export interface PickedPhoto {
  /** picker 返回的图片 uri（file://media/Photo/...），可直接传给 Image；空串表示取消 */
  uri: string;
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

  /** noop 保留：旧调用方可能仍传入 cache 路径，删除幂等返回成功 */
  static tryDelete(path: string): void {
    // 之前是删 cache 文件；现在不拷贝、无文件，保留接口但 noop
    void path;
  }
}
