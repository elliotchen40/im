/**
 * Glimmer 聊天页 —— 唯一的页面，包含四块：
 *   1) 顶栏（动态避让状态栏）：左侧 Glimmer 名称（可点击改名 + 改头像）+ 右侧状态/重新配对
 *   2) 消息列表：气泡（用户气泡不显示头像，对方/AI 气泡显示机器人头像）+ 可选背景图
 *   3) 底部输入栏：「+」号 sheet（图片 / 文件）+ 输入框 + 发送
 *   4) 顶栏 / 设置面板：名称、头像、聊天背景图三件套编辑入口
 *
 * 长轮询循环见 pollLoop()：拿到响应就更新 cursor 并立即再发，不 sleep —
 * 服务端在无消息时会挂起至多 IM_LONG_POLL_TIMEOUT_MS，sleep 只会徒增延迟。
 */

import { common } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { AppConfig } from '../services/AppConfig';
import { PhotoService } from '../services/PhotoService';
import { ImClient, SendResp, SyncMsg, SyncResp, HistoryResp, newClientMsgId } from '../services/ImClient';
import { PairPayload, PairResult, pairWithServer, parsePairPayload, scanOnce } from '../services/Pairing';
import { ChatMessage, MessageKind } from '../model/Message';

const APP_DISPLAY_NAME: string = 'Glimmer';
const STATUSBAR_FALLBACK: number = 28; // vp, 兜底值
const ROBOT_INITIAL: string = 'G';     // 机器人头像占位字符

@Entry
@Component
struct Index {
  @State messages: ChatMessage[] = [];
  @State inputText: string = '';
  @State status: string = '';
  @State configured: boolean = false;
  @State cfgBaseUrl: string = '';
  @State cfgToken: string = '';
  @State pairing: boolean = false;
  @State pairMsg: string = '';
  @State statusBarHeight: number = STATUSBAR_FALLBACK;

  // 个人资料 + 聊天背景
  @State displayName: string = APP_DISPLAY_NAME;
  @State avatarPath: string = '';
  @State chatBgPath: string = '';
  @State bgVersion: number = 0; // 切换背景图时 bump 一次强制 @State 重渲染

  // 名称编辑面板
  @State profileDialogOpen: boolean = false;
  @State profileNameDraft: string = '';

  // + 号附件面板
  @State attachSheetOpen: boolean = false;

  // 历史加载状态
  @State loadingHistory: boolean = false;
  @State hasMoreHistory: boolean = true;

  // 收发状态（顶栏显示）
  @State sendState: string = '';
  @State recvState: string = '';

  private client: ImClient | null = null;
  private cursor: string = '';
  private running: boolean = false;
  private scroller: Scroller = new Scroller();
  private oldestId: number = 0; // 当前消息列表里最老的 id（用于下拉分页）

  aboutToAppear(): void {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.status = '初始化失败：拿不到应用上下文';
      return;
    }
    AppConfig.init(ctx);

    // 读历史值（地址/token/profile/背景）
    this.cfgBaseUrl = AppConfig.baseUrl();
    this.cfgToken = AppConfig.token();
    this.configured = AppConfig.isConfigured();
    this.displayName = AppConfig.displayName().length > 0 ? AppConfig.displayName() : APP_DISPLAY_NAME;
    this.avatarPath = AppConfig.avatarPath();
    this.chatBgPath = AppConfig.chatBgPath();

    // 动态拿状态栏高度（任何挖孔/灵动岛/居中摄像头机型都正确避让）
    void this.refreshStatusBarHeight(ctx as common.UIAbilityContext);

    if (this.configured) {
      this.startSession();
    } else {
      this.status = '尚未绑定服务端';
    }
  }

  aboutToDisappear(): void {
    this.running = false;
  }

  // ------------------------------------------------------------ 会话与轮询

  private startSession(): void {
    this.client = new ImClient(AppConfig.baseUrl(), AppConfig.token());
    this.cursor = AppConfig.cursor();
    this.running = true;
    this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    this.status = '连接中…';
    let failures = 0;
    while (this.running) {
      const client: ImClient | null = this.client;
      if (client === null) {
        return;
      }
      try {
        const resp: SyncResp = await client.sync(this.cursor);
        if (resp.cursor !== undefined && resp.cursor.length > 0) {
          this.cursor = resp.cursor;
          AppConfig.setCursor(resp.cursor);
        }
        const list: SyncMsg[] = resp.msgs;
        if (list !== undefined && list.length > 0) {
          for (const m of list) {
            this.onServerMessage(m);
          }
          this.scrollToBottom();
        }
        this.status = '已连接';
        failures = 0;
      } catch (e) {
        failures++;
        this.status = '连接断开，重试中…';
        await this.delay(failures >= 5 ? 30000 : 2000);
        if (failures >= 5) {
          failures = 0;
        }
      }
    }
  }

  private onServerMessage(m: SyncMsg): void {
    this.settleOldestPending();
    this.messages.push(new ChatMessage(m.serverMsgId, m.text, false, m.kind, m.ts));
    this.recvState = '已收到回复';
    // 记录当前最老 id（用于下拉分页）—— 只在首次有消息时初始化
    if (this.oldestId === 0) {
      this.oldestId = m.seq;
    }
  }

  /** 下拉加载更早历史：取 id < oldestId 的消息，插到列表头部 */
  private async loadHistory(): Promise<void> {
    const client: ImClient | null = this.client;
    if (client === null || this.loadingHistory || !this.hasMoreHistory) {
      return;
    }
    this.loadingHistory = true;
    try {
      const resp: HistoryResp = await client.history(this.oldestId === 0 ? undefined : this.oldestId, 30);
      if (resp.ret !== 0) {
        this.toast('历史加载失败');
        return;
      }
      const older: SyncMsg[] = resp.msgs;
      if (older.length === 0) {
        this.hasMoreHistory = false;
        return;
      }
      // 插到头部；避免重复（按 serverMsgId 去重）
      const known = new Set<string>();
      for (const m of this.messages) {
        known.add(m.id);
      }
      const fresh: SyncMsg[] = older.filter((m) => !known.has(m.serverMsgId));
      if (fresh.length === 0) {
        this.hasMoreHistory = false;
        return;
      }
      const head: ChatMessage[] = [];
      for (const m of fresh) {
        head.push(new ChatMessage(m.serverMsgId, m.text, false, m.kind, m.ts));
      }
      this.messages = head.concat(this.messages);
      this.oldestId = fresh[0].seq; // 更新到更早
      // 下拉后停在原地（不跳动）；head 里至少 1 条
      if (this.messages.length > fresh.length) {
        this.scroller.scrollToIndex(fresh.length);
      }
    } catch (e) {
      this.toast('历史加载失败');
    } finally {
      this.loadingHistory = false;
    }
  }

  private settleOldestPending(): void {
    for (let i = 0; i < this.messages.length; i++) {
      const msg: ChatMessage = this.messages[i];
      if (msg.fromMe && msg.pending) {
        msg.pending = false;
        this.messages.splice(i, 1, msg);
        return;
      }
    }
  }

  private markFailed(id: string): void {
    for (let i = 0; i < this.messages.length; i++) {
      const msg: ChatMessage = this.messages[i];
      if (msg.id === id) {
        msg.pending = false;
        msg.failed = true;
        this.messages.splice(i, 1, msg);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- 扫码登录

  private async onScanLogin(): Promise<void> {
    if (this.pairing) {
      return;
    }
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.pairMsg = '拿不到应用上下文，无法扫码';
      return;
    }
    this.pairing = true;
    this.pairMsg = '正在打开扫码…';

    const text: string | null = await scanOnce(ctx as common.UIAbilityContext);
    if (text === null) {
      this.pairing = false;
      this.pairMsg = '已取消扫码';
      return;
    }

    const payload: PairPayload | null = parsePairPayload(text);
    if (payload === null) {
      this.pairing = false;
      this.pairMsg = '这不是 Glimmer 的配对二维码（应形如 im://pair?u=…&c=…）';
      return;
    }

    this.pairMsg = '正在与 ' + payload.publicUrl + ' 配对…';
    const res: PairResult = await pairWithServer(payload.publicUrl, payload.code);
    this.pairing = false;
    this.pairMsg = res.message;

    if (res.ok) {
      this.cfgBaseUrl = AppConfig.baseUrl();
      this.cfgToken = AppConfig.token();
      this.configured = true;
      this.startSession();
      this.toast('已绑定 ' + res.baseUrl);
    }
  }

  // ------------------------------------------------------------------ 发送

  private async onSend(): Promise<void> {
    const text: string = this.inputText.trim();
    if (text.length === 0) {
      return;
    }
    const client: ImClient | null = this.client;
    if (client === null) {
      this.toast('请先绑定服务端');
      return;
    }
    const id: string = newClientMsgId();
    this.inputText = '';
    this.messages.push(new ChatMessage(id, text, true, MessageKind.REPLY, Date.now(), true));
    this.scrollToBottom();
    this.sendState = '发送中…';
    try {
      const resp: SendResp = await client.send(text, id);
      if (resp.ret === 0) {
        // send 回 200 即认为已送达服务端（不是等机器人回复）
        this.markSent(id);
        this.sendState = '';
        this.recvState = '等待回复…';
      } else {
        this.markFailed(id);
        this.sendState = '发送失败';
        this.toast('服务端拒绝：' + (resp.errmsg !== undefined ? resp.errmsg : '未知原因'));
      }
    } catch (e) {
      this.markFailed(id);
      this.sendState = '发送失败';
      this.toast('发送失败，请检查网络');
    }
  }

  /** 标记某条乐观消息为已送达（不再显示「发送中…」） */
  private markSent(id: string): void {
    for (let i = 0; i < this.messages.length; i++) {
      const msg: ChatMessage = this.messages[i];
      if (msg.id === id) {
        msg.pending = false;
        msg.failed = false;
        this.messages.splice(i, 1, msg);
        return;
      }
    }
  }

  private onSaveConfig(): void {
    const base: string = this.cfgBaseUrl.trim();
    const token: string = this.cfgToken.trim();
    if (base.length === 0 || token.length === 0) {
      this.toast('地址与 token 都不能为空');
      return;
    }
    AppConfig.setBaseUrl(base);
    AppConfig.setToken(token);
    this.configured = true;
    this.startSession();
  }

  /** 回到绑定面板（重新配对 / 换服务器） */
  private onRebind(): void {
    this.running = false;
    this.client = null;
    this.pairMsg = '';
    this.configured = false;
    this.status = '尚未绑定服务端';
  }

  // --------------------------------------------------------- 个人资料 / 背景

  private openProfileDialog(): void {
    this.profileNameDraft = this.displayName === APP_DISPLAY_NAME ? '' : this.displayName;
    this.profileDialogOpen = true;
  }

  private async onPickAvatar(): Promise<void> {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.toast('拿不到应用上下文');
      return;
    }
    const r = await PhotoService.pickAndCache(ctx, 'avatar');
    if (r.error.length > 0 && r.path.length === 0) {
      if (r.error !== '用户取消选择') {
        this.toast('选头像失败：' + r.error);
      }
      return;
    }
    const old = this.avatarPath;
    PhotoService.tryDelete(old);
    AppConfig.setAvatarPath(r.path);
    this.avatarPath = r.path;
  }

  private async onPickChatBg(): Promise<void> {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.toast('拿不到应用上下文');
      return;
    }
    const r = await PhotoService.pickAndCache(ctx, 'chatbg');
    if (r.error.length > 0 && r.path.length === 0) {
      if (r.error !== '用户取消选择') {
        this.toast('选背景失败：' + r.error);
      }
      return;
    }
    const old = this.chatBgPath;
    PhotoService.tryDelete(old);
    AppConfig.setChatBgPath(r.path);
    this.chatBgPath = r.path;
    this.bgVersion++;
  }

  private onClearChatBg(): void {
    const old = this.chatBgPath;
    PhotoService.tryDelete(old);
    AppConfig.setChatBgPath('');
    this.chatBgPath = '';
    this.bgVersion++;
  }

  private onSaveProfile(): void {
    const v: string = this.profileNameDraft.trim();
    this.displayName = v.length > 0 ? v : APP_DISPLAY_NAME;
    AppConfig.setDisplayName(this.displayName === APP_DISPLAY_NAME ? '' : this.displayName);
    this.profileDialogOpen = false;
    this.toast('已保存');
  }

  private async onAttachImage(): Promise<void> {
    this.attachSheetOpen = false;
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return;
    }
    const r = await PhotoService.pickAndCache(ctx, 'attach');
    if (r.path.length === 0) {
      if (r.error !== '用户取消选择') {
        this.toast('选图失败：' + r.error);
      }
      return;
    }
    // 本地只把文件名写到输入框（完整图片发送需要服务端配合 base64
    // 入站；本次只占位提示，未来版本对接）
    const fname: string = r.path.split('/').pop() ?? '';
    this.inputText = this.inputText + ' [图片:' + fname + ']';
    this.toast('图片已附加：' + fname);
  }

  private async onAttachFile(): Promise<void> {
    this.attachSheetOpen = false;
    this.toast('文件选择尚未接入（占位）');
  }

  // ------------------------------------------------------------------ 工具

  private scrollToBottom(): void {
    this.scroller.scrollEdge(Edge.Bottom);
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve: (value: void) => void) => {
      setTimeout(() => {
        resolve();
      }, ms);
    });
  }

  /**
   * 读系统状态栏区域高度（避开挖孔 / 灵动岛 / 居中摄像头机型），
   * 异步获取 Window，再用 px2vp 转成 vp 单位。
   */
  private async refreshStatusBarHeight(uiCtx: common.UIAbilityContext): Promise<void> {
    try {
      const win: window.Window = await window.getLastWindow(uiCtx);
      const avoid: window.AvoidArea = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
      const topPx: number = avoid.topRect.height;
      if (topPx > 0) {
        let vp: number = px2vp(topPx);
        if (vp < STATUSBAR_FALLBACK) {
          vp = STATUSBAR_FALLBACK;
        }
        this.statusBarHeight = vp;
      }
    } catch (e) {
      this.statusBarHeight = STATUSBAR_FALLBACK;
    }
  }

  private toast(text: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: text, duration: 2000 });
    } catch (e) {
      console.warn('[Index] 弹提示失败：' + (e as Error).message);
    }
  }

  // ----------------------------------------------------------- 头像视图

  @Builder
  robotAvatar() {
    if (this.avatarPath.length > 0) {
      Image(this.avatarPath)
        .width(36)
        .height(36)
        .borderRadius(18)
        .objectFit(ImageFit.Cover)
    } else {
      // 占位头像：圆角方块 + 首字母
      Column() {
        Text(ROBOT_INITIAL)
          .fontSize(18)
          .fontColor(Color.White)
          .fontWeight(FontWeight.Bold)
      }
      .width(36)
      .height(36)
      .borderRadius(18)
      .backgroundColor('#1AAD19')
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
    }
  }

  // ----------------------------------------------------------- 气泡视图

  @Builder
  messageBubble(m: ChatMessage) {
    Row() {
      if (m.fromMe) {
        Blank()
      } else {
        this.robotAvatar()
        Column().width(8)
      }
      Column() {
        if (m.isProactive()) {
          Text('主动关心')
            .fontSize(10)
            .fontColor($r('app.color.text_secondary'))
            .margin({ bottom: 4 })
        }
        Text(m.text)
          .fontSize(15)
          .fontColor(m.fromMe ? $r('app.color.text_on_me') : $r('app.color.text_primary'))
        if (m.pending) {
          Text('发送中…')
            .fontSize(10)
            .fontColor(m.fromMe ? '#D0F0D0' : $r('app.color.text_secondary'))
            .margin({ top: 4 })
        } else if (m.failed) {
          Text('发送失败')
            .fontSize(10)
            .fontColor(Color.Red)
            .margin({ top: 4 })
        }
      }
      .alignItems(HorizontalAlign.Start)
      .padding(10)
      .borderRadius(12)
      .backgroundColor(m.fromMe ? $r('app.color.bubble_me')
                       : (m.isProactive() ? $r('app.color.bubble_proactive')
                                          : $r('app.color.bubble_other')))
      .constraintSize({ maxWidth: '70%' })
      if (!m.fromMe) {
        Blank()
      }
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 6, bottom: 6 })
  }

  // ----------------------------------------------------------- 视图

  build() {
    Column() {
      if (this.configured) {
        this.chatPanel()
      } else {
        this.setupPanel()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.chatBgPath.length > 0 ? Color.Transparent : $r('app.color.chat_bg'))

    // 个人资料编辑面板 + 附件面板 —— 绑在根 Column 上（确保可点击弹出）
    .bindSheet($$this.profileDialogOpen, this.profileDialogBuilder(), {
      height: 460,
      dragBar: true,
      title: { title: '编辑个人资料' }
    })
    .bindSheet($$this.attachSheetOpen, this.attachSheetBuilder(), {
      height: 240,
      dragBar: true,
      title: { title: '添加附件' }
    })
  }

  // ----------------------------------------------------------- 聊天主面板

  @Builder
  chatPanel() {
    Column() {
      // 顶部空白：动态避让状态栏 + 顶栏
      Row().width('100%').height(this.statusBarHeight).backgroundColor(Color.White)

      // 顶栏
      Row() {
        // 左侧：机器人头像 + 名称（点名称 = 打开编辑面板）
        Row() {
          this.robotAvatar()
          Column().width(8)
          Text(this.displayName)
            .fontSize(18)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
            .onClick(() => {
              this.openProfileDialog();
            })
        }
        .onClick(() => {
          this.openProfileDialog();
        })

        Blank()

        // 右侧：连接状态 + 收发状态 + 重新配对（紧凑展示）
        Column() {
          Text(this.status)
            .fontSize(12)
            .fontColor($r('app.color.text_secondary'))
          Text(this.sendState.length > 0 ? this.sendState : this.recvState)
            .fontSize(10)
            .fontColor($r('app.color.text_secondary'))
            .margin({ top: 2 })
        }
        .alignItems(HorizontalAlign.End)

        Text('重新配对')
          .fontSize(12)
          .fontColor('#1AAD19')
          .margin({ left: 12 })
          .onClick(() => {
            this.onRebind();
          })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 10, bottom: 10 })
      .backgroundColor(Color.White)
      .alignItems(VerticalAlign.Center)

      // 消息区（背景图叠加在 Column 上）
      Stack() {
        // 背景图
        if (this.chatBgPath.length > 0) {
          Image(this.chatBgPath)
            .width('100%')
            .height('100%')
            .objectFit(ImageFit.Cover)
            .opacity(0.85)
        }
        // 半透明遮罩，保证气泡文字可读
        if (this.chatBgPath.length > 0) {
          Column().width('100%').height('100%').backgroundColor('#00000020')
        }

        List({ scroller: this.scroller }) {
          ForEach(this.messages, (m: ChatMessage) => {
            ListItem() {
              this.messageBubble(m)
            }
          }, (m: ChatMessage) => m.id)
        }
        .layoutWeight(1)
        .width('100%')
        .backgroundColor(Color.Transparent)
        .onReachStart(() => {
          // 下拉到最顶 → 加载更早历史
          this.loadHistory();
        })
        .edgeEffect(EdgeEffect.Spring)
      }
      .layoutWeight(1)
      .width('100%')

      // 底部输入栏
      Row() {
        // + 号（弹出 sheet）
        Text('+')
          .fontSize(24)
          .fontWeight(FontWeight.Bold)
          .width(40)
          .height(40)
          .borderRadius(20)
          .backgroundColor('#F2F3F5')
          .textAlign(TextAlign.Center)
          .margin({ right: 8 })
          .onClick(() => {
            this.attachSheetOpen = true;
          })

        TextInput({ text: this.inputText, placeholder: $r('app.string.input_placeholder') })
          .layoutWeight(1)
          .onChange((v: string) => {
            this.inputText = v;
          })
          .onSubmit(() => {
            this.onSend();
          })

        Button($r('app.string.send'))
          .margin({ left: 8 })
          .onClick(() => {
            this.onSend();
          })
      }
      .width('100%')
      .padding(12)
      .backgroundColor(Color.White)
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .height('100%')
  }

  // -------------------------------------------------------- 个人资料 sheet

  @Builder
  profileDialogBuilder() {
    Column() {
      Row() {
        // 当前头像
        this.robotAvatar()
        Column().width(12)
        Column() {
          Text(this.displayName)
            .fontSize(18)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
          Text('点击右侧按钮更换')
            .fontSize(12)
            .fontColor($r('app.color.text_secondary'))
            .margin({ top: 4 })
        }
        .alignItems(HorizontalAlign.Start)
        Blank()
        Button('换头像')
          .height(36)
          .onClick(() => {
            this.onPickAvatar();
          })
      }
      .width('100%')
      .padding({ left: 4, right: 4, top: 8, bottom: 16 })

      Text('显示名')
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
        .margin({ bottom: 6 })
      TextInput({ text: this.profileNameDraft, placeholder: '留空则使用 Glimmer' })
        .width('100%')
        .onChange((v: string) => {
          this.profileNameDraft = v;
        })

      Row().width('100%').height(20)

      Text('聊天背景')
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
        .margin({ bottom: 8 })

      Row() {
        Button('从相册选背景')
          .layoutWeight(1)
          .height(40)
          .onClick(() => {
            this.onPickChatBg();
          })
        Column().width(8)
        Button('清除背景')
          .layoutWeight(1)
          .height(40)
          .backgroundColor('#8A8A8A')
          .onClick(() => {
            this.onClearChatBg();
          })
      }
      .width('100%')

      Blank()

      Row() {
        Button('取消')
          .layoutWeight(1)
          .backgroundColor('#8A8A8A')
          .onClick(() => {
            this.profileDialogOpen = false;
          })
        Column().width(12)
        Button('保存')
          .layoutWeight(1)
          .onClick(() => {
            this.onSaveProfile();
          })
      }
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .padding(20)
    .backgroundColor(Color.White)
  }

  // ---------------------------------------------------------- 附件 sheet

  @Builder
  attachSheetBuilder() {
    Column() {
      Row() {
        Column() {
          Text('🖼')
            .fontSize(28)
            .fontColor('#1AAD19')
          Text('图片')
            .fontSize(12)
            .margin({ top: 6 })
        }
        .layoutWeight(1)
        .height(80)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .backgroundColor('#F2F3F5')
        .borderRadius(8)
        .onClick(() => {
          this.onAttachImage();
        })

        Column().width(12)

        Column() {
          Text('📄')
            .fontSize(28)
            .fontColor('#1AAD19')
          Text('文件')
            .fontSize(12)
            .margin({ top: 6 })
        }
        .layoutWeight(1)
        .height(80)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .backgroundColor('#F2F3F5')
        .borderRadius(8)
        .onClick(() => {
          this.onAttachFile();
        })
      }
      .width('100%')
      .padding(16)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.White)
  }

  // ----------------------------------------------------------- 绑定面板

  @Builder
  setupPanel() {
    Column() {
      // 顶部也避让状态栏，避免绑定面板里按钮顶到摄像头
      Row().width('100%').height(this.statusBarHeight)

      Text('绑定 Glimmer 服务端')
        .fontSize(20)
        .fontWeight(FontWeight.Bold)
        .margin({ bottom: 8 })

      Text('在服务器上运行 npm run pair，终端会出现二维码')
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .textAlign(TextAlign.Center)
        .margin({ bottom: 16 })

      Button(this.pairing ? '扫码中…' : '扫码登录')
        .width('100%')
        .height(44)
        .enabled(!this.pairing)
        .onClick(() => {
          this.onScanLogin();
        })

      if (this.pairMsg.length > 0) {
        Text(this.pairMsg)
          .fontSize(12)
          .fontColor($r('app.color.text_secondary'))
          .textAlign(TextAlign.Center)
          .margin({ top: 10, bottom: 4 })
      }

      Divider()
        .margin({ top: 20, bottom: 16 })

      Text('或手动填写')
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .margin({ bottom: 10 })

      TextInput({ text: this.cfgBaseUrl, placeholder: 'http://10.168.3.180:8081' })
        .type(InputType.Normal)
        .onChange((v: string) => {
          this.cfgBaseUrl = v;
        })
        .margin({ bottom: 10 })

      TextInput({ text: this.cfgToken, placeholder: 'IM_APP_TOKEN' })
        .type(InputType.Password)
        .onChange((v: string) => {
          this.cfgToken = v;
        })
        .margin({ bottom: 14 })

      Button('保存并连接')
        .width('100%')
        .backgroundColor('#8A8A8A')
        .onClick(() => {
          this.onSaveConfig();
        })
    }
    .width('100%')
    .height('100%')
    .padding(24)
    .justifyContent(FlexAlign.Center)
    .backgroundColor(Color.White)
  }
}
